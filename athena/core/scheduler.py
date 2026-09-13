"""The supervisor: pools, leases, watchdogs, crash attribution.

This is the answer to "what keeps the UI responsive across 100,000 files", and
it is built on four ideas.

**Tiers, not a queue.** Work is split by cost, and each tier has its own pool
sized to its own bottleneck. Hashing is I/O bound and releases the GIL, so it
runs in threads and saturates the disk. Parsing is CPU bound, so it runs in
`cpu_count - 1` processes. ML is memory bound -- each ONNX session is hundreds
of megabytes of weights -- so it runs in one or two. Running them concurrently
means the library becomes browsable in the first minute while the expensive
work continues for hours behind it.

**The database is the queue.** There is no external broker and no in-memory
work list. Workers are fed from `claim()`, which leases rows atomically. Kill
the app mid-scan and nothing is lost or duplicated: leases expire, rows become
claimable, work resumes. Recovery is the absence of code.

**Crash attribution.** Workers announce the file they are about to touch. When
a worker dies -- and over 100,000 real files, one will -- the supervisor knows
exactly which file killed it, marks that one file, and replaces the worker. The
standard `ProcessPoolExecutor` cannot do this: it surfaces `BrokenProcessPool`,
loses the whole in-flight batch, and cheerfully re-feeds the poison file to the
replacement.

**Never emit per-file events.** 100,000 progress messages will destroy any UI,
and 100,000 React re-renders is a far more common cause of "the app froze" than
any amount of indexing. The supervisor keeps counters and publishes an
aggregate snapshot a few times a second.
"""

from __future__ import annotations

import logging
import multiprocessing as mp
import os
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..db.writer import Writer
from .facets import Task, TaskResult
from .states import ErrorKind
from .worker import process_task, worker_main

log = logging.getLogger("athena.scheduler")

#: Per-file wall-clock ceilings. A wedged decoder is indistinguishable from a
#: slow one, so the only safe move is to bound it and kill on expiry.
STAGE_TIMEOUT_S = {"identify": 120, "extract": 120, "ml": 600}

#: Lease duration must comfortably exceed the timeout; otherwise a lease can
#: expire while its worker is still legitimately working, and a second worker
#: picks up the same file.
LEASE_PAD_S = 300

#: Claim this many rows per round trip. Large enough to keep the pool fed
#: across a writer batch, small enough that cancelling feels instant.
CLAIM_BATCH = 64


@dataclass
class Progress:
    """Aggregate snapshot. This, not per-file events, is what the UI consumes."""

    queued: int = 0
    indexed: int = 0
    missing: int = 0
    errored: int = 0
    in_flight: int = 0
    rate_per_s: float = 0.0
    eta_s: float | None = None
    stage: str = "idle"
    paused: bool = False


@dataclass
class _Pool:
    stage: str
    size: int
    procs: dict[int, mp.Process] = field(default_factory=dict)
    #: pid -> (file_id, started_monotonic). The crash-attribution ledger.
    in_flight: dict[int, tuple[int, float]] = field(default_factory=dict)
    task_q: "mp.Queue | None" = None
    result_q: "mp.Queue | None" = None
    outstanding: int = 0


