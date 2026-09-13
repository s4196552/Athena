"""The indexing state machine.

Four public states, exactly as the product spec requires. The important design
decision is what is *not* here: there is no `Processing` state.

A row being worked on is still `QUEUED`, with `lease_owner` and
`lease_expires_at` set. That single choice removes a whole class of bug. With a
`Processing` state, every hard kill -- power loss, OOM killer, a user force-
quitting mid-scan -- leaves rows stranded in it, and the app needs a startup
sweep that cannot distinguish "stranded from last run" from "being worked on by
the instance that is still running". With leases, a crashed run's claims simply
expire and the rows are claimable again. Recovery is the absence of code.

`ERROR` is likewise not terminal. Errors carry an `attempts` counter and are
retried when their cause plausibly changed: a new extractor version shipped, a
missing codec got installed, or the user asked. A file that failed because
ffmpeg was not installed should heal itself once ffmpeg is.
"""

from __future__ import annotations

from enum import Enum
from typing import Final


class FileState(str, Enum):
    QUEUED = "queued"
    INDEXED = "indexed"
    MISSING = "missing"
    ERROR = "error"

    def __str__(self) -> str:  # so f-strings and sqlite params yield the raw value
        return self.value


class ErrorKind(str, Enum):
    """Why a file failed. Drives both retry policy and the UI's phrasing."""

    UNREADABLE = "unreadable"          # permissions, locked, I/O error
    CORRUPT = "corrupt"                # parser rejected the bytes
    UNSUPPORTED = "unsupported"        # recognised, no extractor for it
    ENCRYPTED = "encrypted"            # password-protected PDF/Office file
    TIMEOUT = "timeout"                # watchdog killed a wedged worker
    WORKER_CRASH = "worker_crash"      # native decoder took the process down
    TOO_LARGE = "too_large"            # above the configured size ceiling
    MUTATED = "mutated"                # changed under us; result discarded
    DEPENDENCY = "dependency"          # optional library or model not installed
    INTERNAL = "internal"              # our bug

    def __str__(self) -> str:
        return self.value


#: Kinds worth retrying automatically on the next scan -- their cause is
#: environmental and may have gone away. The rest need a version bump or an
#: explicit user retry, because re-running them would just burn CPU.
RETRYABLE: Final[frozenset[ErrorKind]] = frozenset({
    ErrorKind.UNREADABLE,
    ErrorKind.TIMEOUT,
    ErrorKind.WORKER_CRASH,
    ErrorKind.DEPENDENCY,
    ErrorKind.MUTATED,
})

#: After this many failures a file stops being retried automatically. It stays
#: visible in the UI as an error with its reason, and the user can force a
#: retry. The point is to stop one poison file from consuming a worker forever.
MAX_ATTEMPTS: Final[int] = 3


_TRANSITIONS: Final[dict[FileState, frozenset[FileState]]] = {
    # Discovered or re-queued -> succeeded, failed, or the path went away
    # mid-flight. Self-loop is legal: content changed again before we got to it.
    FileState.QUEUED: frozenset({
        FileState.QUEUED, FileState.INDEXED, FileState.ERROR, FileState.MISSING,
    }),
    # Indexed -> re-queued when content or extractor versions move; -> missing
    # when the path disappears; -> error only via a re-index attempt.
    FileState.INDEXED: frozenset({
        FileState.QUEUED, FileState.MISSING, FileState.ERROR, FileState.INDEXED,
    }),
    # A failed file can be retried, or vanish. It cannot jump straight to
    # indexed: success has to go through a claim so the ledger stays truthful.
    FileState.ERROR: frozenset({
        FileState.QUEUED, FileState.MISSING, FileState.ERROR,
    }),
    # Reappearing: -> INDEXED directly when reconciliation proved it is the
    # same content at a new path (the fast path that makes moves free);
    # -> QUEUED when we have to re-hash to find out.
    FileState.MISSING: frozenset({
        FileState.QUEUED, FileState.INDEXED, FileState.MISSING, FileState.ERROR,
    }),
}


def can_transition(src: FileState, dst: FileState) -> bool:
    return dst in _TRANSITIONS[src]


def assert_transition(src: FileState, dst: FileState) -> None:
    if not can_transition(src, dst):
        raise ValueError(f"illegal state transition {src.value} -> {dst.value}")


def should_retry(kind: ErrorKind, attempts: int) -> bool:
    return kind in RETRYABLE and attempts < MAX_ATTEMPTS


# --- Priority bands -------------------------------------------------------
# Lower runs first. The bands are spaced so the UI can insert values between
# them without renumbering, and so "the user is looking at this right now"
# always outranks any batch work.

PRIORITY_VIEWPORT: Final[int] = 0      # visible in the UI grid this instant
PRIORITY_USER_PICK: Final[int] = 10    # explicitly requested by the user
PRIORITY_NEW: Final[int] = 50          # arrived via the filesystem watcher
PRIORITY_RECENT: Final[int] = 80       # modified in the last 30 days
PRIORITY_NORMAL: Final[int] = 100      # bulk backlog
PRIORITY_RETRY: Final[int] = 200       # previously failed; do last
PRIORITY_HUGE: Final[int] = 300        # multi-GB video; never blocks the rest
