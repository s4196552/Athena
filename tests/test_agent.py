"""The inspection agent, end to end.

Parsing tells you what is *in* a file. This tests the layer that decides what
the file *is* -- and the three things built on top of it: multi-axis filtering,
tagging by hand, and summarising a selection.

Four assertions here are the ones worth writing down, because each is a claim
the feature makes that a plausible implementation would quietly break:

* **Classification is checked against real documents**, not against strings
  handed straight to the classifier. A DOCX goes through `python-docx`, the
  text extractor, the agent, the writer and the query layer before anything is
  asserted -- because every one of those has been a source of a bug already.
* **Filters compose as OR-within-an-axis, AND-across-axes.** Get this wrong
  and adding a second filter widens the result set, which is the single most
  confusing thing a faceted UI can do.
* **A model is asked only when the rules were unsure.** That is the entire
  cost argument for the escalation design, and it is invisible in the output
  -- the tags look the same either way -- so only a call count can prove it.
* **Totals in a brief are arithmetic, and per asset.** A folder holding the
  same invoice three times must report one invoice, not three, and must not
  treble the money.

And, as everywhere in this codebase, the census: classifying, tagging and
summarising a library leaves every file in it byte-for-byte identical.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import struct
import zlib
from pathlib import Path

import pytest

import athena.extractors.ai as ai_module
from athena.agent import patterns as pat
from athena.agent.brief import Item, compile_brief, digest
from athena.agent.inspect import Evidence, inspect
from athena.ai.base import Analysis
from athena.config import AppPaths
from athena.core.facets import Task
from athena.core.scanner import Scanner
from athena.core.worker import process_task
from athena.db.connection import SCHEMA_PATH, connect_ro, connect_rw
from athena.db.writer import Writer
from athena.web import queries

docx = pytest.importorskip("docx", reason="python-docx builds the fixtures")


# ---------------------------------------------------------------------------
#  Fixtures: a small office library with real files in it
# ---------------------------------------------------------------------------

INVOICE = """ACME CONSULTING LTD
Invoice No: INV-{n}
Bill To: Northwind Trading Ltd
Invoice Date: 2024-0{m}-15

Consulting services | 10 | $120.00 | $1,200.00
Travel expenses | 1 | $340.00 | $340.00
Software licences | 4 | $95.00 | $380.00

Subtotal $1,920.00
VAT 20% $384.00
Total Due $2,304.00

Payment terms: Net 30. Remit to Acme Consulting Ltd.
Prepared by: {author}
"""

CONTRACT = """MASTER SERVICES AGREEMENT

Entered into on 12 January 2023 between Northwind Trading Ltd (hereinafter
"the Client") and Acme Consulting Ltd (hereinafter "the Supplier").

1.1 Definitions
1.2 Term and Termination
2.1 Governing law shall be the law of England and Wales.
2.2 Limitation of liability: the Supplier shall be deemed liable only as set
    out herein.
2.3 The Supplier shall indemnify the Client against any third party claim.

In witness whereof the parties agree.
"""

CV = """CURRICULUM VITAE

Priya Raman
priya.raman@example.com

PROFESSIONAL EXPERIENCE
Senior Engineer, Northwind Trading Ltd, 2019 - 2024
Engineer, Acme Consulting Ltd, 2016 - 2019

EDUCATION
BSc Computer Science, graduated 2016

SKILLS
Python, SQL, Kubernetes, architecture, refactor

References available on request.
"""

NOTES = """Weekly Engineering Standup - Minutes of the meeting

Attendees: Priya Raman, Tom Fletcher
Apologies for absence: Michael Chen

Discussion
 - The deploy pipeline is failing on the release branch.
 - Latency on the api endpoint is up 40%.

Action items
 Owner: Priya Raman | Fix the deploy pipeline | due 2024-05-20

Decisions made: roll back the container image.
"""

SECRETS = """# deployment notes -- do not commit

Staging is behind the same load balancer as production, so remember to drain
connections before rolling the image or the health check will flap for about a
minute and page whoever is on call.

export DATABASE_URL=postgres://admin:hunter2@10.0.0.4:5432/prod
api_key = sk-abcdefghijklmnopqrstuvwxyz012345
AWS access: AKIAIOSFODNN7EXAMPLE

