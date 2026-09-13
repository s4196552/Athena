"""Adding and removing libraries.

The dangerous word in this file is "delete". In every other file manager,
deleting a library deletes files. Here it must never mean that, and the code,
the API names and the UI copy all have to say so unmistakably -- a user who
misreads this button and believes they have lost a decade of photographs has
had a terrible experience even though nothing was actually lost.

So the operation is called **forget**. It removes Athena's *opinions* about a
folder -- rows, tags, captions, thumbnails -- and touches nothing inside it.
The only files this module ever unlinks live in Athena's own thumbnail cache.

Two details that matter for correctness:

* **Shared content survives.** The same photograph may sit in two libraries.
  Assets are only removed once no path anywhere still refers to them, so
  forgetting one library cannot strip metadata from another.
* **Candidate assets are staged in a temp table, not an `IN (...)` list.**
  A library with 100k files would blow straight past SQLite's parameter limit,
  which is the kind of bug that only appears on a real user's disk.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from ..config import AppPaths
from ..db.writer import Writer

log = logging.getLogger("athena.library")


@dataclass(slots=True)
class Library:
    id: int
    path: str
    label: str
    files: int
    indexed: int
    missing: int
    errors: int
    bytes: int
    last_scan_at: int | None
    exists: bool


def list_libraries(conn: sqlite3.Connection) -> list[Library]:
    rows = conn.execute(
        """
        SELECT r.id, r.path, COALESCE(r.label, r.path) AS label, r.last_scan_at,
               COUNT(f.id)                                        AS files,
               SUM(f.state = 'indexed')                           AS indexed,
               SUM(f.state = 'missing')                           AS missing,
               SUM(f.state = 'error')                             AS errors,
               COALESCE(SUM(f.size_bytes), 0)                     AS bytes
        FROM root r
        LEFT JOIN file f ON f.root_id = r.id
        GROUP BY r.id
        ORDER BY r.added_at
        """
    ).fetchall()
    return [
        Library(
            id=r["id"], path=r["path"], label=r["label"],
            files=r["files"] or 0, indexed=r["indexed"] or 0,
            missing=r["missing"] or 0, errors=r["errors"] or 0,
            bytes=r["bytes"] or 0, last_scan_at=r["last_scan_at"],
            # A drive that is merely unplugged should read as "offline", not as
            # an invitation to forget it.
            exists=Path(r["path"]).is_dir(),
        )
        for r in rows
    ]


@dataclass(slots=True)
class ForgetResult:
    path: str
    files_removed: int
    assets_removed: int
    thumbnails_removed: int
    kept_metadata: bool

    @property
    def summary(self) -> str:
        tail = (
            "metadata kept for a future re-scan"
            if self.kept_metadata
            else f"{self.assets_removed} assets and {self.thumbnails_removed} thumbnails purged"
        )
        return (
            f"Removed {self.files_removed} entries for {self.path} "
            f"from the catalogue ({tail}). No files on disk were touched."
        )


def forget_library(
    writer: Writer,
    paths: AppPaths,
    root_id: int,
    *,
    forget_metadata: bool = True,
) -> ForgetResult | None:
    """Remove a library from the catalogue. **Never deletes user files.**

    `forget_metadata=False` keeps the extracted assets in place, orphaned.
    They are invisible in the UI (every view joins through `file`), but because
    assets are keyed by content hash, re-adding the folder later rebinds to
    them and the whole library is indexed again in seconds with no parsing and
    no AI spend. That is a genuinely useful option -- and it is *not* the
    default, because a user who asks to forget something should not discover
    later that it was quietly retained.
    """

    def job(cur: sqlite3.Cursor) -> tuple[ForgetResult, list[str]] | None:
        row = cur.execute("SELECT path FROM root WHERE id = ?", (root_id,)).fetchone()
        if row is None:
            return None
        path = row["path"]

        files = cur.execute(
            "SELECT COUNT(*) FROM file WHERE root_id = ?", (root_id,)
        ).fetchone()[0]

        # Staged in a temp table: a 100k-file library would exceed SQLite's
        # bound-parameter ceiling as an IN list.
        cur.execute("DROP TABLE IF EXISTS temp._forget_candidates")
        cur.execute("CREATE TEMP TABLE _forget_candidates (id INTEGER PRIMARY KEY)")
        cur.execute(
            "INSERT OR IGNORE INTO temp._forget_candidates (id) "
            "SELECT DISTINCT asset_id FROM file WHERE root_id = ? AND asset_id IS NOT NULL",
            (root_id,),
        )

        # ON DELETE CASCADE takes the file rows and the scan history with it.
        cur.execute("DELETE FROM root WHERE id = ?", (root_id,))

        cache_keys: list[str] = []
        assets_removed = 0

        if forget_metadata:
            # Only assets no longer referenced by *any* path, so content shared
            # with another library keeps everything it has.
            orphans = [
                r[0] for r in cur.execute(
                    "SELECT c.id FROM temp._forget_candidates c "
                    "LEFT JOIN file f ON f.asset_id = c.id "
                    "WHERE f.id IS NULL"
                )
            ]
            if orphans:
                cur.execute("DROP TABLE IF EXISTS temp._forget_orphans")
                cur.execute("CREATE TEMP TABLE _forget_orphans (id INTEGER PRIMARY KEY)")
                cur.executemany(
                    "INSERT OR IGNORE INTO temp._forget_orphans (id) VALUES (?)",
                    [(o,) for o in orphans],
                )
                cache_keys = [
                    r[0] for r in cur.execute(
                        "SELECT cache_key FROM thumbnail "
                        "WHERE asset_id IN (SELECT id FROM temp._forget_orphans)"
                    )
                ]
                # Cascades through every facet table, and the text_block and
                # geo triggers keep FTS5 and the R*Tree in step.
                cur.execute(
                    "DELETE FROM asset WHERE id IN (SELECT id FROM temp._forget_orphans)"
                )
                assets_removed = len(orphans)
                cur.execute("DROP TABLE IF EXISTS temp._forget_orphans")

        cur.execute("DROP TABLE IF EXISTS temp._forget_candidates")

        return (
            ForgetResult(
                path=path,
                files_removed=files,
                assets_removed=assets_removed,
                thumbnails_removed=0,
                kept_metadata=not forget_metadata,
            ),
            cache_keys,
        )

    outcome = writer.call(job)
    if outcome is None:
        return None
    result, cache_keys = outcome

    # Filesystem cleanup happens after the commit, and only ever inside
    # Athena's own cache directory. `_purge_thumbnails` re-checks that.
    result.thumbnails_removed = _purge_thumbnails(paths, cache_keys)
    log.info(result.summary)
    return result


def _purge_thumbnails(paths: AppPaths, cache_keys: list[str]) -> int:
    """Unlink cached thumbnails. Refuses to touch anything outside the cache.

    The containment check is not paranoia about our own code so much as a
    standing guarantee: this is the only `unlink` in the application, so it is
    the only place a path traversal could ever turn into data loss.
    """
    root = paths.thumbs.resolve()
    removed = 0
    for key in cache_keys:
        if not key:
            continue
        try:
            target = (root / key).resolve()
        except OSError:
            continue
        if not str(target).startswith(str(root)):
            log.error("refusing to delete outside the thumbnail cache: %s", target)
            continue
        try:
            target.unlink()
            removed += 1
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.warning("could not remove thumbnail %s: %s", target, exc)
    _prune_empty_dirs(root)
    return removed


def _prune_empty_dirs(root: Path) -> None:
    """Tidy the two-level hex fan-out left behind by removed thumbnails."""
    try:
        for parent in sorted(root.glob("*/*"), reverse=True):
            if parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
        for parent in sorted(root.glob("*"), reverse=True):
            if parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
    except OSError:
        pass
