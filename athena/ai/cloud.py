"""Cloud AI providers: Anthropic, OpenAI, Google.

All three are asked for the same JSON schema and return the same `Analysis`, so
the extractors above them never branch on vendor.

What actually leaves the machine, so it can be stated plainly in the UI: a
JPEG downscaled to the configured longest edge (768px by default), or at most
`max_chars` of already-extracted document text. Never the original file, never
the path, never anything else in the library. Each unique piece of content is
sent at most once ever, because the `extractor_run` ledger is keyed to its
content hash.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

from .base import (
    ANALYSIS_SCHEMA,
    DOCUMENT_PROMPT,
    VISION_PROMPT,
    AIConfig,
    Analysis,
)


def _post(url: str, payload: dict, headers: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"{exc.code} {exc.reason}: {detail}") from exc


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


class AnthropicProvider:
    """Claude, via the official SDK.

    Two deliberate settings:

    * `output_config.effort: "low"` -- this is a high-volume, latency-sensitive
      extraction route, which is exactly the workload where low effort holds
      quality while cutting token spend. Captioning a photograph is not a hard
      reasoning problem.
    * Server-side fallbacks are enabled, so a request the safety classifiers
      decline is re-run on a fallback model inside the same call instead of
      returning nothing. Over a large personal library some images will trip a
      classifier, and one refusal should not leave a permanent hole in the
      catalogue.

    The default model is `claude-opus-5`. For bulk tagging, `claude-haiku-4-5`
    costs a fifth as much and is usually sufficient for captioning -- set
    `ATHENA_AI_MODEL=claude-haiku-4-5` if the bill matters more than nuance.
    """

    name = "anthropic"

    def __init__(self, config: AIConfig) -> None:
        self.config = config
        self.model = config.model or "claude-opus-5"
        self._client = None

    def available(self) -> str | None:
        try:
            import anthropic  # noqa: F401
        except ImportError:
            return "the `anthropic` package is not installed (pip install anthropic)"
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            return "ANTHROPIC_API_KEY is not set"
        return None

    def client(self):
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic(timeout=self.config.timeout_s)
        return self._client

    def analyse_image(self, jpeg: bytes, prompt: str = VISION_PROMPT) -> Analysis:
        return self._call([
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": base64.b64encode(jpeg).decode("ascii"),
                },
            },
            {"type": "text", "text": prompt},
        ])

    def analyse_text(self, text: str, prompt: str = DOCUMENT_PROMPT) -> Analysis:
        body = text[: self.config.max_chars]
        return self._call([{"type": "text", "text": f"{prompt}\n\n---\n{body}"}])

    def _call(self, content: list[dict]) -> Analysis:
        kwargs = dict(
            model=self.model,
            max_tokens=1024,
            messages=[{"role": "user", "content": content}],
            output_config={
                "effort": "low",
                "format": {"type": "json_schema", "schema": ANALYSIS_SCHEMA},
            },
        )
        client = self.client()
        try:
            response = client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                **kwargs,
            )
        except Exception:
            # Older accounts or platforms without the fallback beta: the
            # analysis matters more than the safety net, so retry plainly.
            response = client.messages.create(**kwargs)

        if getattr(response, "stop_reason", None) == "refusal":
            detail = getattr(response, "stop_details", None)
            raise RuntimeError(
                f"declined by safety classifier ({getattr(detail, 'category', 'unknown')})"
            )

        text = next((b.text for b in response.content if b.type == "text"), "")
        if not text.strip():
            raise ValueError("empty response")
        return Analysis.from_json(text, provider=self.name, model=self.model)


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------


class OpenAIProvider:
    name = "openai"
    URL = "https://api.openai.com/v1/chat/completions"

    def __init__(self, config: AIConfig) -> None:
        self.config = config
        self.model = config.model or "gpt-5.6-luna"

    def available(self) -> str | None:
        return None if os.environ.get("OPENAI_API_KEY") else "OPENAI_API_KEY is not set"

    def analyse_image(self, jpeg: bytes, prompt: str = VISION_PROMPT) -> Analysis:
        uri = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
        return self._call([
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": uri, "detail": "low"}},
        ])

    def analyse_text(self, text: str, prompt: str = DOCUMENT_PROMPT) -> Analysis:
        body = text[: self.config.max_chars]
        return self._call([{"type": "text", "text": f"{prompt}\n\n---\n{body}"}])

    def _call(self, content: list[dict]) -> Analysis:
        data = _post(
            self.URL,
            {
                "model": self.model,
                "messages": [{"role": "user", "content": content}],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "analysis",
                        "strict": True,
                        "schema": ANALYSIS_SCHEMA,
                    },
                },
                "max_completion_tokens": 1024,
            },
            {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
            self.config.timeout_s,
        )
        text = data["choices"][0]["message"]["content"]
        return Analysis.from_json(text, provider=self.name, model=self.model)


# ---------------------------------------------------------------------------
# Google Gemini
# ---------------------------------------------------------------------------


class GeminiProvider:
    name = "gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, config: AIConfig) -> None:
        self.config = config
        self.model = config.model or "gemini-3.1-flash"

    @staticmethod
    def _key() -> str | None:
        return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    def available(self) -> str | None:
        return None if self._key() else "GEMINI_API_KEY is not set"

    def analyse_image(self, jpeg: bytes, prompt: str = VISION_PROMPT) -> Analysis:
        return self._call([
            {"text": prompt},
            {
                "inline_data": {
                    "mime_type": "image/jpeg",
                    "data": base64.b64encode(jpeg).decode("ascii"),
                }
            },
        ])

    def analyse_text(self, text: str, prompt: str = DOCUMENT_PROMPT) -> Analysis:
        body = text[: self.config.max_chars]
        return self._call([{"text": f"{prompt}\n\n---\n{body}"}])

    def _call(self, parts: list[dict]) -> Analysis:
        # Gemini rejects `additionalProperties`, so the shared schema is
        # filtered rather than duplicated -- one schema stays the source of
        # truth for every provider.
        schema = {k: v for k, v in ANALYSIS_SCHEMA.items() if k != "additionalProperties"}
        data = _post(
            f"{self.BASE}/{self.model}:generateContent?key={self._key()}",
            {
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseSchema": schema,
                    "temperature": 0,
                    "maxOutputTokens": 1024,
                },
            },
            {},
            self.config.timeout_s,
        )
        candidates = data.get("candidates") or []
        if not candidates:
            raise RuntimeError(f"no candidates returned: {str(data)[:200]}")
        text = candidates[0]["content"]["parts"][0]["text"]
        return Analysis.from_json(text, provider=self.name, model=self.model)