Rotate these before the handover. Ask Priya if the vault is still refusing to
issue short-lived tokens for the staging account.
"""

LOG_LINE = "2024-05-1{i} 09:2{i}:14 ERROR worker failed: connection refused 10.0.0.{i}"


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


def _docx(path: Path, author: str, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = docx.Document()
    document.core_properties.author = author
    for line in body.splitlines():
        document.add_paragraph(line)
    document.save(str(path))


def make_office(root: Path) -> Path:
    for n, author, month in (("4471", "Jane Doe", 3), ("4472", "Jane Doe", 4),
                             ("4473", "Sarah Patel", 5)):
        _docx(root / "Finance" / f"Invoice {n}.docx", author,
              INVOICE.format(n=n, m=month, author=author))

    _docx(root / "Legal" / "MSA Northwind.docx", "Michael Chen", CONTRACT)
    _docx(root / "People" / "Priya Raman CV.docx", "Priya Raman", CV)
    _docx(root / "Notes" / "standup.docx", "Tom Fletcher", NOTES)

    logs = root / "Engineering"
    logs.mkdir(parents=True, exist_ok=True)
    (logs / "worker.log").write_text(
        "\n".join(LOG_LINE.format(i=i % 9) for i in range(14)), encoding="utf-8")
    (logs / "deploy notes.txt").write_text(SECRETS, encoding="utf-8")

    pics = root / "Pictures"
    pics.mkdir(parents=True, exist_ok=True)
    for i in range(3):
        (pics / f"IMG_{2840 + i}.png").write_bytes(_png(i))
    return root


def census(root: Path) -> dict[str, tuple[int, int, str]]:
    snap: dict[str, tuple[int, int, str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        snap[f"<dir>{os.path.relpath(dirpath, root)}"] = (
            0, 0, ",".join(sorted(dirnames)))
        for name in sorted(filenames):
            f = Path(dirpath) / name
            st = f.stat()
            snap[os.path.relpath(f, root)] = (
                st.st_size, st.st_mtime_ns, hashlib.sha256(f.read_bytes()).hexdigest())
    return snap


def _root_id(cur, path: str) -> int:
    cur.execute("INSERT INTO root (path) VALUES (?) ON CONFLICT(path) DO NOTHING",
                (path,))
    return int(cur.execute("SELECT id FROM root WHERE path = ?", (path,)).fetchone()[0])


def index(paths: AppPaths, library: Path, *, stages=("identify", "extract")) -> int:
    """Run the pipeline inline, the way the supervisor would."""
    writer = Writer(str(paths.db), batch_size=50, max_latency=0.05).start()
    try:
        root_id = writer.call(lambda cur: _root_id(cur, str(library)))
        Scanner(writer).scan_root(root_id, str(library))
        writer.flush()
        for stage in stages:
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
                    # The hints the ML tier escalates on. Dropping these here
                    # is what would make `agent.classify` fall back to
                    # re-deriving a verdict, and the escalation test below
                    # would then pass for the wrong reason.
                    hints=row.get("hints") or {},
                    cache_dir=str(paths.thumbs),
                ), paths.thumbs)
                if stage == "extract" and result.ok and "ml" in stages:
                    result.needs_ml = True
                writer.apply_result(result)
            writer.flush()
    finally:
        writer.close()
    return root_id


@pytest.fixture
def office(tmp_path):
    library = make_office(tmp_path / "office")
    paths = AppPaths(tmp_path / "home").ensure()
    index(paths, library)
    return library, paths


def findings(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    return {
        r["name"]: r
        for r in conn.execute(
            "SELECT f.name, af.* FROM file f "
            "JOIN agent_finding af ON af.asset_id = f.asset_id"
        )
    }


# ---------------------------------------------------------------------------
#  What the agent concludes
# ---------------------------------------------------------------------------


def test_the_agent_classifies_real_documents(office):
    library, paths = office
    conn = connect_ro(paths.db)
    try:
        found = findings(conn)
        assert len(found) == 11, sorted(found)

        assert found["Invoice 4471.docx"]["doctype"] == "invoice"
        assert found["Invoice 4471.docx"]["topic"] == "finance"
        assert found["MSA Northwind.docx"]["doctype"] == "contract"
        assert found["MSA Northwind.docx"]["topic"] == "legal"
        assert found["Priya Raman CV.docx"]["doctype"] == "resume"
        assert found["standup.docx"]["doctype"] == "meeting-notes"
        assert found["worker.log"]["doctype"] == "log"
        assert found["worker.log"]["topic"] == "engineering"
        # A photograph with no text still gets a kind, from its media type.
        assert found["IMG_2840.png"]["doctype"] == "photo"

        # Authorship comes from the container's own properties when it has
        # them, and the row records *where* it came from so the UI can say so.
        assert found["Invoice 4471.docx"]["author"] == "Jane Doe"
        assert found["Invoice 4471.docx"]["author_source"] == "metadata"

        # Every verdict carries its workings.
        assert "invoice" in found["Invoice 4471.docx"]["reasoning"].lower()
        assert found["Invoice 4471.docx"]["decided_by"] == "rules"
        assert found["Invoice 4471.docx"]["escalated"] == 0
    finally:
        conn.close()


def test_classification_survives_the_whole_pipeline_as_tags(office):
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        by_kind: dict[str, set[str]] = {}
        for row in conn.execute("SELECT kind, name FROM v_tag_facet"):
            by_kind.setdefault(row["kind"], set()).add(row["name"])

        assert {"invoice", "contract", "resume", "log", "photo"} <= by_kind["doctype"]
        assert {"finance", "legal", "engineering"} <= by_kind["topic"]
        assert {"jane doe", "sarah patel", "michael chen"} <= by_kind["author"]
        assert "2024" in by_kind["date"]

        # Display names are the vocabulary's, not a title-cased slug: the rail
        # must not show "Hr" or "Cv / Resume".
        labels = dict(conn.execute(
            "SELECT name, display_name FROM tag WHERE kind IN ('doctype','topic')"))
        assert labels["resume"] == "CV / Resume"
        assert labels["meeting-notes"] == "Meeting notes"
    finally:
        conn.close()


def test_structural_patterns_become_filters(office):
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        # The demo's party trick: a plain text file nobody labelled, found by
        # the shape of what is inside it.
        rows = queries.library(conn, {"pattern": ["credentials"]})
        assert [i["name"] for i in rows["items"]] == ["deploy notes.txt"]

        money = queries.library(conn, {"pattern": ["money"]})
        assert {i["name"] for i in money["items"]} == {
            "Invoice 4471.docx", "Invoice 4472.docx", "Invoice 4473.docx"}

        logs = queries.library(conn, {"pattern": ["log-line"]})
        assert [i["name"] for i in logs["items"]] == ["worker.log"]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
#  How filters compose
# ---------------------------------------------------------------------------


def test_filters_and_across_axes_or_within_one(office):
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        def total(**filters):
            return queries.library(
                conn, {k: v if isinstance(v, list) else [v]
                       for k, v in filters.items()})["total"]

        assert total(topic="finance") == 3
        assert total(author="jane doe") == 2
        assert total(doctype="invoice") == 3

        # Across axes: narrower. This is the headline query -- "the finance
        # invoices from Jane Doe".
        assert total(topic="finance", author="jane doe") == 2
        assert total(topic="finance", doctype="invoice", author="jane doe") == 2
        assert total(topic="finance", author="michael chen") == 0

        # Within an axis: wider.
        assert total(topic=["finance", "legal"]) == 4
        assert total(author=["jane doe", "sarah patel"]) == 3

        # Both at once.
        assert total(topic=["finance", "legal"], author=["michael chen"]) == 1
    finally:
        conn.close()


def test_filter_labels_read_like_english(office):
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        label = queries.filter_label(
            {"topic": ["finance"], "doctype": ["invoice"], "author": ["jane doe"]},
            conn)
        assert label == "Finance, Invoice, by Jane Doe"
    finally:
        conn.close()


def test_canonical_query_ignores_paging(office):
    """Two requests for the same selection must hash to the same brief.

    Without this, scrolling to page three and asking for a summary would be a
    different question from asking on page one -- and with a paid provider,
    a second charge for the same answer.
    """
    a = queries.canonical_query({"topic": ["finance"], "cursor": ["0"]})
    b = queries.canonical_query({"topic": ["finance"], "cursor": ["480"]})
    c = queries.canonical_query({"topic": ["finance"], "author": ["jane doe"]})
    assert a == b
    assert a != c


# ---------------------------------------------------------------------------
#  Tags a person types
# ---------------------------------------------------------------------------


def test_custom_tags_attach_to_content_not_to_paths(tmp_path):
    """Tagging one copy tags every copy, including ones found later.

    This falls out of the identity model rather than being implemented: tags
    hang off the asset, and an asset is a hash of the bytes. It is worth a
    test because it is the behaviour a user will assume and would never think
    to check.
    """
    library = tmp_path / "lib"
    (library / "a").mkdir(parents=True)
    (library / "b").mkdir(parents=True)
    _docx(library / "a" / "Invoice 4471.docx", "Jane Doe",
          INVOICE.format(n="4471", m=3, author="Jane Doe"))
    # Byte-identical copy in another folder.
    (library / "b" / "copy of invoice.docx").write_bytes(
        (library / "a" / "Invoice 4471.docx").read_bytes())

    paths = AppPaths(tmp_path / "home").ensure()
    index(paths, library)

    writer = Writer(str(paths.db)).start()
    try:
        conn = connect_ro(paths.db)
        asset_ids = [r[0] for r in conn.execute(
            "SELECT DISTINCT asset_id FROM file WHERE name = 'Invoice 4471.docx'")]
        assert len(asset_ids) == 1

        writer.set_tag(asset_ids, "custom", "Q1 review")
        writer.flush()

        both = queries.library(conn, {"custom": ["q1 review"]})
        assert {i["name"] for i in both["items"]} == {
            "Invoice 4471.docx", "copy of invoice.docx"}

        # A user tag is stored as such, so the UI can tell it apart from a
        # guess and let a person overrule the agent.
        sources = {r[0] for r in conn.execute(
            "SELECT source FROM asset_tag at JOIN tag t ON t.id = at.tag_id "
            "WHERE t.kind = 'custom'")}
        assert sources == {"user"}

        writer.unset_tag(asset_ids, "custom", "Q1 review")
        writer.flush()
        assert queries.library(conn, {"custom": ["q1 review"]})["total"] == 0
        # The vocabulary is pruned too, so the rail stops offering a dead chip.
        assert conn.execute(
            "SELECT COUNT(*) FROM tag WHERE kind = 'custom'").fetchone()[0] == 0
        conn.close()
    finally:
        writer.close()


def test_user_tags_do_not_displace_agent_tags(office):
    """A person and the agent can both say "finance" without one erasing the
    other -- `asset_tag`'s key includes the source."""
    _, paths = office
    writer = Writer(str(paths.db)).start()
    try:
        conn = connect_ro(paths.db)
        asset_id = conn.execute(
            "SELECT asset_id FROM file WHERE name = 'Invoice 4471.docx'"
        ).fetchone()[0]
        writer.set_tag([asset_id], "topic", "legal")
        writer.flush()

        rows = conn.execute(
            "SELECT t.name, at.source FROM asset_tag at JOIN tag t ON t.id = at.tag_id "
            "WHERE at.asset_id = ? AND t.kind = 'topic'", (asset_id,)).fetchall()
        names = {r["name"] for r in rows}
        assert "finance" in names and "legal" in names
        assert "user" in {r["source"] for r in rows}

        # Removing a user tag leaves the agent's alone.
        writer.unset_tag([asset_id], "topic", "finance")
        writer.flush()
        still = {r[0] for r in conn.execute(
            "SELECT t.name FROM asset_tag at JOIN tag t ON t.id = at.tag_id "
            "WHERE at.asset_id = ? AND t.kind = 'topic'", (asset_id,))}
        assert "finance" in still
        conn.close()
    finally:
        writer.close()


