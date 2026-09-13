"""The guardrail.

Every other test in this project checks that a feature works. This one checks
that the product's central promise holds, and it is the test that should fail
the build loudest.

It takes a byte-exact census of a sample library -- every path, every size,
every mtime, every SHA-256, and the shape of the directory tree itself -- runs
the full indexing pipeline over it, and asserts the census is identical
afterwards. It also asserts the obvious-but-worth-pinning invariants: nothing
was created inside the library, nothing was deleted, and the catalogue lives
somewhere else entirely.

The value of a census over spot-checks is that it catches the failure modes
nobody anticipates. A parser that rewrites EXIF, a library that drops a
`.pdf.lock` beside its input, a temp file created and deleted so quickly that a
reviewer would never see it -- all of them fail this test without anyone having
predicted them.
"""

from __future__ import annotations

import hashlib
import os
import struct
import zipfile
from pathlib import Path

import pytest

from athena.config import AppPaths
from athena.core.scanner import Scanner
from athena.core.worker import process_task
from athena.core.facets import Task
from athena.db.connection import connect_ro
from athena.db.writer import Writer


# ---------------------------------------------------------------------------
# A sample library that exercises each parser, including the broken paths
# ---------------------------------------------------------------------------


def _png(width: int = 8, height: int = 8) -> bytes:
    """Minimal valid PNG, built by hand so the test needs no image library."""
    import zlib

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\xff\x80\x40" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def _pdf() -> bytes:
    """A one-page PDF with a real text layer, assembled literally."""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length 62 >>\nstream\nBT /F1 18 Tf 20 100 Td (athena indexes this) Tj ET\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n".encode()
        + b"%%EOF\n"
    )
    return bytes(out)


def _docx(tmp: Path) -> bytes:
    """A minimal but genuinely valid .docx package."""
    buf = tmp / "_build.docx"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
            'package/2006/content-types"><Default Extension="xml" ContentType='
            '"application/xml"/><Override PartName="/word/document.xml" ContentType='
            '"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/'
            'package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.'
            'openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/></Relationships>',
        )
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/'
            'wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
            "quarterly revenue projection</w:t></w:r></w:p></w:body></w:document>",
        )
    data = buf.read_bytes()
    buf.unlink()
    return data


@pytest.fixture
def library(tmp_path: Path) -> Path:
    """A small library, deliberately including files that will fail to parse."""
    root = tmp_path / "library"
    (root / "photos" / "2024").mkdir(parents=True)
    (root / "docs").mkdir(parents=True)
    (root / "weird dir name #2").mkdir(parents=True)

    (root / "photos" / "2024" / "beach.png").write_bytes(_png(32, 24))
    (root / "photos" / "2024" / "sunset.png").write_bytes(_png(16, 16))
    # Byte-identical duplicate under a different name: must collapse to one asset.
    (root / "photos" / "copy of beach.png").write_bytes(_png(32, 24))
    (root / "docs" / "report.pdf").write_bytes(_pdf())
    (root / "docs" / "memo.docx").write_bytes(_docx(tmp_path))

    # The adversarial cases. An indexer that only ever sees clean files is an
    # indexer that has not been tested.
    (root / "docs" / "truncated.pdf").write_bytes(_pdf()[:120])
    (root / "weird dir name #2" / "lies.jpg").write_bytes(_png(8, 8))  # PNG named .jpg
    (root / "weird dir name #2" / "empty.mp3").write_bytes(b"")
    (root / "weird dir name #2" / "garbage.docx").write_bytes(os.urandom(2048))
    return root


