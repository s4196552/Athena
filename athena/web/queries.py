"""Read-side queries. Everything the UI asks the catalogue.

Split out of `server.py` so the HTTP layer stays about HTTP. Every function
here takes a read-only connection and returns plain data.

The important idea in this file is how filters compose. The rail offers
several axes at once -- type, colour, doctype, topic, author, date, pattern,
custom tag, size, library -- and the query a person actually wants is

    (Finance OR Legal) AND (Jane Doe) AND (Invoice)

which is to say: **OR within an axis, AND across axes**. That is what selecting
two chips in one group and one in another means to everybody who has ever used
a shopping site, and it is the only combination rule that makes adding a filter
feel like narrowing rather than a lottery.

Each axis compiles to its own `asset_id IN (...)` subquery rather than a join.
With joins, three tag filters multiply rows and the result count becomes a lie
that `DISTINCT` then has to launder; with subqueries the planner intersects
index scans, the count is honest, and a fourth filter costs one more index
probe.
"""

from __future__ import annotations

import re
import sqlite3
from urllib.parse import urlencode

PAGE_SIZE = 120

#: Tag kinds the rail exposes as their own filter group, in display order.
#: Order is deliberate: what it is, what it is about, who made it, when, then
#: the agent's structural findings, then whatever the user invented.
TAG_AXES: tuple[tuple[str, str], ...] = (
    ("doctype", "Kind"),
    ("topic", "Topic"),
    ("author", "Author"),
    ("date", "Year"),
    ("pattern", "Contains"),
    ("entity", "Named"),
    ("custom", "My tags"),
    ("keyword", "Keywords"),
)

TAG_KINDS = frozenset(kind for kind, _ in TAG_AXES)

#: Size bands. Computed at query time from `size_bytes` rather than stored as
#: tags -- a derived value with a stable definition does not need a row, and
#: keeping it out of the tag vocabulary stops it crowding the graph.
SIZE_BANDS: dict[str, tuple[int, int]] = {
    "tiny": (0, 100 * 1024),
    "small": (100 * 1024, 2 * 1024 * 1024),
    "medium": (2 * 1024 * 1024, 50 * 1024 * 1024),
    "large": (50 * 1024 * 1024, 500 * 1024 * 1024),
    "huge": (500 * 1024 * 1024, 1 << 62),
}


def build_filter(params: dict[str, list[str]]) -> tuple[str, list]:
    """Translate query-string filters into one WHERE clause over `v_library`."""
    clauses = ["v.state = 'indexed'"]
    args: list = []

    if media := _first(params, "type"):
        clauses.append("v.media_type = ?")
        args.append(media)

    if ext := _first(params, "ext"):
        clauses.append("v.ext = ?")
        args.append(ext.lower().lstrip("."))

    if root := _first(params, "root"):
        clauses.append("v.root_id = ?")
        args.append(int(root))

    if band := _first(params, "size"):
        low, high = SIZE_BANDS.get(band, (0, 1 << 62))
        clauses.append("v.size_bytes >= ? AND v.size_bytes < ?")
        args += [low, high]

    if bucket := _first(params, "color"):
        # rank <= 2 keeps this to genuinely prominent colours; without it every
        # photograph matches nearly every swatch.
        clauses.append(
            "v.asset_id IN (SELECT asset_id FROM color WHERE bucket = ? AND rank <= 2)"
        )
        args.append(bucket)

    # One subquery per axis: values within an axis are alternatives, axes
    # intersect. `tag` with no kind is the catch-all the search box uses.
    for kind in (*sorted(TAG_KINDS), "tag"):
        values = [v for v in params.get(kind, []) if v.strip()]
        if not values:
            continue
        placeholders = ",".join("?" * len(values))
        kind_clause = "t.kind = ? AND " if kind != "tag" else ""
        clauses.append(
            f"v.asset_id IN (SELECT at.asset_id FROM asset_tag at "
            f"JOIN tag t ON t.id = at.tag_id "
            f"WHERE {kind_clause}t.name IN ({placeholders}))"
        )
        if kind != "tag":
            args.append(kind)
        args += [v.strip().lower() for v in values]

    if query := (_first(params, "q") or "").strip():
        # One box, three indexes: filename, extracted/AI text, and tags.
        #
        # Tags have to be in here. An AI caption might say "golden retriever"
        # while the tag says "dog" -- searching only the text would miss the
        # photograph the model explicitly labelled, which is exactly the case
        # a user expects to work.
        clauses.append(
            "(v.name LIKE ? COLLATE NOCASE"
            " OR v.asset_id IN (SELECT tb.asset_id FROM text_fts"
            "                    JOIN text_block tb ON tb.id = text_fts.rowid"
            "                    WHERE text_fts MATCH ?)"
            " OR v.asset_id IN (SELECT at.asset_id FROM asset_tag at"
            "                    JOIN tag t ON t.id = at.tag_id"
            "                    WHERE t.name LIKE ? COLLATE NOCASE))"
        )
        args += [f"%{query}%", fts_query(query), f"%{query}%"]

    return " AND ".join(clauses), args


