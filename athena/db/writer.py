"""The single writer.

One thread, one connection, one queue. Every mutation to the catalogue passes
through here and is committed in batches.

Batching is not a micro-optimisation, it is the difference between a usable app
and an unusable one. SQLite's per-transaction overhead is dominated by the
commit, so committing once per file costs roughly a millisecond; at 100k files
that is ~100 seconds of pure commit time, and worse, it holds the write lock in
a tight loop that starves the WAL checkpointer. Committing 500 rows at a time
drops that to under a second in total.

The batch closes on whichever comes first: `batch_size` operations, or
`max_latency` seconds. The latency bound is what keeps the UI feeling live --
without it, a slow trickle of results at the tail of a scan could sit
uncommitted, and therefore invisible to the read-only UI connections, for
minutes.
"""

from __future__ import annotations

import logging
import queue
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Sequence

from ..core.facets import FACET_TABLES, TaskResult
from ..core.states import ErrorKind, FileState
from .connection import connect_rw, maintenance

log = logging.getLogger("athena.writer")

Job = Callable[[sqlite3.Cursor], Any]


@dataclass(slots=True)
class _Envelope:
    job: Job
    done: threading.Event | None = None
    result: Any = None
    error: BaseException | None = None


def _default_display(kind: str, name: str) -> str:
    """Human label for a tag nobody supplied one for.

    The agent's own vocabulary knows its display forms ("hr" -> "People & HR"),
    so ask it first; title-casing is the fallback for tags that came from
    elsewhere -- EXIF camera names, keywords, detector classes.
    """
    if kind in ("doctype", "topic"):
        try:
            from ..agent.taxonomy import display_of

            return display_of(name, "doctype" if kind == "doctype" else "topic")
        except Exception:  # noqa: BLE001 - a label is never worth an exception
            pass
    if kind == "pattern":
        try:
            from ..agent.patterns import PATTERN_BY_NAME

            found = PATTERN_BY_NAME.get(name)
            if found:
                return found.display
        except Exception:  # noqa: BLE001
            pass
    return name.replace("_", " ").title()


