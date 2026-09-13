"""Directory discovery.

The scanner's entire job is to get 100,000 paths into the `queued` state as
fast as the filesystem allows, and to work out what happened to the paths that
are no longer there. It does no parsing, opens no files, and reads no content.
That separation is what makes the app feel instant: a cold walk of a 100k-file
library is a few seconds of `os.scandir`, after which the UI already shows the
full library with real names, sizes and dates, while the expensive tiers fill
in behind it.

Three details do most of the work:

* **`DirEntry.stat()` instead of `os.stat()`.** On Windows the directory
  enumeration already carries size, timestamps and attributes, so
  `entry.stat()` is free. Calling `os.stat(path)` instead would open each file
  -- 100k extra opens, and a 10x slower walk.

* **Cycle protection by device+inode, not by path.** Symlink loops and
  recursive bind mounts produce infinitely many distinct paths for the same
  directory; only identity breaks the cycle.

* **Scan generations rather than deletion diffs.** Every row touched by a scan
  is stamped with its `scan_id`; afterwards, one `UPDATE` marks everything not
  stamped as `missing`. No set arithmetic in Python, no memory proportional to
  the library, and it is correct even if the scan is resumed after a crash.
"""

from __future__ import annotations

import logging
import os
import stat
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Iterator

from ..db.writer import Writer
from . import safety
from .identity import extension, is_indexable
from .states import PRIORITY_HUGE, PRIORITY_NORMAL, PRIORITY_RECENT

log = logging.getLogger("athena.scanner")

#: Directories never worth walking. Skipping them is not an optimisation --
#: several are OS-internal junctions that will happily recurse forever.
SKIP_DIRS: frozenset[str] = frozenset({
    "$recycle.bin", "system volume information", "$windows.~ws", "$windows.~bt",
    ".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv",
    ".cache", ".thumbnails", ".ds_store", "@eadir", ".trash", ".trashes",
    "appdata", "application data",
})

#: Files above this are still catalogued, but pushed to the back of the queue
#: so a single 40 GB video cannot stall the first useful results.
HUGE_FILE_BYTES = 2 * 1024**3

#: How long "recent" means for priority purposes.
RECENT_WINDOW_S = 30 * 86400

#: Rows per writer submission. Large enough to amortise the queue hop, small
#: enough that progress stays visible during a long walk.
BATCH = 1000


@dataclass(slots=True)
class ScanStats:
    dirs_seen: int = 0
    files_seen: int = 0
    files_queued: int = 0
    files_missing: int = 0
    files_moved: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    started_at: float = field(default_factory=time.monotonic)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started_at


ProgressFn = Callable[[ScanStats], None]


