"""The AI tier, end to end, against a stub provider.

The point of a stub is to test *our* plumbing rather than a vendor's uptime:
that an `Analysis` becomes tags, becomes searchable text, and is recorded in
the ledger so it is never paid for twice. Swapping in Ollama or an API key
changes only where the `Analysis` comes from.

The most important assertion here is the last one. An AI caption is written
into the same FTS5 index as document text, so "dog beach" finds a photograph
nobody ever labelled -- semantic-feeling search with no embeddings, no vector
store and no second query path.
"""

from __future__ import annotations

import os
import zlib
import struct
from pathlib import Path

import pytest

import athena.extractors.ai as ai_module
from athena.ai.base import Analysis
from athena.config import AppPaths
from athena.core.facets import Task
from athena.core.scanner import Scanner
from athena.core.worker import process_task
from athena.db.connection import connect_ro
from athena.db.writer import Writer


class StubProvider:
    """Stands in for Ollama or a cloud API. Records what it was asked."""

    name = "stub"
    model = "stub-v1"

    def __init__(self) -> None:
        self.images = 0
        self.documents = 0
        self.image_bytes: list[int] = []

    def available(self) -> str | None:
        return None

    def analyse_image(self, jpeg: bytes, prompt: str = "") -> Analysis:
        self.images += 1
        self.image_bytes.append(len(jpeg))
        return Analysis(
            description="a golden retriever running on a beach at sunset",
            objects=["dog", "beach", "sea"],
            scene="beach",
            topics=["holiday"],
            text="LIFEGUARD ON DUTY",
            provider=self.name,
            model=self.model,
        )

    def analyse_text(self, text: str, prompt: str = "") -> Analysis:
        self.documents += 1
        return Analysis(
            description="a quarterly revenue report for the board",
            objects=[],
            scene="",
            topics=["finance", "revenue"],
            text="",
            provider=self.name,
            model=self.model,
        )


def _png(w: int = 64, h: int = 48) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + b"\x20\x90\xd0" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


@pytest.fixture
def stub(monkeypatch):
    provider = StubProvider()
    # The extractors probe once per process and cache; seed that cache.
    monkeypatch.setattr(ai_module, "_provider", provider)
    monkeypatch.setattr(ai_module, "_availability", None)
    monkeypatch.setattr(ai_module, "_budget_used", 0)
    monkeypatch.setenv("ATHENA_AI_PROVIDER", "stub")
    monkeypatch.setenv("ATHENA_AI_MAX_FILES", "100")
    return provider


def run_pipeline(library: Path, home: Path) -> AppPaths:
    paths = AppPaths(home).ensure()
    writer = Writer(str(paths.db), batch_size=50, max_latency=0.05).start()
    try:
        root_id = writer.call(lambda cur: _root(cur, str(library)))
        Scanner(writer).scan_root(root_id, str(library))
        writer.flush()
        for stage in ("identify", "extract", "ml"):
            for row in writer.claim(stage, "test", 500):
                result = process_task(Task(
                    file_id=row["id"],
                    path=os.path.join(row["root_path"], row["rel_path"]),
                    stage=stage,
                    size_bytes=row["size_bytes"] or 0,
                    asset_id=row["asset_id"],
                    content_hash=row.get("content_hash"),
                    mime=row.get("mime"),
                    media_type=row.get("media_type"),
                    completed=row.get("completed") or {},
                    text=row.get("text") or "",
                    cache_dir=str(paths.thumbs),
                ), paths.thumbs)
                # What Supervisor._collect_loop does: only it knows an ML pool
                # exists, so only it can say a file still owes a stage 3.
                # Without this the file is marked complete after extract and
                # the ML stage has nothing left to claim.
                if stage == "extract" and result.ok:
                    result.needs_ml = True
                writer.apply_result(result)
            writer.flush()
    finally:
        writer.close()
    return paths


def _root(cur, path: str) -> int:
    cur.execute("INSERT INTO root (path) VALUES (?) ON CONFLICT(path) DO NOTHING", (path,))
    return int(cur.execute("SELECT id FROM root WHERE path = ?", (path,)).fetchone()[0])


