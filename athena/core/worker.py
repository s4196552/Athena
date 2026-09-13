"""Worker process entry point.

A worker is intentionally dumb and intentionally disposable. It owns no
database connection, no lock, no lease, and no state that outlives a single
task. It reads one file, returns one `TaskResult`, and can be killed at any
instant with no cleanup required.

That disposability is what makes the supervisor's watchdog safe. Media parsing
runs through large C libraries -- libav, PDFium, ONNX Runtime, libwebp -- and in
a library of 100,000 real files, some small number of them *will* find a
segfault or an infinite loop in one of those. The only reliable remedy is to
kill the process, and the only way killing is cheap is if a worker holds
nothing worth saving.

The one thing a worker announces before doing anything is *which file it is
about to touch*. That single message is what lets the supervisor attribute a
crash to the exact file that caused it, quarantine that file, and carry on --
rather than the usual outcome, where a `ProcessPoolExecutor` reports
`BrokenProcessPool`, discards the whole in-flight batch, and re-feeds the
poison file to the replacement worker until the app gives up.
"""

from __future__ import annotations

import logging
import multiprocessing as mp
import os
import queue
import signal
import time
from pathlib import Path

from ..extractors import load_all
from ..extractors.base import ExtractContext, Tier, for_context, run_all
from . import safety
from .facets import Facets, Task, TaskResult
from .identity import content_hash, is_truncated, sniff
from .states import ErrorKind

log = logging.getLogger("athena.worker")

STAGE_TIER = {"extract": Tier.CHEAP, "ml": Tier.ML}


def worker_main(
    task_q: "mp.Queue[Task | None]",
    result_q: "mp.Queue[tuple]",
    cache_dir: str,
) -> None:
    """Child process loop. Never returns normally except on shutdown."""
    # The parent handles Ctrl-C for the whole group; a worker that raises
    # KeyboardInterrupt mid-file just produces noise in the log.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    safety.lower_process_priority()
    load_all()

    pid = os.getpid()
    cache = Path(cache_dir)

    while True:
        try:
            task = task_q.get(timeout=1.0)
        except queue.Empty:
            continue
        if task is None:
            break

        # Announce before touching anything. If the next line takes the process
        # down, the supervisor still knows which file did it.
        result_q.put(("start", pid, task.file_id, time.monotonic()))
        try:
            result = process_task(task, cache)
        except BaseException as exc:  # noqa: BLE001 - a worker must never die quietly
            result = TaskResult(
                file_id=task.file_id,
                stage=task.stage,
                ok=False,
                asset_id=task.asset_id,
                error_kind=ErrorKind.INTERNAL.value,
                error_msg=f"{type(exc).__name__}: {exc}"[:500],
            )
        result_q.put(("result", pid, result))


def process_task(task: Task, cache_dir: Path) -> TaskResult:
    """Process exactly one file. Pure function of the task plus the filesystem.

    `load_all()` is called here, not only in `worker_main`, because an
    unprimed registry fails silently and expensively: `for_context` returns no
    extractors, the file is marked `indexed` having had nothing extracted, and
    the ledger records no runs to show anything was missed. Any caller that
    reaches this function -- a worker, a test, a future in-process mode -- gets
    the same behaviour. It is idempotent and free after the first call.
    """
    load_all()
    started = time.perf_counter()
    if task.stage == "identify":
        return _identify(task, started)
    return _extract(task, cache_dir, started)


# ---------------------------------------------------------------------------
# Stage 1: content identity
# ---------------------------------------------------------------------------


def _identify(task: Task, started: float) -> TaskResult:
    """Hash and type-sniff. The only stage that reads every byte.

    Runs before any parsing so that the expensive stages are dispatched per
    *asset* rather than per path. In a library with duplicates -- and every
    real library has them, from phone backups and re-downloads -- this is what
    keeps the same photograph from being OCR'd five times.
    """
    try:
        with safety.guard(task.path, extractor="identify") as report:
            head = safety.read_head(task.path, 4096)
            mime, media_type = sniff(task.path, head)
            if is_truncated(task.path, mime):
                # Rejected here rather than downstream, because several parsers
                # will "succeed" on a fragment and produce confidently wrong
                # metadata. Catching it during the stage that already reads the
                # file costs one extra 32-byte read.
                return _failure(
                    task, ErrorKind.CORRUPT,
                    f"{mime or 'file'} is missing its end-of-stream marker "
                    "(truncated or still downloading)",
                    started,
                )
            digest = content_hash(task.path, size_hint=task.size_bytes)
            size = safety.stat_ro(task.path).st_size
    except safety.SourceMutationError as exc:
        return _failure(task, ErrorKind.MUTATED, str(exc), started,
                        verdict="mutated", detail=str(exc))
    except (safety.UnreadableSource, PermissionError, OSError) as exc:
        return _failure(task, ErrorKind.UNREADABLE, str(exc), started)

    return TaskResult(
        file_id=task.file_id,
        stage="identify",
        ok=True,
        content_hash=digest,
        size_bytes=size,
        mime=mime,
        media_type=media_type,
        integrity_verdict=report.verdict,
        integrity_detail=report.detail,
        duration_ms=int((time.perf_counter() - started) * 1000),
    )