def _first(params: dict[str, list[str]], key: str) -> str | None:
    values = params.get(key) or []
    return values[0] if values and values[0] else None


def fts_query(raw: str) -> str:
    """Make user input safe for FTS5's MATCH grammar.

    FTS5 treats plenty of punctuation as syntax, so an unescaped apostrophe or
    a stray `*` turns a search into a 500. Quoting each bare token and AND-ing
    them gives predictable behaviour and cannot be made to error.
    """
    tokens = re.findall(r"[\w']+", raw)
    if not tokens:
        return '""'
    return " AND ".join('"' + t.replace('"', "") + '"' for t in tokens if t)


#: Filter keys that describe a selection, in the order they read best in a
#: label. `q` is last because a free-text term qualifies everything before it.
LABEL_ORDER = ("topic", "doctype", "author", "custom", "entity", "date",
               "pattern", "type", "ext", "size", "color", "tag", "q")


def filter_label(params: dict[str, list[str]], conn: sqlite3.Connection | None = None) -> str:
    """A human name for the current filter: "Finance, Invoice, by Jane Doe".

    Used as the brief's title and as the caption on the graph, so it has to
    read like something a person would say. Display names come from the tag
    vocabulary when a connection is available -- "hr" is not a label anyone
    wants to see in their own summary.
    """
    display: dict[tuple[str, str], str] = {}
    if conn is not None:
        rows = conn.execute(
            "SELECT kind, name, COALESCE(display_name, name) d FROM tag "
            "WHERE kind IN ('doctype','topic','author','custom','entity','pattern')"
        ).fetchall()
        display = {(r["kind"], r["name"]): r["d"] for r in rows}

    parts: list[str] = []
    for key in LABEL_ORDER:
        values = [v for v in params.get(key, []) if v.strip()]
        if not values:
            continue
        shown = [display.get((key, v.lower().strip()), v) for v in values]
        joined = " or ".join(shown)
        if key == "author":
            parts.append(f"by {joined}")
        elif key == "date":
            parts.append(f"from {joined}")
        elif key == "q":
            parts.append(f'matching "{joined}"')
        elif key == "size":
            parts.append(f"{joined} files")
        else:
            parts.append(joined)
    return ", ".join(parts)


def canonical_query(params: dict[str, list[str]]) -> str:
    """A stable string for a filter, so a brief can be cached against it.

    Sorted by key and by value, and restricted to keys that affect the result
    set -- otherwise `cursor=240` would make the same selection look like a
    different one and re-run a paid summarisation.
    """
    keys = set(LABEL_ORDER) | TAG_KINDS | {"root"}
    pairs = [
        (key, value.strip().lower())
        for key in sorted(keys)
        for value in sorted(params.get(key, []))
        if value.strip()
    ]
    return urlencode(pairs)