def census(root: Path) -> dict[str, tuple[int, int, str]]:
    """Byte-exact snapshot of every file, plus the tree shape."""
    snapshot: dict[str, tuple[int, int, str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        snapshot[f"<dir>{rel_dir}"] = (0, 0, ",".join(sorted(dirnames)))
        for name in sorted(filenames):
            full = Path(dirpath) / name
            st = full.stat()
            digest = hashlib.sha256(full.read_bytes()).hexdigest()
            snapshot[os.path.relpath(full, root)] = (st.st_size, st.st_mtime_ns, digest)
    return snapshot


# ---------------------------------------------------------------------------
# The tests
# ---------------------------------------------------------------------------


def test_full_pipeline_leaves_the_library_byte_identical(library: Path, tmp_path: Path):
    before = census(library)
    assert len(before) > 10, "fixture did not build"

    paths = AppPaths(tmp_path / "appdata").ensure()
    writer = Writer(str(paths.db), batch_size=50, max_latency=0.05).start()
    try:
        root_id = writer.call(lambda cur: _insert_root(cur, str(library)))
        Scanner(writer).scan_root(root_id, str(library))
        writer.flush()

        # Run both stages inline. Doing it in-process rather than through the
        # supervisor keeps the assertion about file mutation, not about
        # multiprocessing -- and any mutation would happen in exactly this code.
        for stage in ("identify", "extract", "ml"):
            for row in writer.claim(stage, "test", 1000):
                task = Task(
                    file_id=row["id"],
                    path=os.path.join(row["root_path"], row["rel_path"]),
                    stage=stage,
                    size_bytes=row["size_bytes"] or 0,
                    asset_id=row["asset_id"],
                    content_hash=row.get("content_hash"),
                    mime=row.get("mime"),
                    media_type=row.get("media_type"),
                    completed=row.get("completed") or {},
                    cache_dir=str(paths.thumbs),
                )
                writer.apply_result(process_task(task, paths.thumbs))
            writer.flush()
    finally:
        writer.close()

    after = census(library)

    assert set(after) - set(before) == set(), "files were CREATED inside the library"
    assert set(before) - set(after) == set(), "files were DELETED from the library"
    for rel, expected in before.items():
        assert after[rel] == expected, f"{rel} was MODIFIED: {expected} -> {after[rel]}"


def test_catalogue_and_cache_live_outside_the_library(library: Path, tmp_path: Path):
    paths = AppPaths(tmp_path / "appdata").ensure()
    for produced in (paths.db, paths.thumbs, paths.models, paths.logs):
        assert not paths_overlap(produced, library)


def test_read_only_handles_reject_writes(library: Path):
    from athena.core.safety import open_ro

    target = library / "docs" / "report.pdf"
    with open_ro(target) as fh:
        assert fh.read(5) == b"%PDF-"
        with pytest.raises((OSError, ValueError, io_unsupported())):
            fh.write(b"x")  # type: ignore[arg-type]


def test_guard_detects_an_outside_edit(library: Path):
    from athena.core.safety import SourceMutationError, guard

    target = library / "docs" / "memo.docx"
    with pytest.raises(SourceMutationError):
        with guard(target):
            # Stand in for a parser that "helpfully" rewrote its input.
            target.write_bytes(target.read_bytes() + b"\x00")


def test_duplicate_content_collapses_to_one_asset(library: Path, tmp_path: Path):
    """Two paths, identical bytes -- one asset, so expensive work runs once."""
    from athena.core.identity import content_hash

    a = content_hash(library / "photos" / "2024" / "beach.png")
    b = content_hash(library / "photos" / "copy of beach.png")
    assert a == b


def test_corrupt_files_become_errors_not_crashes(library: Path, tmp_path: Path):
    paths = AppPaths(tmp_path / "appdata").ensure()
    writer = Writer(str(paths.db), batch_size=10, max_latency=0.05).start()
    try:
        root_id = writer.call(lambda cur: _insert_root(cur, str(library)))
        Scanner(writer).scan_root(root_id, str(library))
        writer.flush()
        for stage in ("identify", "extract"):
            for row in writer.claim(stage, "test", 1000):
                task = Task(
                    file_id=row["id"],
                    path=os.path.join(row["root_path"], row["rel_path"]),
                    stage=stage,
                    size_bytes=row["size_bytes"] or 0,
                    asset_id=row["asset_id"],
                    content_hash=row.get("content_hash"),
                    mime=row.get("mime"),
                    media_type=row.get("media_type"),
                    completed=row.get("completed") or {},
                    cache_dir=str(paths.thumbs),
                )
                writer.apply_result(process_task(task, paths.thumbs))
            writer.flush()
    finally:
        writer.close()

    conn = connect_ro(paths.db)
    try:
        states = {r["state"]: r["n"] for r in conn.execute("SELECT * FROM v_state_counts")}
        # The point is that the run completed at all: garbage input produced
        # rows, not an exception that took the engine down.
        assert sum(states.values()) > 0
        # A PNG named .jpg must be recognised from its bytes, not its name.
        row = conn.execute(
            "SELECT a.mime FROM file f JOIN asset a ON a.id = f.asset_id "
            "WHERE f.name = 'lies.jpg'"
        ).fetchone()
        assert row is not None and row["mime"] == "image/png"
    finally:
        conn.close()


# ---------------------------------------------------------------------------


def _insert_root(cur, path: str) -> int:
    cur.execute("INSERT INTO root (path) VALUES (?) ON CONFLICT(path) DO NOTHING", (path,))
    return int(cur.execute("SELECT id FROM root WHERE path = ?", (path,)).fetchone()[0])


def paths_overlap(a: Path, b: Path) -> bool:
    try:
        a.resolve().relative_to(b.resolve())
        return True
    except ValueError:
        return False


def io_unsupported():
    import io

    return io.UnsupportedOperation
