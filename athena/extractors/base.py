"""Extractor registry.

Every piece of metadata Athena knows how to derive is a small, independently
versioned unit. An extractor declares what it applies to, what it costs, and
what version it is; the engine does the rest.

The version number is the important field. It is the mechanism by which a
shipped model can be improved without a full re-index: bump `version`, and the
backlog query in `schema.sql` returns exactly the assets whose `extractor_run`
row is behind. On a 100k-item library, shipping a better OCR model re-processes
the 8,000 documents and skips the other 92,000, and it does so *per extractor*
-- EXIF, colour and thumbnails are never re-run just because OCR improved.

Extractors must obey three rules, all enforced or checked elsewhere:

1. Read only through `athena.core.safety`. Never call `open()` on `ctx.path`.
2. Never raise for bad input -- return what you have. A corrupt EXIF block
   should not cost the file its colours and its thumbnail.
3. Be idempotent. The same input produces the same facets, because a re-run
   overwrites rather than accumulates.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, ClassVar, Iterable, Protocol, runtime_checkable

from ..core.facets import Facets, RunRecord
from ..core.states import ErrorKind

log = logging.getLogger("athena.extractors")


class SkipExtractor(Exception):
    """Not now -- try again later.

    Distinct from `NotImplementedError`, which means "this extractor genuinely
    does not apply to this content" and is recorded as `unsupported`. The
    difference is load-bearing: `claim()` treats `unsupported` as *done at this
    version*, so a temporary condition recorded that way would never be
    retried. A budget that ran out, or a provider that was briefly down, must
    stay eligible for the next run.
    """


class Tier:
    """Cost classes. The scheduler gives each tier its own worker pool."""

    IDENTITY = 1   # hash + sniff. I/O bound; threads.
    CHEAP = 2      # EXIF, tags, dimensions, text, colour. CPU-light; processes.
    ML = 3         # OCR, detection, embeddings, transcription. Heavy; few processes.


@dataclass(slots=True)
class ExtractContext:
    """Everything an extractor is allowed to know. Notably: no DB handle."""

    path: str
    media_type: str
    mime: str | None
    size_bytes: int
    cache_dir: Path
    #: Shared scratch space for decoded intermediates within one file's run, so
    #: the OCR extractor can reuse the page rasters the PDF extractor produced
    #: instead of decoding the document a second time.
    shared: dict[str, object] = field(default_factory=dict)

    @property
    def ext(self) -> str:
        return Path(self.path).suffix.lstrip(".").lower()


@runtime_checkable
class Extractor(Protocol):
    name: ClassVar[str]
    version: ClassVar[int]
    tier: ClassVar[int]
    order: ClassVar[int]
    media_types: ClassVar[frozenset[str]]

    def supports(self, ctx: ExtractContext) -> bool: ...
    def run(self, ctx: ExtractContext, out: Facets) -> None: ...


class BaseExtractor:
    name: ClassVar[str] = "base"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    #: Run order within a tier. Lower runs first.
    #:
    #: Most extractors are independent and leave this at 0. Two are not: the
    #: keyword extractor and the inspection agent both read the text blocks
    #: that the document and OCR extractors put into the shared `Facets`, so
    #: they have to run after them. That used to work by accident -- the
    #: registry sorted by name, and "text.keywords" happens to sort after
    #: "doc.pdf" and "image.ocr". An extractor named `agent.*` or `ai.*` would
    #: have silently broken it by sorting first and seeing no text at all, with
    #: no error: just empty tags on every file.
    order: ClassVar[int] = 0
    media_types: ClassVar[frozenset[str]] = frozenset()
    #: Optional imports this extractor needs. Missing ones produce a `skipped`
    #: ledger entry rather than an error, so a lean install degrades to fewer
    #: facets instead of a library full of red rows.
    requires: ClassVar[tuple[str, ...]] = ()
    #: Files above this are skipped outright -- a 12 GB video has nothing to
    #: gain from a document parser and everything to lose from trying.
    max_bytes: ClassVar[int] = 0

    def supports(self, ctx: ExtractContext) -> bool:
        if ctx.media_type not in self.media_types:
            return False
        if self.max_bytes and ctx.size_bytes > self.max_bytes:
            return False
        return True

    def run(self, ctx: ExtractContext, out: Facets) -> None:  # pragma: no cover
        raise NotImplementedError

    @property
    def source_id(self) -> str:
        """Provenance string recorded on every tag this extractor produces."""
        return f"{self.name}@{self.version}"

    def missing_dependency(self) -> str | None:
        import importlib.util

        for mod in self.requires:
            if importlib.util.find_spec(mod) is None:
                return mod
        return None


_REGISTRY: dict[str, BaseExtractor] = {}


def register(cls: type[BaseExtractor]) -> type[BaseExtractor]:
    inst = cls()
    if inst.name in _REGISTRY:
        raise ValueError(f"duplicate extractor name {inst.name!r}")
    _REGISTRY[inst.name] = inst
    return cls


def all_extractors() -> list[BaseExtractor]:
    return sorted(_REGISTRY.values(), key=lambda e: (e.tier, e.order, e.name))


def for_context(ctx: ExtractContext, tier: int | None = None) -> list[BaseExtractor]:
    return [
        e for e in all_extractors()
        if (tier is None or e.tier == tier) and e.supports(ctx)
    ]


def current_versions() -> dict[str, int]:
    """`{name: version}` -- compared against `extractor_run` to find the backlog."""
    return {e.name: e.version for e in _REGISTRY.values()}


def run_all(
    ctx: ExtractContext,
    extractors: Iterable[BaseExtractor],
    out: Facets,
    completed: dict[str, int],
    *,
    on_timeout_check: Callable[[], None] | None = None,
) -> list[RunRecord]:
    """Run a sequence of extractors, isolating each one's failures.

    The isolation is the point. A file that trips a bug in the PDF text layer
    still gets its size, its page count, its thumbnail and its OCR -- and the
    ledger records precisely which extractor failed and why, so the next
    version of that one extractor can retry just those assets.
    """
    records: list[RunRecord] = []

    for ex in extractors:
        if completed.get(ex.name, -1) >= ex.version:
            continue

        missing = ex.missing_dependency()
        if missing:
            records.append(RunRecord(
                ex.name, ex.version, "skipped",
                error_kind=ErrorKind.DEPENDENCY.value,
                error_msg=f"{missing} not installed",
            ))
            continue

        started = time.perf_counter()
        try:
            if on_timeout_check:
                on_timeout_check()
            ex.run(ctx, out)
            status, kind, msg = "ok", None, None
        except SkipExtractor as exc:
            status, kind, msg = "skipped", ErrorKind.DEPENDENCY.value, str(exc)[:500]
        except NotImplementedError as exc:
            status, kind, msg = "unsupported", ErrorKind.UNSUPPORTED.value, str(exc)[:500] or None
        except MemoryError:
            # Never swallow this one: the process is compromised and the
            # supervisor needs to recycle it.
            raise
        except Exception as exc:  # noqa: BLE001
            status = "error"
            kind = _classify(exc).value
            msg = f"{type(exc).__name__}: {exc}"[:500]
            log.debug("extractor %s failed on %s", ex.name, ctx.path, exc_info=True)

        records.append(RunRecord(
            ex.name,
            ex.version,
            status,
            duration_ms=int((time.perf_counter() - started) * 1000),
            error_kind=kind,
            error_msg=msg,
        ))

    return records


def _classify(exc: BaseException) -> ErrorKind:
    name = type(exc).__name__.lower()
    text = str(exc).lower()
    if isinstance(exc, PermissionError):
        return ErrorKind.UNREADABLE
    if isinstance(exc, FileNotFoundError):
        return ErrorKind.UNREADABLE
    if "password" in text or "encrypt" in text or "decrypt" in text:
        return ErrorKind.ENCRYPTED
    if isinstance(exc, (ValueError, EOFError, OSError)) or "truncat" in text:
        return ErrorKind.CORRUPT
    if "import" in name or "module" in text:
        return ErrorKind.DEPENDENCY
    return ErrorKind.CORRUPT
