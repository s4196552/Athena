"""The gateway provider: a shared model service instead of a personal key.

`ATHENA_AI_PROVIDER=gateway` points Athena at a deployment of
`deploy/gateway/app.py` -- a small relay that holds one vendor key and hands
out rate-limited access to it. It exists for the case a desktop app cannot
solve on its own: letting someone clone the repo and get the model-backed
features without opening an account with a model vendor.

Two things are worth being explicit about, because "send it to a server we run"
is exactly the kind of change that quietly erodes a privacy promise:

* **The read-only guarantee is untouched.** It has always been about never
  writing to a source file, and this writes nothing anywhere near the library.

* **What leaves the machine is unchanged from the direct-cloud path.** The same
  downscaled JPEG or the same `max_chars` of already-extracted text that
  `cloud.py` would have posted to the vendor. The difference is only the first
  hop: it reaches the vendor through the gateway rather than from here. That is
  a real difference -- one more operator sees the content -- which is why this
  is off unless the user selects it, and why `athena.ai.base` states plainly
  that where bytes travel is a user-owned setting.

The schema travels with the request. The gateway does not know what an
`Analysis` is, so `ANALYSIS_SCHEMA` can change here without redeploying it.
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


class GatewayProvider:
    """Talks to an Athena gateway over the same contract as every provider."""

    name = "gateway"

    def __init__(self, config: AIConfig, url: str | None = None,
                 token: str | None = None) -> None:
        self.config = config
        self.url = (url or os.environ.get("ATHENA_GATEWAY_URL") or "").rstrip("/")
        self.token = (token or os.environ.get("ATHENA_GATEWAY_TOKEN") or "").strip()
        # Empty is meaningful: it means "whatever the gateway prefers", which
        # is the sensible default because the gateway owns the budget and only
        # it knows which models it is willing to bill for.
        self.model = config.model or ""

    # -- availability ------------------------------------------------------

    def available(self) -> str | None:
        if not self.url:
            return "ATHENA_GATEWAY_URL is not set"
        if not self.token:
            return "ATHENA_GATEWAY_TOKEN is not set"
        try:
            with urllib.request.urlopen(f"{self.url}/v1/health", timeout=8) as response:
                health = json.load(response)
        except (urllib.error.URLError, OSError, ValueError):
            return f"the gateway at {self.url} is not reachable"

        if not health.get("ok"):
            return f"the gateway at {self.url} reports it is not ready"

        # Reported here rather than discovered one failed analysis at a time:
        # a gateway whose day is spent is a configuration problem the user can
        # act on, and `missing_dependency` surfaces this string in the UI.
        daily = health.get("daily") or {}
        if daily.get("limit") and daily.get("used", 0) >= daily["limit"]:
            return "the gateway's daily budget is spent; it resets at UTC midnight"

        # Adopt the gateway's model for provenance, so tags record what
        # actually produced them rather than the empty string we asked with.
        if not self.model:
            self.model = str(health.get("default_model") or "gateway")
        return None

    # -- inference ---------------------------------------------------------

    def analyse_image(self, jpeg: bytes, prompt: str = VISION_PROMPT) -> Analysis:
        return self._call({
            "kind": "image",
            "prompt": prompt,
            "image_b64": base64.b64encode(jpeg).decode("ascii"),
        })

    def analyse_text(self, text: str, prompt: str = DOCUMENT_PROMPT) -> Analysis:
        return self._call({
            "kind": "text",
            "prompt": prompt,
            "text": text[: self.config.max_chars],
        })

    def _call(self, payload: dict) -> Analysis:
        body = json.dumps({
            **payload,
            "schema": ANALYSIS_SCHEMA,
            "model": self.model or None,
        }).encode("utf-8")

        request = urllib.request.Request(
            f"{self.url}/v1/analyse",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_s) as r:
                data = json.load(r)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            # 429 is the expected, recoverable one. The extractor framework
            # records the reason against the file, so a run that outpaces the
            # gateway leaves an explanation rather than a bare failure.
            raise RuntimeError(f"{exc.code} {exc.reason}: {detail}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise RuntimeError(f"gateway unreachable: {exc}") from exc

        if not data.get("ok"):
            raise RuntimeError(str(data.get("error") or "gateway refused the request"))

        analysis = data.get("analysis")
        if not isinstance(analysis, dict):
            raise ValueError("gateway returned no analysis")

        # Provenance says `gateway:<model>` rather than `anthropic:<model>`:
        # the tag should record the route it actually came by, so someone
        # auditing a library later can tell which files went through a shared
        # service and which went straight to a vendor.
        return Analysis.from_json(
            analysis, provider=self.name, model=str(data.get("model") or self.model)
        )
