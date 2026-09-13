"""Athena AI gateway -- one API key, many demo machines.

Athena is a local application. The library, the catalogue and every parsed byte
stay on the machine that owns the files, and nothing here changes that. The one
thing that genuinely cannot live in a desktop app is a *shared secret*: ship an
API key inside the client and you have published it.

That is the whole reason this service exists. It holds the vendor key, and the
copies of Athena that talk to it hold only a gateway token that can be revoked
and rate-limited. Someone can clone the repo, set two environment variables and
get the model-backed features without opening an account.

It is deliberately a *relay*, not a reimplementation:

* The caller sends the prompt and the JSON schema it wants back. The gateway
  never parses either, so `ANALYSIS_SCHEMA` can change in `athena/ai/base.py`
  without redeploying this. There is no second copy of the schema to drift.
* The caller may *ask* for a model; the gateway clamps that to its own
  allowlist. Otherwise a shared token becomes a way to spend someone else's
  money on the most expensive model available.

What reaches this service is exactly what `athena/ai/cloud.py` would have sent
to the vendor directly: a JPEG downscaled to the configured longest edge, or at
most `max_chars` of already-extracted document text. Never an original file,
never a path, never anything else in the library. Request bodies are not
logged -- only their size, the outcome and the latency.

Deploying, on Railway:

    railway init
    railway variables set ANTHROPIC_API_KEY=sk-ant-...
    railway variables set ATHENA_GATEWAY_TOKEN=$(python -c "import secrets;print(secrets.token_urlsafe(32))")
    railway up

Railway injects `PORT` and terminates TLS in front of the container, so this
binds plain HTTP on 0.0.0.0 and lets the platform handle the certificate.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# -- configuration -----------------------------------------------------------

#: Models this gateway is willing to bill for, cheapest first. The client may
#: name one of these; anything else -- including nothing -- gets the first.
#: A shared token must never be able to pick the model, or the bill is set by
#: whoever is feeling most curious.
ALLOWED_MODELS: tuple[str, ...] = tuple(
    m.strip() for m in (
        os.environ.get("ATHENA_GATEWAY_MODELS")
        or "claude-haiku-4-5-20251001,claude-opus-5"
    ).split(",") if m.strip()
)
DEFAULT_MODEL = ALLOWED_MODELS[0]

#: Shared secret the clients present. Unset means the gateway refuses to start:
#: an unauthenticated relay in front of a billable key is a liability, and
#: failing loudly at boot is better than discovering it on the invoice.
TOKEN = (os.environ.get("ATHENA_GATEWAY_TOKEN") or "").strip()

#: Ceiling on generated tokens per call, regardless of what the client asks
#: for. The analyses this serves are a sentence and a few short lists.
MAX_OUTPUT_TOKENS = int(os.environ.get("ATHENA_GATEWAY_MAX_TOKENS", 1024))

#: Largest request body accepted, in bytes. A 768px JPEG is comfortably under
#: 200 KB base64; 6000 characters of text is smaller still. The cap exists so
#: a malformed or hostile client cannot make the process allocate a gigabyte.
MAX_BODY = int(os.environ.get("ATHENA_GATEWAY_MAX_BODY", 8 * 1024 * 1024))

#: Per-token burst and sustained rate. A first scan of a real library is bursty
#: -- a few hundred escalations in a couple of minutes -- and then goes quiet,
#: which is what a token bucket is for.
BURST = int(os.environ.get("ATHENA_GATEWAY_BURST", 40))
PER_MINUTE = float(os.environ.get("ATHENA_GATEWAY_PER_MINUTE", 30))

#: Global ceiling for a UTC day across every caller. This is the number that
#: actually bounds the bill, and the reason it is separate from the per-token
#: limit: ten well-behaved clients are still ten times one client.
DAILY_CAP = int(os.environ.get("ATHENA_GATEWAY_DAILY_CAP", 5000))

TIMEOUT_S = float(os.environ.get("ATHENA_GATEWAY_TIMEOUT", 90))

#: Browsers only ever call `/v1/health`, so the landing page can show whether
#: the model service is up. Analysis calls come from the desktop app, which is
#: not subject to CORS.
CORS_ORIGIN = os.environ.get("ATHENA_GATEWAY_CORS", "*")


# -- rate limiting -----------------------------------------------------------


class Bucket:
    """A token bucket, refilled continuously rather than on a fixed window.

    Fixed windows let a caller spend the whole allowance in the last second of
    one window and the whole of the next in the first second of the following
    one -- two bursts back to back at double the intended rate. Continuous
    refill has no edge to sit on.
    """

    __slots__ = ("capacity", "per_second", "tokens", "updated", "lock")

    def __init__(self, capacity: int, per_minute: float) -> None:
        self.capacity = float(capacity)
        self.per_second = per_minute / 60.0
        self.tokens = float(capacity)
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def take(self) -> bool:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(
                self.capacity, self.tokens + (now - self.updated) * self.per_second
            )
            self.updated = now
            if self.tokens < 1.0:
                return False
            self.tokens -= 1.0
            return True


class DailyCap:
    """Calls served since the last UTC midnight."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.day = self._today()
        self.used = 0
        self.lock = threading.Lock()

    @staticmethod
    def _today() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def take(self) -> bool:
        with self.lock:
            today = self._today()
            if today != self.day:
                self.day, self.used = today, 0
            if self.used >= self.limit:
                return False
            self.used += 1
            return True

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {"used": self.used, "limit": self.limit, "day": self.day}