# ---------------------------------------------------------------------------
#  Briefs
# ---------------------------------------------------------------------------


def test_brief_totals_are_arithmetic_and_per_asset(office):
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        rows = queries.selection_items(conn, {"topic": ["finance"]})
        items = [Item.from_row(r) for r in rows]
        assert len(items) == 3

        d = digest(items)
        # Each invoice's largest figure is its total, 2,304. Summing every
        # figure on the page instead would give roughly three times this.
        assert d.money["USD"]["documents"] == 3
        assert d.money["USD"]["total"] == pytest.approx(3 * 2304.0)
        assert d.money["USD"]["largest"] == pytest.approx(2304.0)
        assert dict(d.authors)["Jane Doe"] == 2
        assert dict(d.doctypes)["invoice"] == 3

        title, body = compile_brief(items, "Finance")
        assert "3 invoices" in title
        assert "6,912.00" in body
        assert "Jane Doe" in body
    finally:
        conn.close()


def test_brief_counts_duplicate_content_once(tmp_path):
    """Three copies of one invoice is one invoice and one total."""
    library = tmp_path / "lib"
    library.mkdir()
    _docx(library / "invoice.docx", "Jane Doe",
          INVOICE.format(n="4471", m=3, author="Jane Doe"))
    original = (library / "invoice.docx").read_bytes()
    for name in ("invoice (1).docx", "invoice - copy.docx"):
        (library / name).write_bytes(original)

    paths = AppPaths(tmp_path / "home").ensure()
    index(paths, library)

    conn = connect_ro(paths.db)
    try:
        assert queries.library(conn, {})["total"] == 3          # three paths
        items = [Item.from_row(r) for r in queries.selection_items(conn, {})]
        assert len(items) == 1                                   # one asset
        assert digest(items).money["USD"]["total"] == pytest.approx(2304.0)
    finally:
        conn.close()