def test_ai_tags_and_captions_reach_the_catalogue(tmp_path, stub):
    library = tmp_path / "lib"
    library.mkdir()
    (library / "holiday.png").write_bytes(_png())

    paths = run_pipeline(library, tmp_path / "home")
    conn = connect_ro(paths.db)
    try:
        tags = {r["name"]: r["kind"] for r in conn.execute(
            "SELECT t.name, t.kind FROM asset_tag at JOIN tag t ON t.id = at.tag_id"
        )}
        assert tags.get("dog") == "object"
        assert tags.get("beach") in ("object", "scene")
        # The stub returned the topic "holiday". `topic` is a closed axis --
        # a filter group in the rail and a node kind in the graph -- so the
        # label is resolved onto the agent's vocabulary (British "holiday"
        # means travel) instead of becoming a bucket of its own. A label with
        # no home in the vocabulary is kept as a `keyword`: still searchable,
        # just not pretending to be a facet.
        assert tags.get("travel") == "topic"
        assert "holiday" not in tags

        sources = {r["source"]: r["body"] for r in conn.execute(
            "SELECT source, body FROM text_block"
        )}
        assert "golden retriever" in sources["ai_caption"]
        # Text the model read is kept apart from the caption it invented.
        assert sources["ai_ocr"] == "LIFEGUARD ON DUTY"

        # The payoff: natural-language search with no embeddings involved.
        hits = conn.execute(
            "SELECT f.name FROM text_fts JOIN text_block tb ON tb.id = text_fts.rowid "
            "JOIN file f ON f.asset_id = tb.asset_id WHERE text_fts MATCH ?",
            ('"retriever" AND "beach"',),
        ).fetchall()
        assert [h["name"] for h in hits] == ["holiday.png"]

        # And the UI's search box finds it by a tag the caption never used --
        # the model labelled it "dog", the caption said "golden retriever".
        from athena.web.server import library as ui_library

        assert "golden retriever" not in "dog"
        assert ui_library(conn, {"q": ["dog"]})["total"] == 1
        assert ui_library(conn, {"q": ["retriever"]})["total"] == 1
        assert ui_library(conn, {"q": ["submarine"]})["total"] == 0
    finally:
        conn.close()

    assert stub.images == 1
    # Downscaled and re-encoded before it ever leaves: a 64x48 PNG becomes a
    # small JPEG, and a 24MP photo would too.
    assert 0 < stub.image_bytes[0] < 200_000


def test_identical_images_are_analysed_once(tmp_path, stub):
    """Content-keyed work: three copies, one call. This is the cost story."""
    library = tmp_path / "lib"
    (library / "a").mkdir(parents=True)
    (library / "b").mkdir(parents=True)
    same = _png()
    (library / "one.png").write_bytes(same)
    (library / "a" / "two.png").write_bytes(same)
    (library / "b" / "three.png").write_bytes(same)

    paths = run_pipeline(library, tmp_path / "home")
    conn = connect_ro(paths.db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM file").fetchone()[0] == 3
        assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == 1
    finally:
        conn.close()
    assert stub.images == 1, "duplicate content must not be re-analysed"


def test_budget_caps_spend(tmp_path, stub, monkeypatch):
    """A hard ceiling, so a big library cannot quietly run up a bill."""
    monkeypatch.setenv("ATHENA_AI_MAX_FILES", "2")
    library = tmp_path / "lib"
    library.mkdir()
    for i in range(5):
        (library / f"p{i}.png").write_bytes(_png(16 + i, 16))

    paths = run_pipeline(library, tmp_path / "home")
    assert stub.images == 2, "budget was not enforced"

    conn = connect_ro(paths.db)
    try:
        # Over-budget files are `skipped`, not `error`: they stay eligible for
        # a later run rather than being written off as broken.
        skipped = conn.execute(
            "SELECT COUNT(*) FROM extractor_run WHERE extractor='ai.vision' "
            "AND status='skipped'"
        ).fetchone()[0]
        assert skipped == 3
        assert conn.execute(
            "SELECT COUNT(*) FROM file WHERE state='error'"
        ).fetchone()[0] == 0
    finally:
        conn.close()


def test_ai_off_by_default_is_skipped_not_error(tmp_path, monkeypatch):
    monkeypatch.delenv("ATHENA_AI_PROVIDER", raising=False)
    monkeypatch.setattr(ai_module, "_provider", None)
    monkeypatch.setattr(ai_module, "_availability", "unchecked")

    library = tmp_path / "lib"
    library.mkdir()
    (library / "x.png").write_bytes(_png())

    paths = run_pipeline(library, tmp_path / "home")
    conn = connect_ro(paths.db)
    try:
        row = conn.execute(
            "SELECT status, error_msg FROM extractor_run WHERE extractor='ai.vision'"
        ).fetchone()
        assert row["status"] == "skipped"
        assert "ATHENA_AI_PROVIDER" in (row["error_msg"] or "")
        assert conn.execute(
            "SELECT COUNT(*) FROM file WHERE state='indexed'"
        ).fetchone()[0] == 1
    finally:
        conn.close()
