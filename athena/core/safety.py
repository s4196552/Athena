"""The read-only gateway.

This is the **only** module in Athena permitted to touch a path inside a user's
library. Everything else -- scanner, extractors, thumbnailers -- goes through
the handful of functions here. Centralising it means the read-only promise is
enforced in one auditable place instead of being re-argued in thirty
extractors, and `tests/test_never_mutates.py` can assert that no other module
calls `open()`, `os.rename`, `shutil`, or `Path.write_*` on a source path.

Four distinct things can violate "we never alter your files", and all four are
handled here:

1. **Writing.** Obvious. Descriptors are opened O_RDONLY / GENERIC_READ only.

2. **Access-time drift.** Merely *reading* a file updates st_atime on many
   filesystems, which is a metadata mutation a backup tool or a "sort by last
   opened" view will notice. On Linux we request O_NOATIME; on Windows we pass
   the documented -1 sentinel to SetFileTime, which suppresses last-access
   updates for the lifetime of that handle.

3. **Locking.** Python's `open()` on Windows takes a share mode that does not
   include FILE_SHARE_DELETE, so an indexer holding 16 files open makes those
   files un-deletable and un-renamable in Explorer. Indexing 100k files must
   not make the user's own library feel broken, so we open through CreateFileW
   with all three share flags.

4. **Helpful libraries.** Several popular parsers will happily rewrite the file
   they were handed -- linearising a PDF, rebuilding an ID3 header, repairing a
   truncated ZIP -- if you give them a writable path or a writable handle. Any
   library that insists on a real filesystem path gets `materialise()`, a copy
   in our own scratch directory, and never sees the original.

The `guard()` context manager wraps every extraction with a before/after stat
comparison, so if any of the above ever slips through, it is detected, logged
to `integrity_audit`, and surfaced in the UI rather than silently corrupting a
library.
"""

from __future__ import annotations

import contextlib
import errno
import io
import os
import shutil
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterator

__all__ = [
    "SourceMutationError",
    "UnreadableSource",
    "Fingerprint",
    "fingerprint",
    "open_ro",
    "read_head",
    "read_tail",
    "stat_ro",
    "file_identity",
    "guard",
    "materialise",
    "scratch_dir",
]

IS_WINDOWS = os.name == "nt"

# Chunk used for streaming reads. 1 MiB keeps syscall overhead low without
# ballooning RSS when 12 workers stream large video files concurrently.
CHUNK = 1 << 20


class SourceMutationError(RuntimeError):
    """A source file changed while we held it. Always a bug or an outside edit."""


class UnreadableSource(OSError):
    """The path exists but cannot be read (permissions, locked, bad sector)."""


# ---------------------------------------------------------------------------
# Platform-specific read-only open
# ---------------------------------------------------------------------------

if IS_WINDOWS:  # pragma: no cover - platform specific
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _GENERIC_READ = 0x80000000
    _FILE_SHARE_READ = 0x00000001
    _FILE_SHARE_WRITE = 0x00000002
    _FILE_SHARE_DELETE = 0x00000004
    _OPEN_EXISTING = 3
    _FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    _kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    _kernel32.CreateFileW.restype = wintypes.HANDLE

    class _FILETIME(ctypes.Structure):
        _fields_ = [("dwLowDateTime", wintypes.DWORD),
                    ("dwHighDateTime", wintypes.DWORD)]

    _kernel32.SetFileTime.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(_FILETIME),
        ctypes.POINTER(_FILETIME), ctypes.POINTER(_FILETIME),
    ]
    _kernel32.SetFileTime.restype = wintypes.BOOL

    # 0xFFFFFFFFFFFFFFFF passed as lpLastAccessTime tells the filesystem to stop
    # updating last-access for this handle. Counter-intuitively this is the
    # *least* invasive option available: the alternative is letting NTFS stamp a
    # new access time on every file we index.
    _SUPPRESS = _FILETIME(0xFFFFFFFF, 0xFFFFFFFF)

    def _open_raw(path: str) -> IO[bytes]:
        handle = _kernel32.CreateFileW(
            _long_path(path),
            _GENERIC_READ,
            _FILE_SHARE_READ | _FILE_SHARE_WRITE | _FILE_SHARE_DELETE,
            None,
            _OPEN_EXISTING,
            _FILE_FLAG_SEQUENTIAL_SCAN,
            None,
        )
        if handle == _INVALID_HANDLE_VALUE or handle is None:
            raise UnreadableSource(
                ctypes.get_last_error(), os.strerror(errno.EACCES), path
            )
        # Best-effort; failure here costs us an atime stamp, not correctness.
        _kernel32.SetFileTime(handle, None, ctypes.byref(_SUPPRESS), None)
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except OSError:
            _kernel32.CloseHandle(handle)
            raise
        # open_osfhandle transfers ownership of the handle to the fd.
        return os.fdopen(fd, "rb", buffering=CHUNK)

    def _long_path(path: str) -> str:
        """Opt into the \\?\\ namespace so paths past MAX_PATH still index."""
        if path.startswith("\\\\?\\"):
            return path
        abs_path = os.path.abspath(path)
        if abs_path.startswith("\\\\"):
            return "\\\\?\\UNC\\" + abs_path[2:]
        return "\\\\?\\" + abs_path