def test_brief_flags_things_worth_noticing(office):
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        items = [Item.from_row(r) for r in queries.selection_items(conn, {})]
        flags = digest(items).flags
        assert any("API keys" in f for f in flags), flags
    finally:
        conn.close()


# ---------------------------------------------------------------------------
#  The graph
# ---------------------------------------------------------------------------


def test_graph_is_a_tag_graph_over_the_selection(office):
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        g = queries.graph(conn, {})
        kinds = {n["kind"] for n in g["nodes"]}
        assert {"topic", "doctype", "author"} <= kinds
        assert g["files"] == 11

        names = {(n["kind"], n["name"]): n for n in g["nodes"]}
        assert names[("topic", "finance")]["n"] == 3

        # Edges are co-occurrences, so Finance and Invoice must be joined.
        ids = {n["tid"]: (n["kind"], n["name"]) for n in g["nodes"]}
        pairs = {
            frozenset((ids[e["source"]], ids[e["target"]]))
            for e in g["edges"]
        }
        assert frozenset({("topic", "finance"), ("doctype", "invoice")}) in pairs

        # Filtering the graph filters the graph.
        legal = queries.graph(conn, {"topic": ["legal"]})
        assert legal["files"] == 1
        assert ("doctype", "contract") in {
            (n["kind"], n["name"]) for n in legal["nodes"]}
        assert ("topic", "finance") not in {
            (n["kind"], n["name"]) for n in legal["nodes"]}
    finally:
        conn.close()