class Writer:
    """Owns the only read-write connection in the process."""

    def __init__(
        self,
        db_path: str,
        *,
        batch_size: int = 500,
        max_latency: float = 0.25,
        queue_depth: int = 4096,
    ) -> None:
        self.db_path = db_path
        self.batch_size = batch_size
        self.max_latency = max_latency
        # A bounded queue is the backpressure mechanism. If extraction ever
        # outruns the writer, producers block here rather than growing an
        # unbounded in-memory backlog that ends in an OOM two hours into a scan.
        self._q: queue.Queue[_Envelope | None] = queue.Queue(maxsize=queue_depth)
        self._thread = threading.Thread(target=self._run, name="athena-writer", daemon=True)
        self._conn: sqlite3.Connection | None = None
        self._tag_cache: dict[tuple[str, str], int] = {}
        self._stopping = threading.Event()
        self._last_maintenance = 0.0
        self.committed = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> "Writer":
        self._thread.start()
        return self

    def close(self, timeout: float = 30.0) -> None:
        self._stopping.set()
        self._q.put(None)
        self._thread.join(timeout)

    # -- submission --------------------------------------------------------

    def submit(self, job: Job) -> None:
        """Fire and forget. Blocks if the writer is saturated (by design)."""
        self._q.put(_Envelope(job))

    def call(self, job: Job, timeout: float = 30.0) -> Any:
        """Run a job and wait for its result. For reads-then-writes only."""
        env = _Envelope(job, done=threading.Event())
        self._q.put(env)
        if not env.done.wait(timeout):
            raise TimeoutError("writer did not complete job in time")
        if env.error:
            raise env.error
        return env.result

    def flush(self, timeout: float = 30.0) -> None:
        self.call(lambda cur: None, timeout)

    # -- the loop ----------------------------------------------------------

    def _run(self) -> None:
        self._conn = connect_rw(self.db_path)
        try:
            while True:
                batch = self._drain()
                if batch is None:
                    break
                if batch:
                    self._commit(batch)
                self._maybe_maintain()
        finally:
            if self._conn is not None:
                self._conn.close()

    def _drain(self) -> list[_Envelope] | None:
        """Collect one batch. Returns None on shutdown."""
        batch: list[_Envelope] = []
        deadline = time.monotonic() + self.max_latency
        try:
            first = self._q.get(timeout=1.0)
        except queue.Empty:
            return batch
        if first is None:
            return None
        batch.append(first)

        while len(batch) < self.batch_size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                item = self._q.get(timeout=remaining)
            except queue.Empty:
                break
            if item is None:
                # Shutdown signal mid-batch: commit what we have, then stop.
                self._commit(batch)
                return None
            batch.append(item)
        return batch

    def _commit(self, batch: Sequence[_Envelope]) -> None:
        assert self._conn is not None
        cur = self._conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            for env in batch:
                try:
                    env.result = env.job(cur)
                except Exception as exc:  # noqa: BLE001
                    # One poisoned job must not roll back the other 499. Record
                    # it against its waiter and carry on with the batch.
                    env.error = exc
                    log.exception("write job failed")
            cur.execute("COMMIT")
            self.committed += len(batch)
        except Exception:
            cur.execute("ROLLBACK")
            log.exception("batch rolled back (%d jobs)", len(batch))
            for env in batch:
                if env.error is None:
                    env.error = RuntimeError("batch rolled back")
            raise
        finally:
            cur.close()
            for env in batch:
                if env.done is not None:
                    env.done.set()

    def _maybe_maintain(self) -> None:
        now = time.monotonic()
        if now - self._last_maintenance < 300:
            return
        self._last_maintenance = now
        assert self._conn is not None
        try:
            maintenance(self._conn)
        except sqlite3.Error:
            log.warning("maintenance pass failed", exc_info=True)

    # -- high-level operations --------------------------------------------
    #
    # Each returns a Job closure. They are written as closures rather than
    # methods so callers from any thread can hand work to the writer without
    # touching the connection themselves.

    def apply_result(self, res: TaskResult) -> None:
        self.submit(lambda cur: self._apply_result(cur, res))

    def _apply_result(self, cur: sqlite3.Cursor, res: TaskResult) -> None:
        now = int(time.time())

        if res.integrity_verdict in ("mutated", "vanished"):
            cur.execute(
                "INSERT INTO integrity_audit "
                "(file_id, path, verdict, detail) "
                "SELECT ?, root.path || '/' || file.rel_path, ?, ? "
                "FROM file JOIN root ON root.id = file.root_id WHERE file.id = ?",
                (res.file_id, res.integrity_verdict, res.integrity_detail, res.file_id),
            )

        if not res.ok:
            self._fail(cur, res)
            return

        # -- stage 1: bind the path to its content identity -----------------
        asset_id = res.asset_id
        if res.content_hash:
            asset_id = self._upsert_asset(cur, res)
            # If this content has already been through the pipeline -- a
            # duplicate discovered in a later scan, or a folder re-added after
            # being forgotten with its metadata kept -- there is nothing left
            # to do and the file is finished the moment it is bound.
            #
            # Without this it would sit in `queued` forever: `extract` only
            # claims assets in `pending`, so a `complete` asset is never picked
            # up again and the file never leaves the backlog.
            done = cur.execute(
                "SELECT pipeline_state = 'complete' FROM asset WHERE id = ?",
                (asset_id,),
            ).fetchone()[0]
            cur.execute(
                "UPDATE file SET asset_id = ?, lease_owner = NULL, "
                "lease_expires_at = NULL, attempts = 0, state_reason = NULL, "
                "state = CASE WHEN ? THEN ? ELSE state END "
                "WHERE id = ?",
                (asset_id, done, FileState.INDEXED.value, res.file_id),
            )

        if asset_id is None:
            return

        # -- stage 2/3: facets ---------------------------------------------
        for table, rows in res.facets.rows.items():
            if table not in FACET_TABLES:
                raise ValueError(f"worker emitted rows for non-facet table {table!r}")
            for row in rows:
                self._upsert_facet(cur, table, asset_id, row)

        for fact in res.facets.tags:
            tag_id = self._tag_id(cur, fact.kind, fact.name, fact.display)
            cur.execute(
                "INSERT INTO asset_tag (asset_id, tag_id, source, confidence, instances) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(asset_id, tag_id, source) DO UPDATE SET "
                "  confidence = MAX(confidence, excluded.confidence), "
                "  instances  = MAX(instances,  excluded.instances)",
                (asset_id, tag_id, fact.source, fact.confidence, fact.instances),
            )

        for det in res.facets.detections:
            tag_id = self._tag_id(cur, det.kind, det.name)
            cur.execute(
                "INSERT INTO detection "
                "(asset_id, tag_id, source, confidence, x, y, w, h, t_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (asset_id, tag_id, det.source, det.confidence,
                 det.x, det.y, det.w, det.h, det.t_ms),
            )

        for run in res.runs:
            cur.execute(
                "INSERT INTO extractor_run "
                "(asset_id, extractor, version, status, started_at, duration_ms, "
                " error_kind, error_msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(asset_id, extractor) DO UPDATE SET "
                "  version = excluded.version, status = excluded.status, "
                "  started_at = excluded.started_at, duration_ms = excluded.duration_ms, "
                "  error_kind = excluded.error_kind, error_msg = excluded.error_msg",
                (asset_id, run.extractor, run.version, run.status, now,
                 run.duration_ms, run.error_kind, run.error_msg),
            )

        if res.stage in ("extract", "ml"):
            # `pipeline_state` is what moves a file between tiers:
            #   pending -> (extract) -> partial -> (ml) -> complete
            # Marking it complete straight after extract is what silently
            # disabled the whole ML tier: stage 3 claims `queued` rows, and a
            # file flipped to `indexed` is never queued again, so OCR and
            # tagging had nothing to claim no matter how they were configured.
            done = not res.needs_ml
            cur.execute(
                "UPDATE asset SET last_run_at = ?, pipeline_state = ? WHERE id = ?",
                (now, "complete" if done else "partial", asset_id),
            )
            if done:
                # Every *path* holding this content is finished, not just the
                # one that happened to be claimed: the work was keyed to the
                # asset. Without this, duplicates would each be claimed and
                # re-dispatched in turn -- and with a paid AI provider that is
                # one API call per copy of the same photograph.
                cur.execute(
                    "UPDATE file SET state = ?, lease_owner = NULL, "
                    "lease_expires_at = NULL, state_reason = NULL, attempts = 0 "
                    "WHERE asset_id = ? AND state = ?",
                    (FileState.INDEXED.value, asset_id, FileState.QUEUED.value),
                )
            else:
                # Stays `queued` with the lease released, so stage 3 picks it up.
                cur.execute(
                    "UPDATE file SET lease_owner = NULL, lease_expires_at = NULL, "
                    "state_reason = NULL, attempts = 0 WHERE id = ?",
                    (res.file_id,),
                )

    def _fail(self, cur: sqlite3.Cursor, res: TaskResult) -> None:
        from ..core.states import MAX_ATTEMPTS, RETRYABLE

        kind = ErrorKind(res.error_kind) if res.error_kind else ErrorKind.INTERNAL
        row = cur.execute("SELECT attempts FROM file WHERE id = ?", (res.file_id,)).fetchone()
        attempts = (row[0] if row else 0) + 1
        retryable = kind in RETRYABLE and attempts < MAX_ATTEMPTS
        # A retryable failure stays queued but drops to the back of the line, so
        # a flaky network share cannot monopolise workers ahead of local files.
        new_state = FileState.QUEUED if retryable else FileState.ERROR
        cur.execute(
            "UPDATE file SET state = ?, state_reason = ?, attempts = ?, "
            "priority = MAX(priority, 200), lease_owner = NULL, lease_expires_at = NULL "
            "WHERE id = ?",
            (new_state.value, f"{kind.value}: {res.error_msg or ''}"[:500],
             attempts, res.file_id),
        )
        if res.asset_id:
            cur.execute(
                "UPDATE asset SET pipeline_state = 'failed' WHERE id = ?", (res.asset_id,)
            )

    def _upsert_asset(self, cur: sqlite3.Cursor, res: TaskResult) -> int:
        cur.execute(
            "INSERT INTO asset (content_hash, size_bytes, mime, media_type) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING",
            (res.content_hash, res.size_bytes or 0, res.mime, res.media_type or "other"),
        )
        row = cur.execute(
            "SELECT id FROM asset WHERE content_hash = ?", (res.content_hash,)
        ).fetchone()
        return int(row[0])

    @staticmethod
    def _upsert_facet(
        cur: sqlite3.Cursor, table: str, asset_id: int, row: dict[str, Any]
    ) -> None:
        cols = ["asset_id", *row.keys()]
        vals = [asset_id, *row.values()]
        placeholders = ", ".join("?" * len(cols))
        # `text_block` and `detection` are append-only logs keyed by rowid;
        # everything else is keyed by asset (plus rank/kind/model/algo), so an
        # upsert keeps re-extraction idempotent instead of accumulating dupes.
        verb = "INSERT" if table == "text_block" else "INSERT OR REPLACE"
        cur.execute(
            f"{verb} INTO {table} ({', '.join(cols)}) VALUES ({placeholders})",
            vals,
        )

    def _tag_id(
        self, cur: sqlite3.Cursor, kind: str, name: str, display: str | None = None
    ) -> int:
        key = (kind, name)
        cached = self._tag_cache.get(key)
        if cached is not None:
            return cached
        label = display or _default_display(kind, name)
        cur.execute(
            "INSERT INTO tag (kind, name, display_name) VALUES (?, ?, ?) "
            "ON CONFLICT(kind, name) DO NOTHING",
            (kind, name, label),
        )
        row = cur.execute(
            "SELECT id FROM tag WHERE kind = ? AND name = ?", (kind, name)
        ).fetchone()
        tag_id = int(row[0])
        self._tag_cache[key] = tag_id
        return tag_id

    # -- scanner-facing bulk operations ------------------------------------

    def upsert_files(self, rows: Sequence[tuple]) -> None:
        """Bulk-upsert discovered paths.

        The CASE expressions encode the whole rediscovery policy in one
        statement, so the scanner never has to read a row before writing it --
        which is what lets a 100k-file walk stay I/O bound rather than becoming
        100k round trips through the writer queue.
        """
        sql = """
        INSERT INTO file (root_id, rel_path, parent_rel, name, ext,
                          size_bytes, mtime_ns, ctime_ns, priority,
                          last_seen_at, last_scan_id, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, 'queued')
        ON CONFLICT(root_id, rel_path) DO UPDATE SET
          last_seen_at = unixepoch(),
          last_scan_id = excluded.last_scan_id,
          size_bytes   = excluded.size_bytes,
          mtime_ns     = excluded.mtime_ns,
          ctime_ns     = excluded.ctime_ns,
          -- Content changed -> re-index from scratch and reset the retry budget.
          -- Reappeared after being missing -> re-queue; the extractor ledger
          -- makes that nearly free when the bytes are unchanged, because every
          -- extractor is already recorded against that content hash.
          state = CASE
            WHEN file.size_bytes <> excluded.size_bytes
              OR file.mtime_ns   <> excluded.mtime_ns THEN 'queued'
            WHEN file.state = 'missing'               THEN 'queued'
            ELSE file.state
          END,
          attempts = CASE
            WHEN file.size_bytes <> excluded.size_bytes
              OR file.mtime_ns   <> excluded.mtime_ns THEN 0
            ELSE file.attempts
          END
        """
        self.submit(lambda cur: cur.executemany(sql, rows))

    def sweep_missing(self, root_id: int, scan_id: int) -> int:
        """Anything not touched by this scan is gone. One statement, no walk."""

        def job(cur: sqlite3.Cursor) -> int:
            cur.execute(
                "UPDATE file SET state = 'missing', lease_owner = NULL, "
                "lease_expires_at = NULL "
                "WHERE root_id = ? AND state <> 'missing' "
                "  AND (last_scan_id IS NULL OR last_scan_id <> ?)",
                (root_id, scan_id),
            )
            return cur.rowcount

        return self.call(job)

    def claim(self, stage: str, owner: str, limit: int, lease_s: int = 600) -> list[dict]:
        """Atomically lease the next slice of the backlog, with everything a
        worker needs to run without a database of its own.

        Claim-and-lease is one `UPDATE ... RETURNING`, so two stages -- or a
        second engine instance, or a stale run whose lease is expiring right
        now -- can never hand the same file to two workers. The follow-up
        SELECT then gathers the absolute path, the content identity and the
        per-asset extractor ledger, which is what lets the worker skip
        everything already current without a single query of its own.

        The stage predicates encode the tier ordering: `identify` takes rows
        that have no asset yet, `extract` takes rows that have one, and `ml`
        takes only rows whose cheap tier has already completed -- so the
        library becomes browsable long before the expensive work is done.
        """

        stage_filter = {
            "identify": "f.asset_id IS NULL",
            "extract": "f.asset_id IS NOT NULL AND a.pipeline_state = 'pending'",
            "ml": "f.asset_id IS NOT NULL AND a.pipeline_state = 'partial'",
        }.get(stage, "1")

        def job(cur: sqlite3.Cursor) -> list[dict]:
            cur.execute(
                f"""
                UPDATE file SET lease_owner = ?, lease_expires_at = unixepoch() + ?
                WHERE id IN (
                    SELECT f.id FROM file f
                    LEFT JOIN asset a ON a.id = f.asset_id
                    WHERE f.state = 'queued'
                      AND (f.lease_expires_at IS NULL
                           OR f.lease_expires_at < unixepoch())
                      AND ({stage_filter})
                    ORDER BY f.priority, f.id
                    LIMIT ?
                )
                RETURNING id
                """,
                (owner, lease_s, limit),
            )
            ids = [int(r[0]) for r in cur.fetchall()]
            if not ids:
                return []

            placeholders = ",".join("?" * len(ids))
            rows = cur.execute(
                f"""
                SELECT f.id, f.rel_path, f.size_bytes, f.asset_id,
                       r.path AS root_path,
                       a.content_hash, a.mime, a.media_type
                FROM file f
                JOIN root r ON r.id = f.root_id
                LEFT JOIN asset a ON a.id = f.asset_id
                WHERE f.id IN ({placeholders})
                """,
                ids,
            ).fetchall()

            asset_ids = [r["asset_id"] for r in rows if r["asset_id"]]
            completed: dict[int, dict[str, int]] = {}
            if asset_ids:
                ph = ",".join("?" * len(asset_ids))
                for run in cur.execute(
                    f"SELECT asset_id, extractor, version FROM extractor_run "
                    f"WHERE asset_id IN ({ph}) AND status IN ('ok', 'unsupported')",
                    asset_ids,
                ):
                    completed.setdefault(run["asset_id"], {})[run["extractor"]] = run["version"]

            # Stage 3 summarises text the cheap tier already pulled out, so
            # it travels with the task rather than being re-parsed.
            texts: dict[int, str] = {}
            if stage == "ml" and asset_ids:
                ph = ",".join("?" * len(asset_ids))
                for row in cur.execute(
                    f"SELECT asset_id, group_concat(body, char(10)) AS body "
                    f"FROM (SELECT asset_id, body FROM text_block "
                    f"      WHERE asset_id IN ({ph}) "
                    f"        AND source NOT LIKE 'ai_%' ORDER BY asset_id, ord) "
                    f"GROUP BY asset_id",
                    asset_ids,
                ):
                    texts[row["asset_id"]] = row["body"] or ""

            # What the cheap tier already decided, so the ML tier can skip the
            # files it settled confidently. This is what keeps escalation rare
            # -- and therefore affordable -- rather than a model call per file.
            hints: dict[int, dict] = {}
            if stage == "ml" and asset_ids:
                ph = ",".join("?" * len(asset_ids))
                for row in cur.execute(
                    f"SELECT asset_id, doctype, doctype_score, topic, topic_score, "
                    f"       author, escalated "
                    f"FROM agent_finding WHERE asset_id IN ({ph})",
                    asset_ids,
                ):
                    hints[row["asset_id"]] = {
                        k: row[k] for k in row.keys() if k != "asset_id"
                    }

            # One task per distinct asset. Copies claimed alongside it stay
            # leased and are finished by the propagation above when the
            # representative's result lands -- they never reach a worker.
            #
            # The `completed` ledger alone cannot prevent this: every task in a
            # batch is assembled before any of their results are written, so
            # duplicates within one batch all see the same empty ledger.
            out: list[dict] = []
            seen: set[int] = set()
            for r in rows:
                aid = r["asset_id"]
                if aid is not None:
                    if aid in seen:
                        continue
                    seen.add(aid)
                out.append({
                    **dict(r),
                    "completed": completed.get(aid, {}),
                    "text": texts.get(aid, ""),
                    "hints": hints.get(aid, {}),
                })
            return out

        return self.call(job)

    # -- UI-facing writes ---------------------------------------------------
    #
    # These are the only places a *person* writes to the catalogue, and they go
    # through the same single writer thread as the indexer. That is the whole
    # reason the UI can offer them at all: a second connection taking a write
    # lock while a scan is running is the one thing the concurrency design
    # forbids, so the UI hands work to the writer instead of doing it itself.

    def set_tag(
        self,
        asset_ids: Sequence[int],
        kind: str,
        name: str,
        *,
        display: str | None = None,
    ) -> int:
        """Attach a tag a person typed, to one asset or to a whole selection.

        Tagged by asset, not by file, which is the useful behaviour and comes
        free from the identity model: tag one copy of a photograph and every
        other copy of the same bytes carries the tag too -- including copies
        discovered by a later scan of a different folder.

        `source` is fixed to 'user'. A person's tag and a model's guess must
        never be indistinguishable: `asset_tag`'s primary key includes the
        source, so a user tag and an agent tag of the same name coexist, and
        the UI can show which is which and let the person overrule.
        """
        key = " ".join(name.strip().split())
        if not key or not asset_ids:
            return 0

        def job(cur: sqlite3.Cursor) -> int:
            tag_id = self._tag_id(cur, kind, key.lower(), display or key)
            cur.executemany(
                "INSERT INTO asset_tag (asset_id, tag_id, source, confidence) "
                "VALUES (?, ?, 'user', 1.0) "
                "ON CONFLICT(asset_id, tag_id, source) DO NOTHING",
                [(int(a), tag_id) for a in asset_ids],
            )
            return len(asset_ids)

        return self.call(job)

    def unset_tag(self, asset_ids: Sequence[int], kind: str, name: str) -> int:
        """Remove a *user* tag. Agent tags are left alone.

        Deliberately scoped to `source = 'user'`: letting the UI delete a
        derived tag would be a lie, because the next re-index at a new
        extractor version would put it straight back. To overrule the agent,
        add a user tag; the UI prefers it.
        """
        key = " ".join(name.strip().split()).lower()
        if not key or not asset_ids:
            return 0

        def job(cur: sqlite3.Cursor) -> int:
            placeholders = ",".join("?" * len(asset_ids))
            cur.execute(
                f"DELETE FROM asset_tag WHERE source = 'user' AND asset_id IN "
                f"({placeholders}) AND tag_id IN "
                f"(SELECT id FROM tag WHERE kind = ? AND name = ?)",
                (*[int(a) for a in asset_ids], kind, key),
            )
            removed = cur.rowcount
            # A custom tag nobody uses any more should stop appearing in the
            # rail's vocabulary. Only user-invented kinds are pruned -- the
            # agent's closed vocabularies are meant to persist.
            if kind == "custom":
                cur.execute(
                    "DELETE FROM tag WHERE kind = 'custom' AND name = ? "
                    "AND id NOT IN (SELECT tag_id FROM asset_tag)",
                    (key,),
                )
            return removed

        return self.call(job)

    def save_brief(
        self, query: str, label: str, title: str, body: str,
        asset_count: int, produced_by: str,
    ) -> int:
        def job(cur: sqlite3.Cursor) -> int:
            cur.execute(
                "INSERT INTO brief (query, label, title, body, asset_count, produced_by) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(query, produced_by) DO UPDATE SET "
                "  label = excluded.label, title = excluded.title, "
                "  body = excluded.body, asset_count = excluded.asset_count, "
                "  created_at = unixepoch()",
                (query, label, title, body, asset_count, produced_by),
            )
            row = cur.execute(
                "SELECT id FROM brief WHERE query = ? AND produced_by = ?",
                (query, produced_by),
            ).fetchone()
            return int(row[0]) if row else 0

        return self.call(job)

    def release(self, file_ids: Iterable[int]) -> None:
        ids = list(file_ids)
        if not ids:
            return
        self.submit(
            lambda cur: cur.executemany(
                "UPDATE file SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
                [(i,) for i in ids],
            )
        )