# ---------------------------------------------------------------------------
# Stage 2/3: extraction
# ---------------------------------------------------------------------------


def _extract(task: Task, cache_dir: Path, started: float) -> TaskResult:
    tier = STAGE_TIER.get(task.stage, Tier.CHEAP)
    facets = Facets()

    ctx = ExtractContext(
        path=task.path,
        media_type=task.media_type or "other",
        mime=task.mime,
        size_bytes=task.size_bytes,
        cache_dir=cache_dir,
        shared={
            "cache_key": cache_key(task.content_hash) if task.content_hash else "",
            "document_text": task.text,
            "agent_hints": task.hints,
        },
    )

    extractors = for_context(ctx, tier=tier)
    if not extractors:
        return TaskResult(
            file_id=task.file_id, stage=task.stage, ok=True,
            asset_id=task.asset_id, facets=facets,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    try:
        with safety.guard(task.path, extractor=f"stage:{task.stage}") as report:
            runs = run_all(ctx, extractors, facets, task.completed)
    except safety.SourceMutationError as exc:
        # Metadata derived from a file that changed underneath us is not
        # trustworthy, so it is discarded rather than written. The file goes
        # back on the queue and is re-read from its new contents.
        return _failure(task, ErrorKind.MUTATED, str(exc), started,
                        verdict="mutated", detail=str(exc))
    except (safety.UnreadableSource, PermissionError) as exc:
        return _failure(task, ErrorKind.UNREADABLE, str(exc), started)
    finally:
        _close_shared(ctx)

    # A file fails only when something broke *and* nothing was learned. One
    # broken EXIF block must not cost the file its thumbnail, its colours and
    # its place in the library -- but a file where every parser threw is a
    # genuine error and belongs in the Error state.
    #
    # The test is "did we produce any facets", not "did every extractor return
    # ok". Several extractors legitimately no-op on a given file -- the keyword
    # extractor finds no text in a photograph and returns successfully having
    # done nothing -- and counting those as evidence of success silently
    # promotes unreadable files to Indexed.
    errors = [r for r in runs if r.status == "error"]
    if errors and facets.is_empty():
        first = errors[0]
        return _failure(
            task,
            ErrorKind(first.error_kind) if first.error_kind else ErrorKind.CORRUPT,
            first.error_msg or "every extractor failed",
            started,
            verdict=report.verdict,
        )

    return TaskResult(
        file_id=task.file_id,
        stage=task.stage,
        ok=True,
        asset_id=task.asset_id,
        facets=facets,
        runs=runs,
        integrity_verdict=report.verdict,
        integrity_detail=report.detail,
        duration_ms=int((time.perf_counter() - started) * 1000),
    )


def _close_shared(ctx: ExtractContext) -> None:
    """Release decoder handles held across extractors within one file."""
    image = ctx.shared.pop("pil_image", None)
    if image is not None:
        try:
            image.close()
        except Exception:  # noqa: BLE001
            pass


def _failure(
    task: Task,
    kind: ErrorKind,
    message: str,
    started: float,
    *,
    verdict: str | None = None,
    detail: str | None = None,
) -> TaskResult:
    return TaskResult(
        file_id=task.file_id,
        stage=task.stage,
        ok=False,
        asset_id=task.asset_id,
        error_kind=kind.value,
        error_msg=message[:500],
        integrity_verdict=verdict,
        integrity_detail=detail,
        duration_ms=int((time.perf_counter() - started) * 1000),
    )


def cache_key(digest: str | None) -> str:
    """Content-addressed thumbnail path: `ab/cd/abcdef...webp`.

    Two levels of fan-out keeps any one directory to a few hundred entries. A
    flat directory of 100,000 thumbnails is measurably slow to enumerate on
    NTFS and makes the cache folder unopenable in Explorer.
    """
    if not digest:
        return ""
    return f"{digest[:2]}/{digest[2:4]}/{digest}.webp"