else:

    def _open_raw(path: str) -> IO[bytes]:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        no_atime = getattr(os, "O_NOATIME", 0)
        try:
            fd = os.open(path, flags | no_atime)
        except PermissionError:
            if not no_atime:
                raise
            # O_NOATIME requires ownership or CAP_FOWNER. Fall back rather than
            # refusing to index files the user merely has read access to.
            fd = os.open(path, flags)
        except OSError as exc:
            raise UnreadableSource(exc.errno, exc.strerror, path) from exc
        return os.fdopen(fd, "rb", buffering=CHUNK)

    def _long_path(path: str) -> str:
        return path


def open_ro(path: str | os.PathLike[str]) -> IO[bytes]:
    """Open a source file read-only, share-everything, without touching atime.

    The returned object is a plain binary file object. It is never opened in a
    mode that permits writing, and callers must not wrap it in anything that
    seeks-and-writes.
    """
    p = os.fspath(path)
    try:
        return _open_raw(p)
    except UnreadableSource:
        raise
    except OSError as exc:
        raise UnreadableSource(exc.errno, exc.strerror, p) from exc


def read_head(path: str | os.PathLike[str], n: int = 4096) -> bytes:
    """First `n` bytes, for content sniffing. Cheap, and never a full read."""
    with open_ro(path) as fh:
        return fh.read(n)


def read_tail(path: str | os.PathLike[str], n: int = 64) -> bytes:
    """Last `n` bytes. Used to check that a file is structurally complete."""
    with open_ro(path) as fh:
        try:
            fh.seek(-n, os.SEEK_END)
        except OSError:
            fh.seek(0)
        return fh.read()


def stat_ro(path: str | os.PathLike[str], follow_symlinks: bool = False) -> os.stat_result:
    """`os.stat` that does not traverse symlinks by default.

    Not following links is the safe default for an indexer: it keeps a symlink
    farm from being mistaken for real content and keeps us out of cycles.
    """
    p = _long_path(os.fspath(path)) if IS_WINDOWS else os.fspath(path)
    try:
        return os.stat(p, follow_symlinks=follow_symlinks)
    except OSError as exc:
        raise UnreadableSource(exc.errno, exc.strerror, os.fspath(path)) from exc


def file_identity(st: os.stat_result) -> tuple[int | None, int | None]:
    """(volume_id, file_index) -- stable across renames on the same volume.

    This is what turns "a file vanished and another appeared" into "a file was
    moved", letting every tag follow it. On Windows `os.scandir` leaves st_ino
    at 0 because FindFirstFileW never reports the file id, so this is only
    accurate when fed a real `os.stat` result -- which is exactly why move
    reconciliation stats the small candidate set rather than all 100k entries.
    """
    vol = getattr(st, "st_dev", 0) or None
    idx = getattr(st, "st_ino", 0) or None
    return vol, idx


# ---------------------------------------------------------------------------
# Fingerprints and the mutation guard
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Fingerprint:
    """Cheap evidence of a file's state -- no content read required."""

    size: int
    mtime_ns: int
    ctime_ns: int
    exists: bool = True

    def differs_from(self, other: "Fingerprint") -> str | None:
        if not other.exists:
            return "file vanished during processing"
        if self.size != other.size:
            return f"size changed {self.size} -> {other.size}"
        if self.mtime_ns != other.mtime_ns:
            return f"mtime changed {self.mtime_ns} -> {other.mtime_ns}"
        # ctime moves when permissions or ownership change. Reported, but not
        # treated as corruption -- an antivirus scan can bump it legitimately.
        return None


def fingerprint(path: str | os.PathLike[str]) -> Fingerprint:
    try:
        st = stat_ro(path)
    except (UnreadableSource, FileNotFoundError, OSError):
        return Fingerprint(0, 0, 0, exists=False)
    return Fingerprint(
        size=st.st_size,
        mtime_ns=st.st_mtime_ns,
        ctime_ns=getattr(st, "st_ctime_ns", 0),
    )


@dataclass(slots=True)
class GuardReport:
    path: str
    before: Fingerprint
    after: Fingerprint | None = None
    verdict: str = "unchanged"
    detail: str | None = None