# ---------------------------------------------------------------------------
#  The grid
# ---------------------------------------------------------------------------


def library(conn: sqlite3.Connection, params: dict) -> dict:
    where, args = build_filter(params)
    cursor = int(_first(params, "cursor") or 0)

    rows = conn.execute(
        f"""
        SELECT v.file_id, v.asset_id, v.rel_path, v.name, v.ext, v.size_bytes,
               v.media_type, v.mime, v.width, v.height, v.duration_s,
               v.page_count, v.thumb_key, v.captured_at, v.root_path,
               af.doctype, af.topic, af.author, af.event_at,
               (SELECT hex FROM color c WHERE c.asset_id = v.asset_id
                 ORDER BY rank LIMIT 1) AS tint,
               (SELECT COUNT(*) FROM file f2
                 WHERE f2.asset_id = v.asset_id AND f2.state = 'indexed') AS copies
        FROM v_library v
        LEFT JOIN agent_finding af ON af.asset_id = v.asset_id
        WHERE {where} AND v.file_id > ?
        ORDER BY v.file_id
        LIMIT ?
        """,
        (*args, cursor, PAGE_SIZE + 1),
    ).fetchall()

    items = [dict(r) for r in rows[:PAGE_SIZE]]
    total = conn.execute(
        f"SELECT COUNT(*) FROM v_library v WHERE {where}", args
    ).fetchone()[0]

    return {
        "items": items,
        "total": total,
        "next": items[-1]["file_id"] if len(rows) > PAGE_SIZE and items else None,
        "label": filter_label(params, conn),
    }


# ---------------------------------------------------------------------------
#  The rail
# ---------------------------------------------------------------------------


def facets(conn: sqlite3.Connection) -> dict:
    """Everything the filter rail needs, in one round trip.

    Counts are **unconditioned** -- they describe the whole library, not the
    current selection. Conditioning them (so each chip shows how many results
    it would add to the present filter) is the nicer behaviour and is a
    deliberate omission: it means re-running every axis's count query on every
    keystroke, which on a large library is the difference between a rail that
    appears instantly and one that lags behind the grid it is meant to control.
    """
    q = lambda sql, *a: [dict(r) for r in conn.execute(sql, a)]  # noqa: E731
    states = {r["state"]: r["n"] for r in conn.execute("SELECT * FROM v_state_counts")}
    dupes = conn.execute(
        "SELECT COUNT(*) c, COALESCE(SUM(reclaimable_bytes), 0) b FROM v_duplicate_group"
    ).fetchone()

    groups = []
    for kind, heading in TAG_AXES:
        rows = q(
            "SELECT name, display_name, n FROM v_tag_facet WHERE kind = ? "
            "ORDER BY n DESC, display_name LIMIT ?",
            kind,
            40 if kind in ("doctype", "topic", "author", "date", "custom") else 16,
        )
        if rows:
            groups.append({"kind": kind, "heading": heading, "values": rows})

    return {
        "types": q(
            "SELECT media_type AS name, COUNT(*) n FROM v_library "
            "WHERE state='indexed' GROUP BY media_type ORDER BY n DESC"
        ),
        "colors": q(
            "SELECT c.bucket AS name, COUNT(DISTINCT c.asset_id) n, "
            "       (SELECT hex FROM color c2 WHERE c2.bucket = c.bucket "
            "        ORDER BY c2.proportion DESC LIMIT 1) AS swatch "
            "FROM color c WHERE c.rank <= 2 GROUP BY c.bucket ORDER BY n DESC"
        ),
        # The CASE is aliased `band`, not `name`, and grouped in an outer
        # query. `GROUP BY name` looks right and is wrong: `v_library` has a
        # real `name` column (the filename), SQLite resolves the identifier to
        # that column rather than to the output alias, and the result is one
        # group per file -- eighteen rows all labelled "tiny".
        "sizes": q(
            "SELECT band AS name, COUNT(*) n FROM ("
            "  SELECT CASE "
            "    WHEN size_bytes < 102400 THEN 'tiny' "
            "    WHEN size_bytes < 2097152 THEN 'small' "
            "    WHEN size_bytes < 52428800 THEN 'medium' "
            "    WHEN size_bytes < 524288000 THEN 'large' "
            "    ELSE 'huge' END AS band, "
            "    size_bytes FROM v_library WHERE state = 'indexed'"
            ") GROUP BY band ORDER BY MIN(size_bytes)"
        ),
        "groups": groups,
        "states": states,
        "duplicate_groups": dupes["c"],
        "reclaimable_bytes": dupes["b"],
        # The pitch, as a number the UI can show live.
        "mutations": conn.execute(
            "SELECT COUNT(*) FROM integrity_audit WHERE verdict = 'mutated'"
        ).fetchone()[0],
        "unclassified": conn.execute(
            "SELECT COUNT(*) FROM file f LEFT JOIN agent_finding af "
            "ON af.asset_id = f.asset_id "
            "WHERE f.state = 'indexed' AND af.topic IS NULL"
        ).fetchone()[0],
    }


