"""Removing a library must remove rows, never files.

This is the highest-stakes operation in the product. Everywhere else, a bug
costs a wrong thumbnail; here a bug costs someone their photographs. So the
tests assert the destructive half really is destructive (rows, tags,
thumbnails all gone) *and* that the library on disk is byte-for-byte untouched
afterwards -- the same census used by `test_never_mutates.py`.

The second-order cases are the ones worth writing down, because they are where
a plausible implementation quietly does the wrong thing:

* content shared with another library must keep its metadata;
* forgetting must not leave orphaned thumbnails filling the cache forever;
* `--keep-metadata` must make re-adding genuinely free, not merely fast.
"""

from __future__ import annotations

import hashlib
import os
import struct
import zlib
from pathlib import Path

from athena.config import AppPaths
from athena.core.facets import Task
from athena.core.library import forget_library, list_libraries
from athena.core.scanner import Scanner
from athena.core.worker import process_task
from athena.db.connection import connect_ro
from athena.db.writer import Writer


def _png(seed: int = 0, w: int = 32, h: int = 24) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    px = bytes([(seed * 37) % 256, (seed * 91) % 256, (seed * 53) % 256])
    raw = b"".join(b"\x00" + px * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def census(root: Path) -> dict[str, tuple[int, int, str]]:
    snap: dict[str, tuple[int, int, str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        snap[f"<dir>{os.path.relpath(dirpath, root)}"] = (0, 0, ",".join(sorted(dirnames)))
        for name in sorted(filenames):
            f = Path(dirpath) / name
            st = f.stat()
            snap[os.path.relpath(f, root)] = (
                st.st_size, st.st_mtime_ns, hashlib.sha256(f.read_bytes()).hexdigest()
            )
    return snap


def index(paths: AppPaths, library: Path) -> int:
    writer = Writer(str(paths.db), batch_size=50, max_latency=0.05).start()
    try:
        root_id = writer.call(lambda cur: _root(cur, str(library)))
        Scanner(writer).scan_root(root_id, str(library))
        writer.flush()
        for stage in ("identify", "extract"):
            for row in writer.claim(stage, "test", 500):
                writer.apply_result(process_task(Task(
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
                ), paths.thumbs))
            writer.flush()
    finally:
        writer.close()
    return root_id


def _root(cur, path: str) -> int:
    cur.execute("INSERT INTO root (path) VALUES (?) ON CONFLICT(path) DO NOTHING", (path,))
    return int(cur.execute("SELECT id FROM root WHERE path = ?", (path,)).fetchone()[0])


def make_library(root: Path, seeds=range(5)) -> Path:
    (root / "sub").mkdir(parents=True, exist_ok=True)
    for i in seeds:
        (root / ("sub" if i % 2 else ".") / f"img{i}.png").write_bytes(_png(i))
    return root


# ---------------------------------------------------------------------------


def test_forget_removes_rows_and_leaves_every_file_untouched(tmp_path):
    library = make_library(tmp_path / "lib")
    paths = AppPaths(tmp_path / "home").ensure()
    root_id = index(paths, library)

    before = census(library)
    thumbs_before = list(paths.thumbs.rglob("*.webp"))
    assert len(thumbs_before) == 5, "fixture did not produce thumbnails"

    writer = Writer(str(paths.db)).start()
    try:
        result = forget_library(writer, paths, root_id)
    finally:
        writer.close()

    assert result is not None
    assert result.files_removed == 5
    assert result.assets_removed == 5
    assert result.thumbnails_removed == 5

    # The whole point.
    after = census(library)
    assert set(after) == set(before), "the library's shape changed"
    for rel, expected in before.items():
        assert after[rel] == expected, f"{rel} was altered by a catalogue removal"
    assert len(list(library.rglob("*.png"))) == 5

    conn = connect_ro(paths.db)
    try:
        for table in ("root", "file", "asset", "color", "thumbnail", "image_meta"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table
        # FTS5 and the R*Tree are maintained by trigger; a cascade that missed
        # them would leave orphaned rows that surface as phantom search hits.
        assert conn.execute("SELECT COUNT(*) FROM text_fts").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM geo_rtree").fetchone()[0] == 0
    finally:
        conn.close()

    assert list(paths.thumbs.rglob("*.webp")) == [], "thumbnail cache was not purged"


def test_content_shared_with_another_library_survives(tmp_path):
    """Two libraries, one identical photo. Forgetting one must not strip it."""
    shared = _png(1)
    lib_a = tmp_path / "a"
    lib_b = tmp_path / "b"
    make_library(lib_a, seeds=[1, 2])
    make_library(lib_b, seeds=[1, 9])          # img1 is byte-identical in both

    paths = AppPaths(tmp_path / "home").ensure()
    root_a = index(paths, lib_a)
    index(paths, lib_b)

    conn = connect_ro(paths.db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == 3  # 4 files, 1 dupe
    finally:
        conn.close()

    writer = Writer(str(paths.db)).start()
    try:
        result = forget_library(writer, paths, root_a)
    finally:
        writer.close()

    # img1's asset is still referenced from library B, so only img2's goes.
    assert result.assets_removed == 1

    conn = connect_ro(paths.db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM root").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == 2
        surviving = {r["name"] for r in conn.execute("SELECT name FROM file")}
        assert surviving == {"img1.png", "img9.png"}
    finally:
        conn.close()

    # And both libraries are still fully present on disk.
    assert len(list(lib_a.rglob("*.png"))) == 2
    assert len(list(lib_b.rglob("*.png"))) == 2


def test_keep_metadata_makes_readding_free(tmp_path):
    library = make_library(tmp_path / "lib")
    paths = AppPaths(tmp_path / "home").ensure()
    root_id = index(paths, library)

    writer = Writer(str(paths.db)).start()
    try:
        result = forget_library(writer, paths, root_id, forget_metadata=False)
    finally:
        writer.close()

    assert result.kept_metadata
    assert result.assets_removed == 0
    assert result.thumbnails_removed == 0

    conn = connect_ro(paths.db)
    try:
        # Orphaned but retained: invisible to the UI, which joins through file.
        assert conn.execute("SELECT COUNT(*) FROM file").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == 5
        assert conn.execute("SELECT COUNT(*) FROM v_library").fetchone()[0] == 0
    finally:
        conn.close()

    # Re-adding rebinds by content hash: the extractor ledger is intact, so
    # nothing is parsed a second time.
    index(paths, library)
    conn = connect_ro(paths.db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == 5
        assert conn.execute(
            "SELECT COUNT(*) FROM file WHERE state = 'indexed'"
        ).fetchone()[0] == 5
        assert conn.execute(
            "SELECT COUNT(*) FROM extractor_run WHERE extractor = 'image.color'"
        ).fetchone()[0] == 5
    finally:
        conn.close()


def test_listing_reports_offline_libraries(tmp_path):
    library = make_library(tmp_path / "lib")
    paths = AppPaths(tmp_path / "home").ensure()
    index(paths, library)

    conn = connect_ro(paths.db)
    try:
        assert list_libraries(conn)[0].exists is True
    finally:
        conn.close()

    # An unplugged drive should read as offline, not as an invitation to purge.
    library.rename(tmp_path / "moved-away")
    conn = connect_ro(paths.db)
    try:
        lib = list_libraries(conn)[0]
        assert lib.exists is False
        assert lib.indexed == 5
    finally:
        conn.close()


def test_forget_is_idempotent_and_unknown_id_is_safe(tmp_path):
    library = make_library(tmp_path / "lib", seeds=[3])
    paths = AppPaths(tmp_path / "home").ensure()
    root_id = index(paths, library)

    writer = Writer(str(paths.db)).start()
    try:
        assert forget_library(writer, paths, root_id) is not None
        assert forget_library(writer, paths, root_id) is None      # already gone
        assert forget_library(writer, paths, 999_999) is None      # never existed
    finally:
        writer.close()

    assert len(list(library.rglob("*.png"))) == 1
