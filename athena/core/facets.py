"""The wire format between workers and the writer.

Worker processes have **no database connection**. They receive a self-contained
task, read one file, and return a `TaskResult` -- a pure data structure. The
writer thread in the parent process is the only thing that touches SQLite.

That split buys three things at once:

* the single-writer invariant becomes structural rather than a convention;
* a worker can be killed at any instant without leaving a half-written row or
  a stranded transaction, which is what makes the watchdog safe to be violent;
* workers become trivially relocatable later -- a sandboxed subprocess, a
  different machine -- because the contract is already serialisable.

Facet rows deliberately omit `asset_id`: the worker knows the file's content
hash but not its surrogate key, and inventing a round-trip to find out would
reintroduce the coupling we just removed. Every facet table has `asset_id` as
its first column, so the writer injects it at insert time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

#: Tables a worker is permitted to emit rows into. Anything else is a bug and
#: is rejected by the writer -- this allowlist is what keeps a compromised or
#: buggy extractor from writing to `file`, `root`, or `setting`.
FACET_TABLES: frozenset[str] = frozenset({
    "image_meta",
    "video_meta",
    "audio_meta",
    "doc_meta",
    "geo",
    "color",
    "text_block",
    "embedding",
    "perceptual_hash",
    "thumbnail",
    "agent_finding",
})


@dataclass(slots=True)
class TagFact:
    """A tag to attach. The writer resolves `(kind, name)` to a tag id."""

    kind: str
    name: str
    source: str
    confidence: float = 1.0
    instances: int = 1
    #: How a human should see it. `name` is the normalised vocabulary key --
    #: lowercased, so "Jane Doe" and "jane doe" are one author and the filter
    #: is case-insensitive for free. Without a separate display form the rail
    #: would have to reconstruct it by title-casing, which turns "hr" into
    #: "Hr" and "CV / Resume" into "Cv - Resume".
    display: str | None = None


@dataclass(slots=True)
class DetectionFact:
    """One bounding box. Normalised 0..1 so it survives any later resize."""

    kind: str
    name: str
    source: str
    confidence: float
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None
    t_ms: int | None = None


@dataclass(slots=True)
class RunRecord:
    """Ledger entry: extractor E at version V has been applied to this asset."""

    extractor: str
    version: int
    status: str                    # ok | error | skipped | unsupported
    duration_ms: int = 0
    error_kind: str | None = None
    error_msg: str | None = None


@dataclass(slots=True)
class Facets:
    """Accumulator handed to each extractor."""

    rows: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    tags: list[TagFact] = field(default_factory=list)
    detections: list[DetectionFact] = field(default_factory=list)

    def add(self, table: str, **cols: Any) -> None:
        if table not in FACET_TABLES:
            raise ValueError(f"{table!r} is not a facet table")
        # Drop Nones so a later extractor filling the same 1:1 row does not
        # clobber a value an earlier one already established.
        self.rows.setdefault(table, []).append(
            {k: v for k, v in cols.items() if v is not None}
        )

    def tag(
        self,
        kind: str,
        name: str,
        source: str,
        confidence: float = 1.0,
        instances: int = 1,
        display: str | None = None,
    ) -> None:
        raw = name.strip()
        key = raw.lower()
        if key:
            self.tags.append(
                TagFact(kind, key, source, confidence, instances, display or raw)
            )

    def detect(self, fact: DetectionFact) -> None:
        self.detections.append(fact)
        # Every box also contributes to the filterable fact, so "photos with a
        # dog" is an index lookup on asset_tag and never touches `detection`.
        self.tag(fact.kind, fact.name, fact.source, fact.confidence)

    def text(
        self,
        source: str,
        body: str,
        ord: int = 0,
        *,
        lang: str | None = None,
        confidence: float | None = None,
        t_start_ms: int | None = None,
        t_end_ms: int | None = None,
    ) -> None:
        body = body.strip()
        if not body:
            return
        self.add(
            "text_block",
            source=source,
            ord=ord,
            body=body,
            lang=lang,
            confidence=confidence,
            t_start_ms=t_start_ms,
            t_end_ms=t_end_ms,
        )

    def merge(self, other: "Facets") -> None:
        for table, rows in other.rows.items():
            self.rows.setdefault(table, []).extend(rows)
        self.tags.extend(other.tags)
        self.detections.extend(other.detections)

    def is_empty(self) -> bool:
        return not (self.rows or self.tags or self.detections)


@dataclass(slots=True)
class TaskResult:
    """What a worker hands back for one file."""

    file_id: int
    stage: str                               # 'identify' | 'extract' | 'ml'
    ok: bool

    # Stage 1 output. Present only when the worker hashed the file.
    content_hash: str | None = None
    size_bytes: int | None = None
    mime: str | None = None
    media_type: str | None = None

    # Stage 2/3 output.
    asset_id: int | None = None              # echoed back from the task
    facets: Facets = field(default_factory=Facets)
    runs: list[RunRecord] = field(default_factory=list)

    #: True when the cheap tier finished but an ML pass is still owed, so the
    #: writer leaves the file claimable for stage 3 instead of marking it done.
    needs_ml: bool = False

    # Failure and audit.
    error_kind: str | None = None
    error_msg: str | None = None
    integrity_verdict: str | None = None     # unchanged | mutated | vanished
    integrity_detail: str | None = None
    duration_ms: int = 0


@dataclass(slots=True)
class Task:
    """What the supervisor hands to a worker. Fully self-contained."""

    file_id: int
    path: str
    stage: str
    size_bytes: int = 0
    asset_id: int | None = None
    content_hash: str | None = None
    mime: str | None = None
    media_type: str | None = None
    #: extractor name -> version already recorded for this asset. Lets the
    #: worker skip everything that is already current without asking the DB.
    completed: dict[str, int] = field(default_factory=dict)
    cache_dir: str = ""
    #: Text the cheap tier already extracted, carried into stage 3 so the AI
    #: document extractor can summarise without re-parsing the file -- workers
    #: have no database of their own to fetch it from.
    text: str = ""
    #: What an earlier tier concluded, carried forward the same way and for the
    #: same reason. The ML tier uses it to decide whether asking a model is
    #: worth the call: `agent.classify` escalates only files the cheap rules
    #: recorded as unsure, and without the hint it would have to escalate
    #: everything to find out which those were.
    hints: dict[str, object] = field(default_factory=dict)


def chunked(items: Iterable[Any], size: int) -> Iterable[list[Any]]:
    batch: list[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