# ---------------------------------------------------------------------------
#  One file
# ---------------------------------------------------------------------------


def detail(conn: sqlite3.Connection, file_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM v_library WHERE file_id = ?", (file_id,)
    ).fetchone()
    if row is None:
        return None
    item = dict(row)
    asset_id = item["asset_id"]
    if not asset_id:
        return item

    fetch = lambda sql, *a: [dict(r) for r in conn.execute(sql, a)]  # noqa: E731
    item["colors"] = fetch(
        "SELECT hex, bucket, proportion FROM color WHERE asset_id=? ORDER BY rank",
        asset_id,
    )
    item["tags"] = fetch(
        "SELECT t.name, t.kind, COALESCE(t.display_name, t.name) AS display_name, "
        "       MAX(at.confidence) AS confidence, "
        "       MAX(at.source = 'user') AS by_user, "
        "       group_concat(DISTINCT at.source) AS sources "
        "FROM asset_tag at JOIN tag t ON t.id = at.tag_id "
        "WHERE at.asset_id = ? GROUP BY t.id "
        "ORDER BY by_user DESC, confidence DESC LIMIT 60",
        asset_id,
    )
    item["text"] = fetch(
        "SELECT source, ord, substr(body, 1, 1200) AS body FROM text_block "
        "WHERE asset_id=? ORDER BY source, ord LIMIT 8",
        asset_id,
    )
    item["runs"] = fetch(
        "SELECT extractor, version, status, duration_ms, error_msg "
        "FROM extractor_run WHERE asset_id=? ORDER BY extractor",
        asset_id,
    )
    item["copies"] = fetch(
        "SELECT f.rel_path, r.path AS root_path FROM file f "
        "JOIN root r ON r.id = f.root_id "
        "WHERE f.asset_id=? AND f.state='indexed' ORDER BY f.rel_path",
        asset_id,
    )
    for table, key in (
        ("image_meta", "image"), ("video_meta", "video"),
        ("audio_meta", "audio"), ("doc_meta", "doc"), ("geo", "geo"),
        ("agent_finding", "agent"),
    ):
        got = conn.execute(
            f"SELECT * FROM {table} WHERE asset_id=?", (asset_id,)
        ).fetchone()
        if got:
            item[key] = {k: v for k, v in dict(got).items() if v is not None}
    return item


# ---------------------------------------------------------------------------
#  The graph
# ---------------------------------------------------------------------------

#: Node kinds the graph draws, in priority order. When the node budget runs
#: out, the kinds earlier in this tuple keep their nodes.
#:
#: `pattern` is in here because the structural findings are what make the graph
#: explain something rather than restate the rail: "Monetary amounts" sitting
#: between Invoice and Finance is the agent showing its working, and
#: "Possible secrets" attached to an Engineering cluster is a thing worth
#: seeing. `keyword` is deliberately absent -- it is a long tail of one-file
#: values that would spend the whole node budget saying nothing.
GRAPH_KINDS = ("topic", "doctype", "author", "custom", "pattern", "entity", "date")