def test_graph_caps_each_kind_so_the_picture_stays_mixed(office):
    """Years are the least informative nodes there are -- every file has one,
    so a year touches everything and the layout collapses into a wheel. The
    per-kind cap is what stops whichever axis has the most values from filling
    the whole budget."""
    _, paths = office
    conn = connect_ro(paths.db)
    try:
        g = queries.graph(conn, {})
        per_kind: dict[str, int] = {}
        for node in g["nodes"]:
            per_kind[node["kind"]] = per_kind.get(node["kind"], 0) + 1
        assert max(per_kind.values()) <= queries.MAX_PER_KIND
        assert len(g["nodes"]) <= queries.MAX_NODES
        # Topics are first in the priority order, so they are never crowded out.
        assert g["nodes"][0]["kind"] == "topic"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
#  Escalation: the cost argument
# ---------------------------------------------------------------------------


class CountingProvider:
    """Answers like a language model and counts how often it was asked."""

    name = "stub"
    model = "stub-v1"

    def __init__(self) -> None:
        self.calls: list[str] = []

    @property
    def classifications(self) -> list[str]:
        """Calls made by `agent.classify`, as opposed to `ai.document`.

        Both are ML-tier extractors and both go through `analyse_text`, so a
        bare call count conflates them. `ai.document` summarises every document
        it is given and is meant to; the escalation is the one that is supposed
        to be rare, and the prompt is what tells them apart.
        """
        return [c for c in self.calls if c.startswith("Classify this file")]

    def available(self) -> str | None:
        return None

    def analyse_image(self, jpeg: bytes, prompt: str = "") -> Analysis:
        return Analysis(description="a picture", provider=self.name, model=self.model)

    def analyse_text(self, text: str, prompt: str = "") -> Analysis:
        self.calls.append(prompt)
        return Analysis(
            description="an internal note about deployment credentials",
            objects=["Acme Consulting Ltd"],
            scene="manual",
            topics=["security"],
            provider=self.name,
            model=self.model,
        )


