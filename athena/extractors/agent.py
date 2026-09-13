"""Where the agent is triggered.

Two extractors, in two tiers, and the split is the design:

* `agent.inspect` (Tier.CHEAP) runs on **every** parsed file, immediately
  after the parsers, over the text and metadata they just produced. No
  network, no model, a few milliseconds. It writes the doctype, topic, author,
  date, patterns and entities that the filter rail and the graph are built on.

* `agent.classify` (Tier.ML) runs only on the files `agent.inspect` said it
  was **unsure** about, and only when an AI provider is configured. It asks
  the model the one question the rules could not answer, and folds the answer
  into the existing verdict rather than replacing it.

The ordering inside the cheap tier is explicit (`order = 60`), not a
consequence of the alphabet. `agent.inspect` reads `out.rows["text_block"]`,
so it must run after `doc.pdf`, `doc.docx`, `doc.pptx` and `image.ocr` have
filled it -- and "agent" sorts *before* "doc", which would have produced an
agent that confidently classified every document as having no text. See the
`order` docstring in `base.py`.
"""

from __future__ import annotations

from os.path import basename
from pathlib import Path
from typing import ClassVar

from ..agent import patterns as pat
from ..agent import taxonomy as tax
from ..agent.inspect import Evidence, Verdict, classify_prompt, inspect, merge_model_answer
from ..core.facets import Facets
from .base import BaseExtractor, ExtractContext, SkipExtractor, Tier, register

#: Facet rows the agent reads for embedded metadata, in the order it trusts
#: them. `doc_meta` is authoritative for documents; the media tables carry the
#: equivalent fields for photographs and audio.
_META_TABLES = ("doc_meta", "audio_meta", "image_meta", "video_meta")

#: Cap on tags emitted per axis. A file with nine authors has no author.
MAX_ENTITIES = 8


def gather(ctx: ExtractContext, out: Facets) -> Evidence:
    """Assemble the agent's evidence from what the parsers already produced.

    Nothing here re-reads the file. The parsers have been over every byte
    already; asking them to hand their output along costs nothing, while a
    second pass over a 400-page PDF costs as much as the first.
    """
    blocks = out.rows.get("text_block", [])
    # OCR and AI text last: a document's own text layer is better evidence
    # than a transcription of a picture of it, and the classifier reads from
    # the front.
    ordered = sorted(
        blocks,
        key=lambda b: (
            str(b.get("source", "")).startswith(("ai_", "image_ocr", "pdf_ocr")),
            b.get("ord") or 0,
        ),
    )
    text = "\n".join(str(b.get("body", "")) for b in ordered)

    meta: dict[str, object] = {}
    for table in _META_TABLES:
        for row in out.rows.get(table, []):
            for key, value in row.items():
                meta.setdefault(key, value)

    path = Path(ctx.path)
    return Evidence(
        filename=path.name,
        # The two enclosing folders, not the whole path: `.../2024/Invoices/`
        # is evidence, while `C:/Users/someone/` is noise that would put every
        # file in the library into whatever topic their username resembles.
        rel_path="/".join(p.name for p in list(path.parents)[:2][::-1]),
        ext=ctx.ext,
        media_type=ctx.media_type,
        size_bytes=ctx.size_bytes,
        text=text,
        meta=meta,
    )


def emit(verdict: Verdict, out: Facets, source: str) -> None:
    """Turn a verdict into tags and one `agent_finding` row.

    Tags are the queryable half and go into `asset_tag`, where the existing
    facet machinery already indexes them -- so "Finance + Jane Doe" is an
    index intersection, not a new query path. The finding row is the
    explanation, read only when someone opens the detail panel.
    """
    # The vocabulary's own display forms, passed explicitly. Left to the
    # writer's fallback these become "Source-Code", "Hr" and "Cv / Resume",
    # because title-casing a slug is a guess and this module knows the answer.
    if verdict.doctype:
        out.tag("doctype", verdict.doctype, source,
                confidence=_conf(verdict.doctype_score),
                display=tax.display_of(verdict.doctype, "doctype"))
    if verdict.topic:
        out.tag("topic", verdict.topic, source,
                confidence=_conf(verdict.topic_score),
                display=tax.display_of(verdict.topic, "topic"))
    for extra in verdict.extra_topics[:3]:
        out.tag("topic", extra, source, confidence=0.4,
                display=tax.display_of(extra, "topic"))

    if verdict.author:
        # Not lowercased away: `Facets.tag` normalises the name for the
        # vocabulary key, and the writer keeps a display form alongside it, so
        # the rail shows "Jane Doe" while the filter matches "jane doe".
        out.tag("author", verdict.author, source, confidence=_author_conf(verdict))

    for year in verdict.years[:6]:
        out.tag("date", str(year), source, confidence=0.9)

    for name in verdict.patterns:
        found = pat.PATTERN_BY_NAME.get(name)
        out.tag("pattern", name, source, confidence=1.0,
                display=found.display if found else None)

    for entity in verdict.entities[:MAX_ENTITIES]:
        out.tag("entity", entity, source, confidence=0.7)
    for person in verdict.people[:MAX_ENTITIES]:
        if person != verdict.author:
            out.tag("entity", person, source, confidence=0.6)

    out.add(
        "agent_finding",
        doctype=verdict.doctype,
        doctype_score=verdict.doctype_score or None,
        topic=verdict.topic,
        topic_score=verdict.topic_score or None,
        author=verdict.author,
        author_source=verdict.author_source,
        event_at=verdict.event_at,
        event_source=verdict.event_source,
        patterns=pat.as_json(verdict.patterns) if verdict.patterns else None,
        numbers=pat.as_json(verdict.numbers) if verdict.numbers else None,
        decided_by=verdict.decided_by,
        reasoning=verdict.reasoning or None,
        escalated=int(verdict.escalated),
    )