class Supervisor:
    def __init__(
        self,
        writer: Writer,
        db_path: str,
        cache_dir: Path,
        *,
        cpu_workers: int | None = None,
        ml_workers: int = 1,
        io_threads: int = 8,
        on_progress: Callable[[Progress], None] | None = None,
        enable_ml: bool = True,
    ) -> None:
        self.writer = writer
        self.db_path = db_path
        self.cache_dir = cache_dir
        self.on_progress = on_progress
        self.enable_ml = enable_ml
        self.run_id = f"{os.getpid()}-{int(time.time())}"

        # Leave a core for the UI, the writer and the OS. Pegging every core is
        # what makes a background indexer feel like malware.
        self.cpu_workers = cpu_workers or max(1, (os.cpu_count() or 4) - 1)
        self.ml_workers = ml_workers
        self.io_threads = io_threads

        self._ctx = mp.get_context("spawn")  # required on Windows; safest elsewhere
        self._pools: dict[str, _Pool] = {}
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._threads: list[threading.Thread] = []
        self._completed = 0
        self._window: list[tuple[float, int]] = []

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        self._spawn_pool("extract", self.cpu_workers)
        if self.enable_ml:
            self._spawn_pool("ml", self.ml_workers)

        self._threads = [
            threading.Thread(target=self._identify_loop, name="athena-identify", daemon=True),
            threading.Thread(target=self._feed_loop, args=("extract",), daemon=True),
            threading.Thread(target=self._collect_loop, args=("extract",), daemon=True),
            threading.Thread(target=self._watchdog_loop, name="athena-watchdog", daemon=True),
            threading.Thread(target=self._progress_loop, name="athena-progress", daemon=True),
        ]
        if self.enable_ml:
            self._threads += [
                threading.Thread(target=self._feed_loop, args=("ml",), daemon=True),
                threading.Thread(target=self._collect_loop, args=("ml",), daemon=True),
            ]
        for t in self._threads:
            t.daemon = True
            t.start()

    def stop(self, timeout: float = 20.0) -> None:
        self._stop.set()
        for pool in self._pools.values():
            for _ in pool.procs:
                with_suppress(lambda: pool.task_q.put_nowait(None))  # type: ignore[union-attr]
        deadline = time.monotonic() + timeout
        for pool in self._pools.values():
            for proc in list(pool.procs.values()):
                proc.join(max(0.1, deadline - time.monotonic()))
                if proc.is_alive():
                    proc.terminate()
        # Hand back anything still leased so the next run picks it up at once
        # rather than waiting out the lease.
        for pool in self._pools.values():
            self.writer.release(fid for fid, _ in pool.in_flight.values())

    def pause(self) -> None:
        """Stop feeding new work. In-flight files finish; nothing is lost."""
        self._pause.set()

    def resume(self) -> None:
        self._pause.clear()

    # -- pools -------------------------------------------------------------

    def _spawn_pool(self, stage: str, size: int) -> None:
        pool = _Pool(stage=stage, size=size)
        pool.task_q = self._ctx.Queue(maxsize=size * 4)
        pool.result_q = self._ctx.Queue()
        self._pools[stage] = pool
        for _ in range(size):
            self._spawn_worker(pool)

    def _spawn_worker(self, pool: _Pool) -> None:
        proc = self._ctx.Process(
            target=worker_main,
            args=(pool.task_q, pool.result_q, str(self.cache_dir)),
            name=f"athena-{pool.stage}",
            daemon=True,
        )
        proc.start()
        pool.procs[proc.pid] = proc
        log.debug("spawned %s worker pid=%s", pool.stage, proc.pid)

    # -- stage 1: identity, in threads -------------------------------------

    def _identify_loop(self) -> None:
        """Hash and sniff in a thread pool.

        Threads rather than processes because BLAKE3's extension releases the
        GIL and the work is dominated by disk reads. Threads also avoid paying
        the ~80ms Windows `spawn` cost and the pickling round trip for what is
        a sub-millisecond unit of CPU.
        """
        with ThreadPoolExecutor(self.io_threads, thread_name_prefix="athena-io") as pool:
            while not self._stop.is_set():
                if self._pause.is_set():
                    time.sleep(0.5)
                    continue
                rows = self._claim("identify", CLAIM_BATCH)
                if not rows:
                    time.sleep(1.0)
                    continue
                tasks = [self._build_task(r, "identify") for r in rows]
                for result in pool.map(lambda t: _safe_identify(t), tasks):
                    self.writer.apply_result(result)
                    self._tick(result)

    # -- stage 2/3: feeding processes --------------------------------------

    def _feed_loop(self, stage: str) -> None:
        pool = self._pools[stage]
        while not self._stop.is_set():
            if self._pause.is_set() or pool.outstanding >= pool.size * 3:
                time.sleep(0.25)
                continue
            rows = self._claim(stage, CLAIM_BATCH)
            if not rows:
                time.sleep(1.0)
                continue
            for row in rows:
                task = self._build_task(row, stage)
                if task is None:
                    continue
                # Blocks when the pool is saturated. That backpressure is the
                # whole memory-safety story: the queue cannot grow without
                # bound, so a fast disk cannot outrun slow workers into an OOM.
                pool.task_q.put(task)  # type: ignore[union-attr]
                pool.outstanding += 1

    def _collect_loop(self, stage: str) -> None:
        pool = self._pools[stage]
        while not self._stop.is_set():
            try:
                kind, pid, *rest = pool.result_q.get(timeout=1.0)  # type: ignore[union-attr]
            except queue.Empty:
                continue

            if kind == "start":
                file_id, started = rest
                pool.in_flight[pid] = (file_id, time.monotonic())
                continue

            result: TaskResult = rest[0]
            pool.in_flight.pop(pid, None)
            pool.outstanding = max(0, pool.outstanding - 1)
            # Only the supervisor knows whether an ML pool exists, so it is the
            # one that can say whether this file is finished or owes a stage 3.
            if result.stage == "extract" and result.ok:
                result.needs_ml = self.enable_ml
            self.writer.apply_result(result)
            self._tick(result)

    # -- the watchdog ------------------------------------------------------

    def _watchdog_loop(self) -> None:
        """Kill wedged workers, replace dead ones, blame the right file.

        Both failure modes converge on the same recovery: the file that was
        in flight is marked with a specific, retryable error, and a fresh
        worker takes the dead one's place. Because the worker held no lock,
        no transaction and no lease of its own, killing it costs nothing.
        """
        while not self._stop.wait(2.0):
            now = time.monotonic()
            for pool in self._pools.values():
                limit = STAGE_TIMEOUT_S.get(pool.stage, 300)

                for pid, (file_id, started) in list(pool.in_flight.items()):
                    if now - started <= limit:
                        continue
                    log.warning(
                        "%s worker pid=%s wedged on file %s after %.0fs; killing",
                        pool.stage, pid, file_id, now - started,
                    )
                    self._kill(pool, pid, file_id, ErrorKind.TIMEOUT,
                               f"exceeded {limit}s in stage {pool.stage}")

                for pid, proc in list(pool.procs.items()):
                    if proc.is_alive():
                        continue
                    entry = pool.in_flight.pop(pid, None)
                    if entry:
                        file_id, _ = entry
                        log.warning(
                            "%s worker pid=%s died (exit=%s) on file %s",
                            pool.stage, pid, proc.exitcode, file_id,
                        )
                        self._blame(file_id, pool.stage, ErrorKind.WORKER_CRASH,
                                    f"worker exited with {proc.exitcode}")
                        pool.outstanding = max(0, pool.outstanding - 1)
                    pool.procs.pop(pid, None)
                    if not self._stop.is_set():
                        self._spawn_worker(pool)

    def _kill(self, pool: _Pool, pid: int, file_id: int, kind: ErrorKind, msg: str) -> None:
        proc = pool.procs.get(pid)
        if proc is not None and proc.is_alive():
            proc.terminate()
            proc.join(5.0)
            if proc.is_alive():  # SIGTERM ignored inside a C call
                proc.kill()
        pool.in_flight.pop(pid, None)
        pool.outstanding = max(0, pool.outstanding - 1)
        self._blame(file_id, pool.stage, kind, msg)
        # The dead worker is reaped and replaced by the liveness sweep above.

    def _blame(self, file_id: int, stage: str, kind: ErrorKind, msg: str) -> None:
        self.writer.apply_result(
            TaskResult(file_id=file_id, stage=stage, ok=False,
                       error_kind=kind.value, error_msg=msg)
        )

    # -- claiming and progress --------------------------------------------

    def _claim(self, stage: str, limit: int):
        lease = STAGE_TIMEOUT_S.get(stage, 300) + LEASE_PAD_S
        try:
            return self.writer.claim(stage, f"{self.run_id}:{stage}", limit, lease)
        except TimeoutError:
            log.warning("claim timed out for stage %s", stage)
            return []

    def _build_task(self, row: dict, stage: str) -> Task:
        """Assemble a task that needs nothing else to execute.

        `rel_path` is stored POSIX-separated so the catalogue is portable
        between platforms; `os.path.join` with the root puts the native
        separators back on the way out.
        """
        rel = row["rel_path"].replace("/", os.sep)
        return Task(
            file_id=row["id"],
            path=os.path.join(row["root_path"], rel),
            stage=stage,
            size_bytes=row["size_bytes"] or 0,
            asset_id=row["asset_id"],
            content_hash=row.get("content_hash"),
            mime=row.get("mime"),
            media_type=row.get("media_type"),
            completed=row.get("completed") or {},
            cache_dir=str(self.cache_dir),
            text=row.get("text") or "",
            hints=row.get("hints") or {},
        )

    def _tick(self, result: TaskResult) -> None:
        self._completed += 1
        self._window.append((time.monotonic(), 1))

    def _progress_loop(self) -> None:
        """Publish an aggregate snapshot ~4x a second. Never per file."""
        from ..db.connection import connect_ro

        conn = connect_ro(self.db_path)
        try:
            while not self._stop.wait(0.25):
                if self.on_progress is None:
                    continue
                cutoff = time.monotonic() - 10.0
                self._window = [(t, n) for t, n in self._window if t >= cutoff]
                rate = sum(n for _, n in self._window) / 10.0

                counts = {
                    row["state"]: row["n"]
                    for row in conn.execute("SELECT state, n FROM v_state_counts")
                }
                in_flight = sum(len(p.in_flight) for p in self._pools.values())
                queued = counts.get("queued", 0)
                self.on_progress(Progress(
                    queued=queued,
                    indexed=counts.get("indexed", 0),
                    missing=counts.get("missing", 0),
                    errored=counts.get("error", 0),
                    in_flight=in_flight,
                    rate_per_s=round(rate, 1),
                    eta_s=round(queued / rate, 0) if rate > 0.1 and queued else None,
                    stage="indexing" if queued else "idle",
                    paused=self._pause.is_set(),
                ))
        finally:
            conn.close()


def _safe_identify(task: Task) -> TaskResult:
    """Stage 1 runs in-process, so it must never let an exception escape."""
    try:
        return process_task(task, Path(task.cache_dir or "."))
    except BaseException as exc:  # noqa: BLE001
        return TaskResult(
            file_id=task.file_id, stage=task.stage, ok=False,
            error_kind=ErrorKind.INTERNAL.value,
            error_msg=f"{type(exc).__name__}: {exc}"[:500],
        )


def with_suppress(fn: Callable[[], object]) -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001
        pass