@pytest.fixture
def counting(monkeypatch):
    provider = CountingProvider()
    monkeypatch.setattr(ai_module, "_provider", provider)
    monkeypatch.setattr(ai_module, "_availability", None)
    monkeypatch.setattr(ai_module, "_budget_used", 0)
    monkeypatch.setenv("ATHENA_AI_PROVIDER", "stub")
    monkeypatch.setenv("ATHENA_AI_MAX_FILES", "100")
    return provider


def test_a_model_is_asked_only_about_files_the_rules_could_not_settle(
    tmp_path, counting
):
    """The whole cost argument, as a call count.

    An invoice with `Invoice No:` and `Total Due` on it needs no language
    model; a plain text file of deployment notes does. Escalating everything
    would produce the same tags and a bill proportional to the library.
    """
    library = tmp_path / "lib"
    library.mkdir()
    _docx(library / "Invoice 4471.docx", "Jane Doe",
          INVOICE.format(n="4471", m=3, author="Jane Doe"))
    _docx(library / "MSA Northwind.docx", "Michael Chen", CONTRACT)
    (library / "deploy notes.txt").write_text(SECRETS, encoding="utf-8")
    (library / "misc.txt").write_text(
        "Some general remarks about the thing we discussed, and the other "
        "matter which remains outstanding until somebody picks it up again. "
        "There is not a great deal more to say about it at this stage.\n" * 3,
        encoding="utf-8")

    paths = AppPaths(tmp_path / "home").ensure()
    index(paths, library, stages=("identify", "extract", "ml"))

    conn = connect_ro(paths.db)
    try:
        escalated = {
            r["name"] for r in conn.execute(
                "SELECT f.name FROM file f JOIN agent_finding af "
                "ON af.asset_id = f.asset_id WHERE af.escalated = 1")
        }
        # The two the rules had no confident answer for, and only those.
        assert escalated == {"deploy notes.txt", "misc.txt"}, escalated
        assert len(counting.classifications) == len(escalated)
        # The invoice and the contract were settled by pattern matching, so no
        # classification call was ever made for them -- which is the whole
        # cost argument, and is invisible in the resulting tags.
        assert len(counting.classifications) < len(counting.calls)

        # The rules' verdict on the invoice is untouched by the model tier.
        row = conn.execute(
            "SELECT af.* FROM file f JOIN agent_finding af ON af.asset_id = f.asset_id "
            "WHERE f.name = 'Invoice 4471.docx'").fetchone()
        assert row["doctype"] == "invoice"
        assert row["decided_by"] == "rules"

        # And the escalated file gained the model's opinion, resolved onto the
        # closed vocabulary rather than taken as free text.
        note = conn.execute(
            "SELECT af.* FROM file f JOIN agent_finding af ON af.asset_id = f.asset_id "
            "WHERE f.name = 'deploy notes.txt'").fetchone()
        assert note["topic"] == "security"
        assert note["decided_by"] == "stub:stub-v1"
        assert note["escalated"] == 1
    finally:
        conn.close()