_buckets: dict[str, Bucket] = {}
_buckets_lock = threading.Lock()
_daily = DailyCap(DAILY_CAP)


def bucket_for(client: str) -> Bucket:
    with _buckets_lock:
        found = _buckets.get(client)
        if found is None:
            found = _buckets[client] = Bucket(BURST, PER_MINUTE)
        return found


# -- the vendor call ---------------------------------------------------------

_client = None
_client_lock = threading.Lock()


def anthropic_client():
    global _client
    with _client_lock:
        if _client is None:
            import anthropic

            _client = anthropic.Anthropic(timeout=TIMEOUT_S)
        return _client


def analyse(payload: dict) -> dict:
    """Relay one analysis request and return the model's JSON, parsed.

    Mirrors `AnthropicProvider._call` in the desktop app, including the
    server-side fallback beta: over a large personal library some images will
    trip a safety classifier, and one refusal should not leave a permanent hole
    in someone's catalogue.
    """
    requested = str(payload.get("model") or "")
    model = requested if requested in ALLOWED_MODELS else DEFAULT_MODEL

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    schema = payload.get("schema")
    if not isinstance(schema, dict):
        raise ValueError("schema must be a JSON Schema object")

    kind = str(payload.get("kind") or "text")
    if kind == "image":
        image = str(payload.get("image_b64") or "")
        if not image:
            raise ValueError("image_b64 is required when kind is 'image'")
        content: list[dict] = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": image,
                },
            },
            {"type": "text", "text": prompt},
        ]
    elif kind == "text":
        body = str(payload.get("text") or "")
        if not body.strip():
            raise ValueError("text is required when kind is 'text'")
        content = [{"type": "text", "text": f"{prompt}\n\n---\n{body}"}]
    else:
        raise ValueError(f"unknown kind {kind!r}")

    kwargs = dict(
        model=model,
        max_tokens=min(int(payload.get("max_tokens") or MAX_OUTPUT_TOKENS),
                       MAX_OUTPUT_TOKENS),
        messages=[{"role": "user", "content": content}],
        output_config={
            "effort": "low",
            "format": {"type": "json_schema", "schema": schema},
        },
    )

    client = anthropic_client()
    try:
        response = client.beta.messages.create(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
        )
    except Exception:
        response = client.messages.create(**kwargs)

    if getattr(response, "stop_reason", None) == "refusal":
        detail = getattr(response, "stop_details", None)
        raise RuntimeError(
            f"declined by safety classifier ({getattr(detail, 'category', 'unknown')})"
        )

    text = next((b.text for b in response.content if b.type == "text"), "")
    if not text.strip():
        raise ValueError("empty response from the model")

    return {"analysis": json.loads(text), "model": model, "provider": "anthropic"}