class Scanner:
    def __init__(
        self,
        writer: Writer,
        *,
        cancel: threading.Event | None = None,
        on_progress: ProgressFn | None = None,
        progress_every: int = 2000,
    ) -> None:
        self.writer = writer
        self.cancel = cancel or threading.Event()
        self.on_progress = on_progress
        self.progress_every = progress_every

    # -- public API --------------------------------------------------------

    def scan_root(self, root_id: int, root_path: str, *, kind: str = "full") -> ScanStats:
        scan_id = self._begin_scan(root_id, kind)
        stats = ScanStats()
        batch: list[tuple] = []
        now = int(time.time())

        try:
            for entry, st in self._walk(root_path, stats):
                if self.cancel.is_set():
                    break
                rel = os.path.relpath(entry.path, root_path).replace(os.sep, "/")
                parent = os.path.dirname(rel)
                batch.append((
                    root_id,
                    rel,
                    parent,
                    entry.name,
                    extension(entry.name),
                    st.st_size,
                    st.st_mtime_ns,
                    getattr(st, "st_ctime_ns", None),
                    self._priority(st, now),
                    scan_id,
                ))
                stats.files_seen += 1
                if len(batch) >= BATCH:
                    self.writer.upsert_files(batch)
                    batch = []
                if stats.files_seen % self.progress_every == 0:
                    self._report(stats)

            if batch:
                self.writer.upsert_files(batch)

            # The walk's writes must land before the sweep runs, or files the
            # walk just stamped would be swept as missing.
            self.writer.flush()

            if not self.cancel.is_set():
                stats.files_missing = self.writer.sweep_missing(root_id, scan_id)
                stats.files_moved = self.reconcile_moves(root_id)

        except Exception as exc:  # noqa: BLE001
            stats.errors.append(repr(exc))
            log.exception("scan of %s failed", root_path)
            self._end_scan(scan_id, stats, "failed")
            raise
        else:
            self._end_scan(
                scan_id, stats, "cancelled" if self.cancel.is_set() else "complete"
            )

        self._report(stats)
        return stats

    # -- the walk ----------------------------------------------------------

    def _walk(self, root_path: str, stats: ScanStats) -> Iterator[tuple[os.DirEntry, os.stat_result]]:
        """Iterative DFS. No recursion, so a 300-deep tree cannot blow the stack."""
        stack: list[str] = [root_path]
        visited: set[tuple[int, int]] = set()

        while stack:
            if self.cancel.is_set():
                return
            current = stack.pop()
            try:
                it = os.scandir(current)
            except (PermissionError, FileNotFoundError, OSError) as exc:
                stats.errors.append(f"{current}: {exc.strerror or exc}")
                continue

            stats.dirs_seen += 1
            with it:
                while True:
                    # Advancing the iterator can itself raise on a disappearing
                    # or permission-denied entry, which would abandon the rest
                    # of an otherwise readable directory.
                    try:
                        entry = next(it)
                    except StopIteration:
                        break
                    except OSError as exc:
                        stats.errors.append(f"{current}: {exc}")
                        break

                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if self._should_descend(entry, visited):
                                stack.append(entry.path)
                            else:
                                stats.skipped += 1
                            continue

                        if not entry.is_file(follow_symlinks=False):
                            continue
                        if not is_indexable(entry.name):
                            stats.skipped += 1
                            continue

                        st = entry.stat(follow_symlinks=False)
                        if safety.is_hidden(entry.path, st):
                            stats.skipped += 1
                            continue
                        if st.st_size == 0:
                            stats.skipped += 1
                            continue
                        yield entry, st
                    except OSError as exc:
                        stats.errors.append(f"{entry.path}: {exc}")

    def _should_descend(self, entry: os.DirEntry, visited: set[tuple[int, int]]) -> bool:
        if entry.name.lower() in SKIP_DIRS or entry.name.startswith("."):
            return False
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            return False

        # Windows junctions and reparse points are the classic infinite-recursion
        # trap ("Documents and Settings" -> "Users" -> ...).
        attrs = getattr(st, "st_file_attributes", 0)
        if attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            return False
        if attrs & getattr(stat, "FILE_ATTRIBUTE_SYSTEM", 0):
            return False

        # Identity-based cycle break. st_ino is 0 for scandir results on
        # Windows, in which case we fall back to trusting the reparse check.
        ident = (getattr(st, "st_dev", 0), getattr(st, "st_ino", 0))
        if ident != (0, 0):
            if ident in visited:
                return False
            visited.add(ident)
        return True

    @staticmethod
    def _priority(st: os.stat_result, now: int) -> int:
        if st.st_size >= HUGE_FILE_BYTES:
            return PRIORITY_HUGE
        if now - int(st.st_mtime) < RECENT_WINDOW_S:
            return PRIORITY_RECENT
        return PRIORITY_NORMAL

    # -- move reconciliation ----------------------------------------------

    def reconcile_moves(self, root_id: int) -> int:
        """Re-attach files that merely moved.

        A move looks like a deletion plus a creation, and treating it that way
        would throw away every tag on the file. Since size and mtime survive a
        rename byte for byte, they make an excellent *candidate* filter: the
        query below only ever compares the (usually tiny) missing set against
        the newly-queued set, so the cost is proportional to churn, not to
        library size.

        Candidates are then confirmed by filesystem identity -- NTFS file id or
        POSIX inode, which a rename preserves and a copy does not. Only when
        identity is unavailable do we fall back to size+mtime alone, and even
        then a wrong guess is self-correcting: stage 1 hashes the file, and a
        mismatched hash simply rebinds it to the right asset.
        """

        def job(cur) -> int:
            pairs = cur.execute(
                """
                SELECT m.id AS missing_id, m.rel_path AS old_path,
                       n.id AS new_id,    n.rel_path AS new_path,
                       m.asset_id, m.volume_id, m.file_index
                FROM file m
                JOIN file n
                  ON n.root_id    = m.root_id
                 AND n.size_bytes = m.size_bytes
                 AND n.mtime_ns   = m.mtime_ns
                 AND n.id        <> m.id
                WHERE m.root_id = ?
                  AND m.state   = 'missing'
                  AND m.asset_id IS NOT NULL
                  AND n.state   = 'queued'
                  AND n.asset_id IS NULL
                """,
                (root_id,),
            ).fetchall()

            moved = 0
            root_path = cur.execute(
                "SELECT path FROM root WHERE id = ?", (root_id,)
            ).fetchone()[0]

            for row in pairs:
                if not self._same_file(root_path, row):
                    continue
                # Adopt the new path onto the row that already carries the
                # asset link and history, then drop the freshly-discovered
                # duplicate row. The asset, and therefore every tag, colour and
                # OCR line, is untouched.
                cur.execute("DELETE FROM file WHERE id = ?", (row["new_id"],))
                cur.execute(
                    "UPDATE file SET rel_path = ?, parent_rel = ?, name = ?, "
                    "state = 'indexed', last_seen_at = unixepoch(), "
                    "state_reason = 'moved' WHERE id = ?",
                    (
                        row["new_path"],
                        os.path.dirname(row["new_path"]),
                        os.path.basename(row["new_path"]),
                        row["missing_id"],
                    ),
                )
                moved += 1
            return moved

        return self.writer.call(job)

    @staticmethod
    def _same_file(root_path: str, row) -> bool:
        """Confirm a candidate pair by filesystem identity when we can."""
        recorded_vol, recorded_idx = row["volume_id"], row["file_index"]
        if not recorded_idx:
            return True  # size+mtime is all we have; stage 1 will verify
        try:
            st = safety.stat_ro(os.path.join(root_path, row["new_path"]))
        except OSError:
            return False
        vol, idx = safety.file_identity(st)
        return idx == recorded_idx and (recorded_vol is None or vol == recorded_vol)

    # -- bookkeeping -------------------------------------------------------

    def _begin_scan(self, root_id: int, kind: str) -> int:
        def job(cur) -> int:
            cur.execute(
                "INSERT INTO scan_run (root_id, kind) VALUES (?, ?) RETURNING id",
                (root_id, kind),
            )
            return int(cur.fetchone()[0])

        return self.writer.call(job)

    def _end_scan(self, scan_id: int, stats: ScanStats, status: str) -> None:
        self.writer.submit(
            lambda cur: cur.execute(
                "UPDATE scan_run SET finished_at = unixepoch(), status = ?, "
                "dirs_seen = ?, files_seen = ?, files_missing = ?, files_moved = ?, "
                "error = ? WHERE id = ?",
                (
                    status,
                    stats.dirs_seen,
                    stats.files_seen,
                    stats.files_missing,
                    stats.files_moved,
                    "; ".join(stats.errors[:20]) or None,
                    scan_id,
                ),
            )
        )
        self.writer.flush()

    def _report(self, stats: ScanStats) -> None:
        if self.on_progress:
            self.on_progress(stats)