def test_escalation_is_skipped_entirely_when_no_provider_is_configured(
    tmp_path, monkeypatch
):
    """A lean install degrades to fewer facets, never to red rows."""
    monkeypatch.setattr(ai_module, "_provider", None)
    monkeypatch.setattr(ai_module, "_availability", "unchecked")
    monkeypatch.delenv("ATHENA_AI_PROVIDER", raising=False)

    library = tmp_path / "lib"
    library.mkdir()
    (library / "misc.txt").write_text("Nothing much here at all.\n" * 20,
                                      encoding="utf-8")
    paths = AppPaths(tmp_path / "home").ensure()
    index(paths, library, stages=("identify", "extract", "ml"))

    conn = connect_ro(paths.db)
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM file WHERE state = 'error'").fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM file WHERE state = 'indexed'").fetchone()[0] == 1
        status = conn.execute(
            "SELECT status FROM extractor_run WHERE extractor = 'agent.classify'"
        ).fetchone()
        assert status is None or status[0] in ("unsupported", "skipped")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
#  The promise
# ---------------------------------------------------------------------------


def test_classifying_and_tagging_a_library_touches_no_files(tmp_path):
    library = make_office(tmp_path / "office")
    before = census(library)

    paths = AppPaths(tmp_path / "home").ensure()
    index(paths, library)

    writer = Writer(str(paths.db)).start()
    try:
        conn = connect_ro(paths.db)
        asset_ids = [r[0] for r in conn.execute(
            "SELECT id FROM asset")]
        writer.set_tag(asset_ids, "custom", "reviewed")
        writer.flush()
        items = [Item.from_row(r) for r in queries.selection_items(conn, {})]
        compile_brief(items, "everything")
        queries.graph(conn, {})
        conn.close()
    finally:
        writer.close()

    after = census(library)
    assert set(after) == set(before), "the library's shape changed"
    for rel, expected in before.items():
        assert after[rel] == expected, f"{rel} was altered"


# ---------------------------------------------------------------------------
#  The schema change this feature needed
# ---------------------------------------------------------------------------


def test_an_existing_catalogue_migrates_to_the_wider_tag_kinds(tmp_path):
    """`tag.kind` gained five values, and a CHECK constraint cannot be altered
    in place. An existing catalogue therefore has to be rebuilt -- and must
    come through it with every row, every foreign key and every cascade
    intact."""
    old_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    start = old_sql.index("  kind         TEXT NOT NULL CHECK (kind IN (")
    end = old_sql.index("))", start) + 3
    v1_sql = old_sql[:start] + (
        "  kind         TEXT NOT NULL CHECK (kind IN (\n"
        "                 'object', 'scene', 'place', 'keyword', 'topic', 'entity',\n"
        "                 'genre', 'camera', 'language', 'user', 'system')),"
    ) + old_sql[end:]

    db = tmp_path / "v1.sqlite3"
    old = sqlite3.connect(db, isolation_level=None)
    old.executescript(v1_sql)
    old.execute("PRAGMA user_version = 1")
    old.execute("INSERT INTO asset (id, content_hash, size_bytes, media_type) "
                "VALUES (1, 'abc', 10, 'document')")
    old.execute("INSERT INTO tag (id, kind, name, display_name) "
                "VALUES (7, 'keyword', 'budget', 'Budget')")
    old.execute("INSERT INTO asset_tag (asset_id, tag_id, source) VALUES (1, 7, 't')")
    old.execute("INSERT INTO detection (asset_id, tag_id, source, confidence) "
                "VALUES (1, 7, 't', 0.5)")
    with pytest.raises(sqlite3.IntegrityError):
        old.execute("INSERT INTO tag (kind, name) VALUES ('doctype', 'invoice')")
    old.commit()
    old.close()

    conn = connect_rw(db)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
        kept = conn.execute("SELECT kind, name, display_name FROM tag").fetchone()
        assert tuple(kept) == ("keyword", "budget", "Budget")
        assert conn.execute("SELECT COUNT(*) FROM asset_tag").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM detection").fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []

        for kind in ("doctype", "author", "date", "pattern", "custom"):
            conn.execute("INSERT INTO tag (kind, name) VALUES (?, 'x')", (kind,))

        # The cascade has to survive the table rebuild, or forgetting a
        # library would start leaving orphaned rows behind.
        conn.execute("DELETE FROM tag WHERE id = 7")
        assert conn.execute("SELECT COUNT(*) FROM asset_tag").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM detection").fetchone()[0] == 0
    finally:
        conn.close()

    # Re-opening an already-migrated catalogue is a no-op.
    conn = connect_rw(db)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    finally:
        conn.close()


