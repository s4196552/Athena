"""AI backends: one contract, several providers.

Athena can have a model actually *look at* a file -- caption a photograph, name
the objects in it, read the text on a sign, summarise a contract. That model
runs wherever the user wants it to: on their own GPU, or behind an API.

The read-only guarantee is unaffected by that choice. It has always been about
never *writing* to a source file, and a model reading bytes writes nothing.
Where those bytes are allowed to travel is a separate, user-owned setting --
`ATHENA_AI_PROVIDER=ollama` keeps everything on the machine, and a cloud
provider sends downscaled copies to that vendor. The app states which is
active; it does not decide for the user.

Every provider returns the same `Analysis`, so extractors, schema and UI are
identical no matter what is behind it. Swapping local for cloud is one
environment variable.

Two cost controls matter enough to be structural rather than optional:

* **Work is keyed to content, not paths.** The `extractor_run` ledger records
  the analysis against the asset's BLAKE3 hash, so a given image is ever
  analysed once -- re-scans, duplicates and moved files are all free. On a
  library with the usual pile of re-downloaded copies this is most of the bill.
* **Images are downscaled before they are sent.** A 24-megapixel photo and a
  768px version produce near-identical tags; one costs about forty times more
  than the other.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

#: The response shape every provider is asked to produce. Deliberately small --
#: each extra field is another thing a model can get wrong, and everything here
#: maps onto a column or a tag that the UI can actually filter by.
ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "description": {
            "type": "string",
            "description": "One plain sentence describing the content.",
        },
        "objects": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Distinct physical things visible. Lowercase singular nouns.",
        },
        "scene": {
            "type": "string",
            "description": "The setting or place, e.g. 'beach', 'office', 'kitchen'.",
        },
        "topics": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Subjects the content is about. Lowercase.",
        },
        "text": {
            "type": "string",
            "description": "Text legible in the content, verbatim. Empty string if none.",
        },
    },
    "required": ["description", "objects", "scene", "topics", "text"],
    "additionalProperties": False,
}

VISION_PROMPT = (
    "Describe this image for a searchable file library. Name the objects "
    "actually visible, the setting, the subjects it is about, and transcribe "
    "any legible text verbatim. Be concrete and literal -- these become search "
    "terms. Use an empty list or empty string when something does not apply "
    "rather than guessing."
)

DOCUMENT_PROMPT = (
    "Summarise this document for a searchable file library. Give one sentence "
    "describing what it is, the subjects it covers, and any named entities "
    "(people, organisations, products). Leave 'objects' empty and 'text' "
    "empty -- the full text is already indexed separately."
)


@dataclass(slots=True)
class Analysis:
    """Normalised result. Identical whatever produced it."""

    description: str = ""
    objects: list[str] = field(default_factory=list)
    scene: str = ""
    topics: list[str] = field(default_factory=list)
    text: str = ""
    model: str = ""
    provider: str = ""

    @classmethod
    def from_json(cls, raw: str | dict, *, provider: str, model: str) -> "Analysis":
        data = json.loads(raw) if isinstance(raw, str) else raw
        clean = lambda seq: [  # noqa: E731
            s.strip().lower() for s in (seq or []) if isinstance(s, str) and s.strip()
        ][:20]
        return cls(
            description=str(data.get("description") or "").strip(),
            objects=clean(data.get("objects")),
            scene=str(data.get("scene") or "").strip().lower(),
            topics=clean(data.get("topics")),
            text=str(data.get("text") or "").strip(),
            provider=provider,
            model=model,
        )

    @property
    def source_id(self) -> str:
        """Provenance recorded on every tag, so the UI can show what made it."""
        return f"{self.provider}:{self.model}"

    def is_empty(self) -> bool:
        return not (self.description or self.objects or self.topics or self.text)


class Provider(Protocol):
    name: str
    model: str

    def available(self) -> str | None:
        """Return None when usable, else a human reason why not."""
        ...

    def analyse_image(self, jpeg: bytes, prompt: str = VISION_PROMPT) -> Analysis: ...

    def analyse_text(self, text: str, prompt: str = DOCUMENT_PROMPT) -> Analysis: ...


@dataclass(slots=True)
class AIConfig:
    """Resolved from the environment. One place, so the UI can display it."""

    provider: str = "none"
    model: str = ""
    #: Longest edge an image is resized to before being sent anywhere.
    image_px: int = 768
    #: Characters of document text sent for summarisation.
    max_chars: int = 6000
    #: Hard ceiling on analyses per engine run. A runaway loop over a 100k
    #: library is the failure mode that produces an unpleasant invoice, so the
    #: default is deliberately small and must be raised on purpose.
    max_files: int = 500
    timeout_s: float = 90.0

    @classmethod
    def from_env(cls) -> "AIConfig":
        provider = (os.environ.get("ATHENA_AI_PROVIDER") or "none").strip().lower()
        return cls(
            provider=provider,
            model=(os.environ.get("ATHENA_AI_MODEL") or DEFAULT_MODELS.get(provider, "")),
            image_px=int(os.environ.get("ATHENA_AI_IMAGE_PX", 768)),
            max_chars=int(os.environ.get("ATHENA_AI_MAX_CHARS", 6000)),
            max_files=int(os.environ.get("ATHENA_AI_MAX_FILES", 500)),
            timeout_s=float(os.environ.get("ATHENA_AI_TIMEOUT", 90)),
        )


#: Sensible default per backend.
#:
#: The Ollama default is chosen for a 6 GB laptop GPU: qwen2.5vl:3b quantised
#: is roughly 3 GB of VRAM, which leaves room for the display and the rest of
#: the pipeline. Anything larger will spill to system RAM and crawl.
#: `gateway` is deliberately absent: the gateway owns its own allowlist and
#: budget, so it -- not this client -- decides which model a shared token is
#: allowed to spend. An empty model here means "whatever the gateway prefers",
#: and `GatewayProvider.available()` adopts whatever it answers with.
DEFAULT_MODELS: dict[str, str] = {
    "ollama": "qwen2.5vl:3b",
    "anthropic": "claude-opus-5",
    "openai": "gpt-5.6-luna",
    "gemini": "gemini-3.1-flash",
}


def get_provider(config: AIConfig | None = None) -> Provider | None:
    """Build the configured provider, or None when AI is switched off."""
    cfg = config or AIConfig.from_env()
    if cfg.provider in ("none", "", "off"):
        return None

    if cfg.provider == "ollama":
        from .local import OllamaProvider

        # The host is configurable so "local model" can mean a machine on the
        # network -- a workstation with a GPU, or a container on a platform
        # like Railway -- rather than only this one. `OllamaProvider` always
        # accepted a host; nothing ever passed one, so it was pinned to
        # localhost by omission.
        return OllamaProvider(cfg, host=os.environ.get("ATHENA_OLLAMA_HOST"))
    if cfg.provider == "gateway":
        from .gateway import GatewayProvider

        return GatewayProvider(cfg)
    if cfg.provider == "anthropic":
        from .cloud import AnthropicProvider

        return AnthropicProvider(cfg)
    if cfg.provider == "openai":
        from .cloud import OpenAIProvider

        return OpenAIProvider(cfg)
    if cfg.provider == "gemini":
        from .cloud import GeminiProvider

        return GeminiProvider(cfg)
    raise ValueError(f"unknown ATHENA_AI_PROVIDER {cfg.provider!r}")


def encode_image(path: str, max_px: int) -> bytes:
    """Downscale to `max_px` on the longest edge and re-encode as JPEG.

    Uniform JPEG output means every provider gets a media type it accepts, and
    the resize is the single biggest cost lever: tokens scale with pixels, and
    beyond ~768px tagging quality stops improving.
    """
    from PIL import Image, ImageOps

    from ..core.safety import reader_for

    with Image.open(reader_for(path)) as img:
        img = ImageOps.exif_transpose(img)
        if getattr(img, "is_animated", False):
            img.seek(0)
        img = img.convert("RGB")
        img.thumbnail((max_px, max_px), Image.LANCZOS)
        import io

        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=82, optimize=True)
        return buf.getvalue()