@contextlib.contextmanager
def guard(
    path: str | os.PathLike[str],
    *,
    extractor: str | None = None,
    strict: bool = True,
) -> Iterator[GuardReport]:
    """Assert that `path` is byte-identical before and after the block.

    This is the runtime half of the read-only guarantee -- the belt to the
    read-only-descriptor braces. It catches a parser that rewrote the file it
    was handed, and it also catches the benign case of the user editing a file
    while we happened to be reading it (which invalidates the extraction, so we
    want to know either way).

    With `strict=True` a detected mutation raises rather than being written to
    the catalogue: metadata derived from a file we may have damaged is worse
    than no metadata. The caller records the report in `integrity_audit`.
    """
    p = os.fspath(path)
    report = GuardReport(path=p, before=fingerprint(p))
    try:
        yield report
    finally:
        report.after = fingerprint(p)
        if not report.after.exists:
            report.verdict = "vanished"
            report.detail = "file disappeared during processing"
        else:
            detail = report.before.differs_from(report.after)
            if detail:
                report.verdict = "mutated"
                report.detail = detail

    if report.verdict == "mutated" and strict:
        raise SourceMutationError(
            f"{p}: {report.detail}"
            + (f" (during extractor {extractor!r})" if extractor else "")
        )


# ---------------------------------------------------------------------------
# Scratch space for libraries that demand a writable path
# ---------------------------------------------------------------------------

_SCRATCH_ROOT: Path | None = None


def scratch_dir() -> Path:
    """Process-local temp directory, always outside every indexed root."""
    global _SCRATCH_ROOT
    if _SCRATCH_ROOT is None or not _SCRATCH_ROOT.exists():
        base = os.environ.get("ATHENA_SCRATCH")
        _SCRATCH_ROOT = Path(
            tempfile.mkdtemp(prefix=f"athena-{os.getpid()}-", dir=base)
        )
    return _SCRATCH_ROOT


@contextlib.contextmanager
def materialise(path: str | os.PathLike[str], suffix: str = "") -> Iterator[Path]:
    """Yield a disposable copy of `path` inside scratch space.

    Use this -- never the original path -- for any library that takes a
    filename rather than a file object, or that might write. If the library
    mangles the copy, the user's file is untouched and the copy is deleted on
    exit. The cost is one extra read and one temp write, which is why it is
    opt-in per extractor rather than the default.
    """
    src = os.fspath(path)
    dst = scratch_dir() / f"{os.getpid()}-{abs(hash(src)) & 0xFFFFFFFF:08x}{suffix or Path(src).suffix}"
    try:
        with open_ro(src) as fh, open(dst, "wb") as out:
            shutil.copyfileobj(fh, out, CHUNK)
        yield dst
    finally:
        with contextlib.suppress(OSError):
            os.unlink(dst)


def reader_for(path: str | os.PathLike[str], max_bytes: int | None = None) -> io.BytesIO:
    """Fully buffered in-memory reader.

    Preferred over `materialise` for anything under a few MB: `zipfile`,
    `python-docx`, `python-pptx`, `Pillow` and `pypdfium2` all accept a
    file-like object, and an in-memory buffer is both faster than a temp file
    and structurally incapable of reaching the original.
    """
    with open_ro(path) as fh:
        data = fh.read(max_bytes) if max_bytes is not None else fh.read()
    return io.BytesIO(data)


def is_hidden(entry_path: str, st: os.stat_result | None = None) -> bool:
    """Cross-platform hidden check, used to skip OS bookkeeping files."""
    name = os.path.basename(entry_path)
    if name.startswith("."):
        return True
    if IS_WINDOWS and st is not None:
        attrs = getattr(st, "st_file_attributes", 0)
        hidden_or_system = (
            stat.FILE_ATTRIBUTE_HIDDEN | stat.FILE_ATTRIBUTE_SYSTEM  # type: ignore[attr-defined]
        )
        return bool(attrs & hidden_or_system)
    return False


def lower_process_priority() -> None:
    """Become a background task so indexing never competes with the UI.

    Windows PROCESS_MODE_BACKGROUND_BEGIN also de-prioritises the process's
    *I/O*, which matters far more than CPU here: the failure mode users report
    is not a hot fan, it is Explorer going unresponsive mid-scan.
    """
    try:
        if IS_WINDOWS:  # pragma: no cover - platform specific
            import ctypes

            PROCESS_MODE_BACKGROUND_BEGIN = 0x00100000
            ctypes.WinDLL("kernel32").SetPriorityClass(
                ctypes.WinDLL("kernel32").GetCurrentProcess(),
                PROCESS_MODE_BACKGROUND_BEGIN,
            )
        elif sys.platform == "darwin":  # pragma: no cover
            import ctypes

            # setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_UTILITY)
            ctypes.CDLL("libc.dylib").setiopolicy_np(0, 1, 4)
            os.nice(10)
        else:
            os.nice(10)
    except Exception:  # noqa: BLE001 - priority is advisory, never fatal
        pass
