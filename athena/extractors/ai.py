"""AI extractors: have a model read the file.

These are what close the "Objects & Places" requirement, and they do more than
that -- an AI caption is *searchable text*. Once a photograph carries
"a golden retriever running on a beach at sunset", the existing FTS5 index
makes it findable by typing "dog beach", with no embeddings, no vector store
and no new query path. The cheapest semantic search is a caption.

Both extractors sit in `Tier.ML`, so they run in the small dedicated pool
behind the fast tiers: the library is browsable within seconds while these fill
in over minutes.

Provider is chosen by the user through `ATHENA_AI_PROVIDER`. When it is unset,
or the key is missing, or Ollama is not running, they record `skipped` with the
reason rather than `error` -- a lean install should degrade to fewer facets,
never to a library full of red rows.
"""

from __future__ import annotations

import threading
from typing import ClassVar

from ..ai.base import AIConfig, Analysis, encode_image, get_provider
from ..core.facets import Facets
from .base import BaseExtractor, ExtractContext, SkipExtractor, Tier, register

#: Per-process singletons. Building a provider is cheap, but `available()`
#: makes a network call, and re-checking it for every one of 100k files would
#: dominate the runtime.
_provider = None
_availability: str | None = "unchecked"
_lock = threading.Lock()

#: Analyses performed by this worker process, against `AIConfig.max_files`.
#: A bound that must be raised deliberately is the difference between a demo
#: and a surprise invoice.
_budget_used = 0


def _resolve():
    """(provider, reason_unavailable). Probed once per worker process."""
    global _provider, _availability
    with _lock:
        if _availability == "unchecked":
            config = AIConfig.from_env()
            try:
                _provider = get_provider(config)
            except ValueError as exc:
                _provider, _availability = None, str(exc)
                return None, _availability
            if _provider is None:
                _availability = "AI is off (set ATHENA_AI_PROVIDER)"
            else:
                _availability = _provider.available()
        return _provider, _availability


def _spend() -> bool:
    global _budget_used
    with _lock:
        if _budget_used >= AIConfig.from_env().max_files:
            return False
        _budget_used += 1
        return True


class _AIExtractor(BaseExtractor):
    """Shared plumbing: availability, budget, and writing facets."""

    tier: ClassVar[int] = Tier.ML

    def missing_dependency(self) -> str | None:
        # Reuses the framework's dependency path, so an unconfigured provider
        # shows up as `skipped` with a readable reason instead of an error.
        missing = super().missing_dependency()
        if missing:
            return missing
        _, reason = _resolve()
        return reason

    @staticmethod
    def emit(analysis: Analysis, out: Facets, text_source: str) -> None:
        if analysis.is_empty():
            return
        source = analysis.source_id

        # The caption goes into the same FTS index as document text, which is
        # what makes natural-language search work without any new machinery.
        if analysis.description:
            out.text(text_source, analysis.description)

        # Text the model read in the image is kept separate from the caption:
        # one is a transcription, the other an interpretation, and conflating
        # them makes a search hit impossible to explain in the UI.
        if analysis.text:
            out.text("ai_ocr", analysis.text)

        for name in analysis.objects:
            out.tag("object", name, source, confidence=0.8)
        if analysis.scene:
            out.tag("scene", analysis.scene, source, confidence=0.8)

        # `topic` is a closed axis -- it is a filter group in the rail and a
        # node kind in the graph, and both stop working if a model is allowed
        # to invent buckets. A vision model asked for topics returns "sunset",
        # "coastline" and "golden hour" for one photograph, which is three
        # single-item filters nobody will ever click.
        #
        # So a returned label either resolves onto the agent's vocabulary and
        # becomes a topic, or it is kept as a `keyword` -- still searchable,
        # still shown, just not pretending to be a facet.
        from ..agent.taxonomy import match

        for topic in analysis.topics:
            resolved = match(topic, axis="topic")
            if resolved:
                out.tag("topic", resolved, source, confidence=0.7)
            else:
                out.tag("keyword", topic, source, confidence=0.6)


@register
class AIVision(_AIExtractor):
    """Look at an image: caption it, name the objects, read the text."""

    name: ClassVar[str] = "ai.vision"
    version: ClassVar[int] = 1
    media_types: ClassVar[frozenset[str]] = frozenset({"image"})
    requires: ClassVar[tuple[str, ...]] = ("PIL",)
    max_bytes: ClassVar[int] = 128 * 1024 * 1024

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        provider, reason = _resolve()
        if provider is None:
            raise NotImplementedError(reason or "no AI provider")
        if not _spend():
            raise SkipExtractor("AI budget for this run is exhausted")

        config = AIConfig.from_env()
        jpeg = encode_image(ctx.path, config.image_px)
        self.emit(provider.analyse_image(jpeg), out, "ai_caption")


@register
class AIDocument(_AIExtractor):
    """Summarise a document from the text the cheap tier already extracted.

    Runs on text, not on the file, so it costs a fraction of sending pages as
    images -- and it depends on `doc.pdf` / `doc.docx` / `doc.pptx` having run
    first, which the tier ordering guarantees.
    """

    name: ClassVar[str] = "ai.document"
    version: ClassVar[int] = 1
    media_types: ClassVar[frozenset[str]] = frozenset({"document"})

    MIN_CHARS: ClassVar[int] = 150

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        provider, reason = _resolve()
        if provider is None:
            raise NotImplementedError(reason or "no AI provider")

        blocks = ctx.shared.get("document_text") or ""
        if len(blocks) < self.MIN_CHARS:
            raise NotImplementedError("no extracted text to summarise")
        if not _spend():
            raise SkipExtractor("AI budget for this run is exhausted")

        self.emit(provider.analyse_text(blocks), out, "ai_summary")
