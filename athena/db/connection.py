"""SQLite connection management.

Two connection flavours, and the distinction is load-bearing:

* `connect_rw()` -- exactly **one** per process, held by the writer thread.
* `connect_ro()` -- as many as you like, including from the UI process.

The whole concurrency story rests on WAL plus a single writer. WAL lets any
number of readers run while a write transaction is open, so the UI never blocks
on the indexer, and because only one connection ever writes, `SQLITE_BUSY`
simply cannot occur. No retry loops, no busy-handler tuning, no lock contention
to debug at 2am. The cost is a discipline the codebase has to keep: worker
processes are given no write connection at all, so they cannot break it even by
accident.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

#: Bumped whenever schema.sql changes in a way that needs a migration step.
SCHEMA_VERSION = 2


def _apply_pragmas(conn: sqlite3.Connection, *, readonly: bool) -> None:
    cur = conn.cursor()

    # Persistent, stored in the database header -- setting them repeatedly is
    # harmless and keeps a hand-copied file correct.
    if not readonly:
        cur.execute("PRAGMA journal_mode = WAL")
        # NORMAL is the right durability point for a *derived* catalogue. A
        # power cut can cost the last few transactions, which the next scan
        # simply re-derives; in exchange we avoid an fsync per commit, which is
        # the difference between 2k and 50k row-writes per second.
        cur.execute("PRAGMA synchronous = NORMAL")
        cur.execute("PRAGMA auto_vacuum = INCREMENTAL")

    # Per-connection.
    cur.execute("PRAGMA foreign_keys = ON")
    cur.execute("PRAGMA temp_store = MEMORY")
    cur.execute("PRAGMA cache_size = -65536")       # 64 MiB page cache
    cur.execute("PRAGMA mmap_size = 268435456")     # 256 MiB, big win on reads
    cur.execute("PRAGMA busy_timeout = 10000")      # belt and braces
    # Checkpoint at ~4 MiB of WAL rather than the 1 MiB default: fewer, larger
    # checkpoints keep the writer's batches from stalling mid-transaction.
    if not readonly:
        cur.execute("PRAGMA wal_autocheckpoint = 1000")
    cur.close()


def connect_rw(db_path: str | os.PathLike[str]) -> sqlite3.Connection:
    """The single writable connection. Creates and migrates the schema."""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(path),
        timeout=10.0,
        isolation_level=None,      # explicit BEGIN/COMMIT; no implicit commits
        check_same_thread=False,   # owned by the writer thread, handed over once
    )
    conn.row_factory = sqlite3.Row
    _apply_pragmas(conn, readonly=False)
    _migrate(conn)
    return conn


def connect_ro(db_path: str | os.PathLike[str]) -> sqlite3.Connection:
    """A read-only connection. Safe from any thread or process, including the UI.

    Opened through a URI with `mode=ro`, so SQLite itself refuses writes -- a
    stray `UPDATE` in query code fails loudly at development time instead of
    quietly breaking the single-writer invariant in production.
    """
    uri = f"file:{Path(db_path).as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    _apply_pragmas(conn, readonly=True)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current == SCHEMA_VERSION:
        return
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"catalogue was written by a newer Athena (v{current} > v{SCHEMA_VERSION}); "
            "upgrade the app rather than risk a downgrade"
        )

    # Steps that `IF NOT EXISTS` cannot express run first, each guarded by the
    # version it was introduced in. These are the only statements in the
    # codebase that can destroy catalogue rows, so each one is separately
    # idempotent and re-runnable.
    if 0 < current < 2:
        _widen_tag_kinds(conn)

    # `executescript` issues an implicit COMMIT before it runs and manages its
    # own transaction, so wrapping it in an explicit BEGIN/COMMIT fails. The
    # schema is built entirely from `IF NOT EXISTS` statements precisely so a
    # half-applied script is re-runnable rather than requiring a rollback.
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    # user_version is set last: a crash mid-script leaves it at the old value,
    # so the next startup simply re-runs the script.
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def _widen_tag_kinds(conn: sqlite3.Connection) -> None:
    """v2: `tag.kind` gained 'author', 'doctype', 'date', 'pattern', 'custom'.

    A CHECK constraint cannot be altered in place, and `CREATE TABLE IF NOT
    EXISTS` will not touch a table that already exists -- so an existing
    catalogue keeps the old, narrower constraint and every tag the inspection
    agent produces fails to insert. The table has to be rebuilt.

    Two details make this safe rather than alarming:

    * `asset_tag` and `detection` reference `tag(id)` *by name*. Dropping the
      old table with foreign keys disabled and renaming the new one into its
      place leaves those references resolving to the new table, and
      `foreign_key_check` afterwards proves nothing was orphaned.
    * `legacy_alter_table` is on for the rename. Without it SQLite reparses the
      whole schema and objects that `asset_tag` refers to a table that does not
      exist yet; with it, the rename is the textual substitution we want here.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tag'"
    ).fetchone()
    if row is None or "'doctype'" in (row[0] or ""):
        return          # fresh database, or already widened

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("PRAGMA legacy_alter_table = ON")
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DROP TABLE IF EXISTS tag_migrating")
        conn.execute(
            """
            CREATE TABLE tag_migrating (
              id           INTEGER PRIMARY KEY,
              kind         TEXT NOT NULL CHECK (kind IN (
                             'object', 'scene', 'place', 'keyword', 'topic',
                             'entity', 'genre', 'camera', 'language', 'system',
                             'author', 'doctype', 'date', 'pattern',
                             'custom', 'user')),
              name         TEXT NOT NULL,
              display_name TEXT,
              parent_id    INTEGER REFERENCES tag(id) ON DELETE SET NULL,
              canonical_id INTEGER REFERENCES tag(id) ON DELETE SET NULL,
              UNIQUE (kind, name)
            )
            """
        )
        conn.execute(
            "INSERT INTO tag_migrating "
            "(id, kind, name, display_name, parent_id, canonical_id) "
            "SELECT id, kind, name, display_name, parent_id, canonical_id FROM tag"
        )
        conn.execute("DROP TABLE tag")
        conn.execute("ALTER TABLE tag_migrating RENAME TO tag")
        conn.execute("COMMIT")
        orphans = conn.execute("PRAGMA foreign_key_check").fetchall()
        if orphans:
            raise RuntimeError(f"tag migration orphaned {len(orphans)} rows")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA legacy_alter_table = OFF")
        conn.execute("PRAGMA foreign_keys = ON")


def maintenance(conn: sqlite3.Connection) -> None:
    """Periodic upkeep. Cheap; run on idle, not in the hot path.

    `PRAGMA optimize` lets SQLite refresh stale `ANALYZE` statistics for the
    tables this connection actually touched. Without it, the planner's guesses
    about the `file_claim` partial index degrade badly once the backlog drains
    from 100k rows to 50, and claim queries start doing full scans.
    """
    conn.execute("PRAGMA optimize")
    conn.execute("PRAGMA incremental_vacuum(2000)")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
