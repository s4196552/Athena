"""Local AI via Ollama.

Ollama rather than raw ONNX Runtime, for one reason: a vision-language model
needs an image processor, a tokenizer, a chat template and a sampling loop, and
hand-wiring those against an ONNX graph is a day of work that produces exactly
what `ollama pull` produces in ninety seconds. ONNX is the right answer for a
fixed-purpose model with a known preprocessing pipeline -- OCR, embeddings, a
detector. For "a model that looks at a picture and answers", Ollama wins.

It also speaks structured outputs: passing a JSON schema as `format` constrains
generation, so the same schema drives local and cloud alike and the parsing
code has one path.

Sizing for a 6 GB laptop GPU: keep the model under ~3.5 GB so the display,
the browser and the rest of the pipeline still have room. qwen2.5vl:3b fits
comfortably; a 7B vision model does not and will spill into system RAM, where
it runs perhaps twenty times slower.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request

from .base import (
    ANALYSIS_SCHEMA,
    DOCUMENT_PROMPT,
    VISION_PROMPT,
    AIConfig,
    Analysis,
)

DEFAULT_HOST = "http://localhost:11434"


class OllamaProvider:
    name = "ollama"

    def __init__(self, config: AIConfig, host: str | None = None) -> None:
        self.config = config
        self.model = config.model or "qwen2.5vl:3b"
        self.host = (host or DEFAULT_HOST).rstrip("/")

    # -- availability ------------------------------------------------------

    def available(self) -> str | None:
        try:
            with urllib.request.urlopen(f"{self.host}/api/tags", timeout=3) as r:
                tags = json.load(r)
        except (urllib.error.URLError, OSError):
            return (
                f"Ollama is not reachable at {self.host} "
                "(install from ollama.com, then `ollama serve`)"
            )
        names = {m.get("name", "") for m in tags.get("models", [])}
        # Ollama reports "qwen2.5vl:3b"; a user may have configured it without
        # the tag, so match on the stem too.
        if not any(n == self.model or n.split(":")[0] == self.model.split(":")[0]
                   for n in names):
            return f"model {self.model!r} not pulled (`ollama pull {self.model}`)"
        return None

    # -- inference ---------------------------------------------------------

    def analyse_image(self, jpeg: bytes, prompt: str = VISION_PROMPT) -> Analysis:
        return self._chat(
            prompt, images=[base64.b64encode(jpeg).decode("ascii")]
        )

    def analyse_text(self, text: str, prompt: str = DOCUMENT_PROMPT) -> Analysis:
        body = text[: self.config.max_chars]
        return self._chat(f"{prompt}\n\n---\n{body}")

    def _chat(self, prompt: str, images: list[str] | None = None) -> Analysis:
        message: dict = {"role": "user", "content": prompt}
        if images:
            message["images"] = images

        payload = {
            "model": self.model,
            "messages": [message],
            # A JSON schema here constrains decoding, so the model cannot emit
            # prose around the object or invent fields. Without it, roughly one
            # response in twenty arrives wrapped in a ```json fence.
            "format": ANALYSIS_SCHEMA,
            "stream": False,
            "options": {
                "temperature": 0,      # tags should be reproducible
                "num_predict": 600,
            },
        }
        request = urllib.request.Request(
            f"{self.host}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=self.config.timeout_s) as response:
            data = json.load(response)

        content = (data.get("message") or {}).get("content") or ""
        if not content.strip():
            raise ValueError("ollama returned an empty response")
        return Analysis.from_json(content, provider=self.name, model=self.model)