def _conf(score: float) -> float:
    """Map an unbounded score onto 0..1 for `asset_tag.confidence`.

    Saturating rather than linear: the difference between a score of 40 and
    400 is not interesting, while the difference between 6 and 14 is the
    difference between a guess and a finding.
    """
    return round(min(1.0, 0.4 + score / 60.0), 3)


def _author_conf(verdict: Verdict) -> float:
    return {
        "metadata": 0.95,
        "id3": 0.95,
        "signature": 0.8,
        "byline": 0.8,
        "filename": 0.6,
        "email": 0.5,
    }.get(verdict.author_source or "", 0.5)


@register
class AgentInspect(BaseExtractor):
    """Look inside what the parsers found and say what the file is."""

    name: ClassVar[str] = "agent.inspect"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    #: After every parser in this tier. See the module docstring.
    order: ClassVar[int] = 60
    media_types: ClassVar[frozenset[str]] = frozenset(
        {"document", "image", "audio", "video", "other"}
    )

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        evidence = gather(ctx, out)
        verdict = inspect(evidence)
        if verdict.is_empty():
            # Nothing was learned. Recorded as `ok` all the same: the ledger
            # says the agent has seen this asset at this version, and a file
            # with genuinely no distinguishing features should not be
            # re-inspected on every scan to rediscover that.
            return
        emit(verdict, out, self.source_id)
        # Carried to the ML tier within this run when both happen to execute
        # inline (the tests, and `cli inspect`).
        ctx.shared["agent_verdict"] = verdict


@register
class AgentClassify(BaseExtractor):
    """Ask a model about the files the rules could not classify.

    This is the escalation, and it exists to be *rare*. On a real library the
    rules settle most files from their filename alone -- `invoice-4471.pdf` in
    a folder called `Invoices` needs no language model -- and the residue is
    where a model earns its cost: an untitled `scan0042.pdf`, a `notes.docx`
    with no metadata, a deck whose text is all in the images.

    It is a `Tier.ML` extractor, so it runs in the small dedicated pool behind
    the fast tiers and under the same budget ceiling as every other AI
    extractor. When no provider is configured it records `unsupported` with
    the reason and the rules verdict stands unchanged -- which is why the
    feature is complete without a key rather than broken without one.
    """

    name: ClassVar[str] = "agent.classify"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.ML
    order: ClassVar[int] = 60
    media_types: ClassVar[frozenset[str]] = frozenset({"document", "image"})

    MIN_CHARS: ClassVar[int] = 200

    def missing_dependency(self) -> str | None:
        from .ai import _resolve

        missing = super().missing_dependency()
        if missing:
            return missing
        _, reason = _resolve()
        return reason

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        from .ai import _resolve, _spend

        provider, reason = _resolve()
        if provider is None:
            raise NotImplementedError(reason or "no AI provider")

        text = str(ctx.shared.get("document_text") or "")
        if len(text) < self.MIN_CHARS:
            # No text means no question to ask. `ai.vision` already handles
            # files whose content is pixels.
            raise NotImplementedError("not enough text to classify")

        # What the cheap tier concluded, checked before anything is spent.
        #
        # Three sources, in descending order of directness: the verdict object
        # itself when both tiers ran in one process (tests, `cli inspect`), the
        # scores the claim query carried over from `agent_finding` in the
        # normal case, and a recomputation from the text as a last resort. The
        # middle one is the one that matters: without it this extractor would
        # have to escalate every file to discover which ones needed it, which
        # is the difference between a handful of model calls and 100,000.
        verdict = self._rules_verdict(ctx, text)
        if not verdict.unsure:
            raise NotImplementedError("rules were confident; nothing to escalate")

        if not _spend():
            raise SkipExtractor("AI budget for this run is exhausted")

        analysis = provider.analyse_text(text, classify_prompt(basename(ctx.path)))
        source = analysis.source_id or f"{provider.name}:{provider.model}"
        merged = merge_model_answer(verdict, analysis, source=source)
        if not merged.is_empty():
            emit(merged, out, source)

    def _rules_verdict(self, ctx: ExtractContext, text: str) -> Verdict:
        carried = ctx.shared.get("agent_verdict")
        if isinstance(carried, Verdict):
            return carried

        hints = ctx.shared.get("agent_hints")
        if isinstance(hints, dict) and hints:
            return Verdict(
                doctype=hints.get("doctype"),
                doctype_score=float(hints.get("doctype_score") or 0.0),
                topic=hints.get("topic"),
                topic_score=float(hints.get("topic_score") or 0.0),
                author=hints.get("author"),
            )

        return inspect(Evidence(
            filename=basename(ctx.path), ext=ctx.ext,
            media_type=ctx.media_type, text=text,
        ))