#: Caps. A graph is a *high-level* view; past roughly this size it stops being
#: a picture of a library and becomes a hairball that answers no question.
MAX_NODES = 60
MAX_EDGES = 240

#: Per-kind cap, applied before the global one.
#:
#: Without it the graph fills up with whichever axis happens to have the most
#: values, and on a real library that is always `date` or `entity`. Years are
#: also the least informative nodes there are: every file has one, so a year
#: connects to everything and the layout collapses into a wheel with 2024 at
#: the hub. Capping per kind guarantees the picture stays *mixed*, which is
#: the only way it shows structure -- Finance sitting between Invoice and one
#: author, a Legal cluster touching nothing else.
MAX_PER_KIND = 12

#: Edges below this weight are dropped. Two files sharing a pair of tags is a
#: coincidence; five is a structure.
MIN_EDGE_WEIGHT = 2


def graph(conn: sqlite3.Connection, params: dict) -> dict:
    """A co-occurrence graph over the current selection.

    Nodes are *tags*, not files, and that is the whole design decision. A node
    per file gives a 100,000-point cloud that renders slowly and says nothing;
    a node per tag gives forty points whose shape is the actual structure of
    the library -- Finance sitting between Invoice and Jane Doe, Engineering
    tied to Log and 2024, a cluster of Legal that touches nothing else.

    An edge means "these two tags appear on the same file". It carries two
    numbers, and the difference between them is what makes the picture worth
    looking at:

    * `weight` -- how many files. What the tooltip shows, because it is the
      number a person can check.
    * `strength` -- `weight / min(count(a), count(b))`, so 1.0 means "wherever
      the rarer of these two appears, the other one does too".

    The layout pulls on `strength`, not on `weight`. Ranking by raw count
    produces a graph whose strongest links are simply its commonest tags: on a
    real library the top edges were all *2024 -- something*, because nearly
    every file has a year and a year therefore co-occurs with everything. That
    is not a relationship, it is a base rate. Normalising by the rarer endpoint
    surfaces the actual structure instead -- Invoice and Monetary amounts at
    1.0, because every invoice has figures in it and hardly anything else does.

    Clicking a node adds it to the filter, which makes the graph a way of
    navigating rather than a picture to admire.
    """
    where, args = build_filter(params)

    rows = conn.execute(
        f"""
        WITH selected AS (
            SELECT DISTINCT v.asset_id AS aid FROM v_library v
            WHERE {where} AND v.asset_id IS NOT NULL
        ),
        tagged AS (
            SELECT DISTINCT s.aid, t.id AS tid, t.kind,
                   COALESCE(t.display_name, t.name) AS label, t.name
            FROM selected s
            JOIN asset_tag at ON at.asset_id = s.aid
            JOIN tag t        ON t.id = at.tag_id
            WHERE t.kind IN ({",".join("?" * len(GRAPH_KINDS))})
        ),
        counted AS (
            SELECT tid, kind, label, name, COUNT(*) AS n
            FROM tagged GROUP BY tid
        ),
        ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (PARTITION BY kind ORDER BY n DESC, label)
                     AS rank_in_kind,
                   INSTR(?, kind) AS kind_priority
            FROM counted
        )
        SELECT tid, kind, label, name, n FROM ranked
        WHERE rank_in_kind <= ?
        ORDER BY kind_priority, n DESC, label
        LIMIT ?
        """,
        (*args, *GRAPH_KINDS, "|".join(GRAPH_KINDS), MAX_PER_KIND, MAX_NODES),
    ).fetchall()

    nodes = [dict(r) for r in rows]
    if len(nodes) < 2:
        return {"nodes": nodes, "edges": [], "label": filter_label(params, conn),
                "files": _selection_count(conn, where, args)}

    ids = [n["tid"] for n in nodes]
    ph = ",".join("?" * len(ids))
    edges = conn.execute(
        f"""
        WITH selected AS (
            SELECT DISTINCT v.asset_id AS aid FROM v_library v
            WHERE {where} AND v.asset_id IS NOT NULL
        ),
        tagged AS (
            SELECT DISTINCT s.aid, at.tag_id AS tid
            FROM selected s JOIN asset_tag at ON at.asset_id = s.aid
            WHERE at.tag_id IN ({ph})
        ),
        totals AS (
            SELECT tid, COUNT(*) AS n FROM tagged GROUP BY tid
        )
        SELECT a.tid AS source, b.tid AS target, COUNT(*) AS weight,
               ROUND(COUNT(*) * 1.0 / MIN(ta.n, tb.n), 4) AS strength
        FROM tagged a
        JOIN tagged b  ON b.aid = a.aid AND b.tid > a.tid
        JOIN totals ta ON ta.tid = a.tid
        JOIN totals tb ON tb.tid = b.tid
        GROUP BY a.tid, b.tid
        HAVING weight >= ?
        ORDER BY strength DESC, weight DESC
        LIMIT ?
        """,
        (*args, *ids, MIN_EDGE_WEIGHT, MAX_EDGES),
    ).fetchall()

    return {
        "nodes": nodes,
        "edges": [dict(e) for e in edges],
        "label": filter_label(params, conn),
        "files": _selection_count(conn, where, args),
    }