# -- HTTP --------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "athena-gateway/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        # One line per request, to stdout, where Railway collects it. Never the
        # body: this service handles other people's documents.
        sys.stdout.write(
            f"{self.address_string()} {fmt % args}\n"
        )
        sys.stdout.flush()

    # -- routes ------------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] in ("/v1/health", "/health", "/"):
            # Unauthenticated on purpose: it reports capacity, never content,
            # and the landing page uses it to show whether the demo is live.
            return self._json({
                "ok": True,
                "service": "athena-gateway",
                "models": list(ALLOWED_MODELS),
                "default_model": DEFAULT_MODEL,
                "daily": _daily.snapshot(),
            })
        return self._json({"ok": False, "error": "no such route"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/v1/analyse":
            return self._json({"ok": False, "error": "no such route"}, 404)

        presented = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        if not _constant_time_eq(presented.strip(), TOKEN):
            return self._json(
                {"ok": False, "error": "bad or missing token"}, 401, close=True)

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._json(
                {"ok": False, "error": "request too large"}, 413, close=True)

        # Rate limits are keyed to the token, not the IP: every client behind
        # one NAT shares an address, and the token is what is actually being
        # granted a share of the budget.
        if not bucket_for(presented[:16]).take():
            return self._json(
                {"ok": False, "error": "rate limit -- slow down and retry"},
                429, close=True)
        if not _daily.take():
            return self._json(
                {"ok": False, "error": "daily budget for this gateway is spent"},
                429, close=True)

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self._json({"ok": False, "error": "body is not valid JSON"}, 400)

        started = time.monotonic()
        try:
            result = analyse(payload)
        except ValueError as exc:
            return self._json({"ok": False, "error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            # The vendor's message can carry request detail, so it is reported
            # by type and text but the request body never is.
            return self._json(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 502)

        self.log_message("analysed kind=%s in %.2fs",
                         payload.get("kind", "text"), time.monotonic() - started)
        return self._json({"ok": True, **result})

    # -- plumbing ----------------------------------------------------------

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)

    def _json(self, payload: dict, status: int = 200, *, close: bool = False) -> None:
        """Answer with JSON. `close` ends the connection as well.

        Every early return from `do_POST` -- bad token, oversized body, rate
        limit -- happens *before* the request body has been read, and this is
        HTTP/1.1, so the socket is kept alive by default. The unread body then
        sits in the buffer and the next read parses it as a request line: one
        rejected call turns into a bogus second request and a client that now
        disagrees with the server about where it is in the stream.

        Draining instead would mean reading up to MAX_BODY from a caller who
        has just failed authentication, which is the wrong favour to do an
        attacker. So refusals close.
        """
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self._cors()
        self.end_headers()
        self.wfile.write(data)


def _constant_time_eq(a: str, b: str) -> bool:
    """Compare without leaking length or position through timing."""
    import hmac

    return bool(a) and bool(b) and hmac.compare_digest(a, b)


def main() -> None:
    if not TOKEN:
        sys.exit(
            "ATHENA_GATEWAY_TOKEN is not set. Refusing to start an "
            "unauthenticated relay in front of a billable API key.\n"
            "  python -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        sys.exit("ANTHROPIC_API_KEY is not set; there is nothing to relay to.")

    port = int(os.environ.get("PORT", 8080))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), partial(Handler))
    httpd.daemon_threads = True
    print(f"athena-gateway on :{port}  models={list(ALLOWED_MODELS)} "
          f"daily_cap={DAILY_CAP}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