# ---------------------------------------------------------------------------
#  Unit-level checks on the parts that are easy to get subtly wrong
# ---------------------------------------------------------------------------


def test_shape_beats_vocabulary():
    """An email *about* invoices is not an invoice.

    Word counting cannot tell these apart; the structural patterns can, which
    is the reason both layers exist.
    """
    real = inspect(Evidence(
        filename="scan.pdf", ext="pdf", media_type="document",
        text=INVOICE.format(n="4471", m=3, author="Jane Doe")))
    talking = inspect(Evidence(
        filename="email.txt", ext="txt", media_type="document",
        text="Hi Tom,\n\nCould you chase the invoice for last month? The client "
             "says the invoice never arrived and their accounts team need the "
             "invoice before they can pay anything.\n\nThanks,\nJane\n"))

    assert real.doctype == "invoice"
    assert talking.doctype != "invoice"


def test_a_company_is_never_recorded_as_an_author():
    """"executed by Acme Holdings Ltd" is not a byline. A company filed as a
    person pollutes the one facet everybody filters by."""
    verdict = inspect(Evidence(
        filename="msa.docx", ext="docx", media_type="document", text=CONTRACT))
    assert verdict.author is None
    assert "Acme Consulting Ltd" in verdict.entities


def test_tool_names_never_reach_the_author_facet():
    """`doc_meta.author` is whatever the toolchain put there.

    On a library of 1,515 generated files the author facet came back as
    "python-docx (4)" and "(anonymous) (6)" -- both arriving through exactly
    the field a real name arrives through. A facet full of library names is a
    facet nobody can use, so placeholders and tool names are filtered out
    rather than merely deprioritised.
    """
    from athena.agent.inspect import _looks_like_a_person as person

    for junk in ("python-docx", "(anonymous)", "(unspecified)", "Microsoft Word",
                 "ReportLab PDF Library - (opensource)", "unknown", "N/A",
                 "openpyxl", "TBD", "  "):
        assert person(junk) is None, junk

    for real in ("Jane Doe", "O'Brien", "Jean-Luc Picard", "Sarah"):
        assert person(real) == real
    # An address in an author field is a person, written oddly.
    assert person("priya.raman@example.com") == "Priya Raman"


def test_a_stale_template_date_loses_to_the_documents_own_text():
    """Office files inherit their template's `created` property, so a deck
    written today routinely claims to be from 2013."""
    stale = 1359158400          # 2013-01-26
    verdict = inspect(Evidence(
        filename="invoice.docx", ext="docx", media_type="document",
        text=INVOICE.format(n="4471", m=3, author="Jane Doe"),
        meta={"doc_created_at": stale}))
    assert verdict.event_source == "text"
    assert verdict.event_at is not None
    assert 2024 in verdict.years

    # But when the text says nothing, the embedded date is all there is.
    quiet = inspect(Evidence(
        filename="notes.docx", ext="docx", media_type="document",
        text="A few remarks with no dates in them whatsoever.",
        meta={"doc_created_at": stale}))
    assert quiet.event_source == "document properties"


def test_phone_numbers_are_not_found_inside_account_numbers():
    """The lookarounds in the phone pattern earn their keep here: three runs of
    digits is also what an IBAN looks like."""
    iban = "Remit to GB33 BUKB 2020 1555 5555 55 before the due date."
    assert not [h for h in pat.detect(iban, "x.txt") if h.name == "phone-number"]
    real = "Call +44 20 7946 0958 or (555) 123-4567."
    assert [h.count for h in pat.detect(real, "x.txt") if h.name == "phone-number"] == [2]


def test_the_agent_declines_rather_than_guessing():
    """A file with nothing distinctive gets no topic, and `unsure` is true so
    a model can be asked if one is configured. A confidently wrong label is
    worse than an absent one: it files something where nobody will look."""
    verdict = inspect(Evidence(
        filename="notes.txt", ext="txt", media_type="document",
        text="ok\nsure\nmaybe later\n"))
    assert verdict.topic is None
    assert verdict.unsure is True