def _selection_count(conn: sqlite3.Connection, where: str, args: list) -> int:
    return conn.execute(
        f"SELECT COUNT(*) FROM v_library v WHERE {where}", args
    ).fetchone()[0]


# ---------------------------------------------------------------------------
#  What a brief reads
# ---------------------------------------------------------------------------

#: Ceiling on a selection that can be summarised in one go. Chosen so the
#: deterministic roll-up stays instant and the model pass stays inside one
#: request; past it the honest answer is "narrow the filter first".
MAX_BRIEF_ITEMS = 400


def selection_items(conn: sqlite3.Connection, params: dict, limit: int = MAX_BRIEF_ITEMS):
    """Rows for `agent.brief`, one per distinct asset in the selection.

    Per asset, not per file: summarising a folder that contains the same
    invoice three times should report one invoice, and should not count its
    total three times.
    """
    where, args = build_filter(params)
    return conn.execute(
        f"""
        SELECT MIN(v.name) AS name, MIN(v.rel_path) AS rel_path,
               MIN(v.media_type) AS media_type, MIN(v.size_bytes) AS size_bytes,
               af.doctype, af.topic, af.author, af.event_at,
               af.patterns, af.numbers,
               (SELECT substr(group_concat(tb.body, ' '), 1, 1200)
                  FROM text_block tb WHERE tb.asset_id = v.asset_id
                   AND tb.source NOT LIKE 'ai_%') AS excerpt
        FROM v_library v
        LEFT JOIN agent_finding af ON af.asset_id = v.asset_id
        WHERE {where} AND v.asset_id IS NOT NULL
        GROUP BY v.asset_id
        ORDER BY af.event_at DESC NULLS LAST, name
        LIMIT ?
        """,
        (*args, limit),
    ).fetchall()


def recent_briefs(conn: sqlite3.Connection, limit: int = 12) -> list[dict]:
    return [
        dict(r)
        for r in conn.execute(
            "SELECT id, query, label, title, asset_count, produced_by, created_at "
            "FROM brief ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
    ]


def find_brief(conn: sqlite3.Connection, query: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM brief WHERE query = ? ORDER BY created_at DESC LIMIT 1",
        (query,),
    ).fetchone()
    return dict(row) if row else None


def brief_by_id(conn: sqlite3.Connection, brief_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM brief WHERE id = ?", (brief_id,)).fetchone()
    return dict(row) if row else None
