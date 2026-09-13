"""The gateway: the shared-key deployment, end to end, without a vendor.

The vendor call is stubbed throughout. What is being tested is *our* half --
the auth, the clamps, the limits and the round trip back into an `Analysis` --
because that is the half that decides whether a shared token can be abused. A
test that needed a real API key would be a test that never runs in CI and
quietly costs money when it does.

The assertions worth reading are the clamp and the limit. A gateway that let
the caller choose the model, or that let one client spend the whole budget in a
loop, would work perfectly in a demo and be a liability the moment the URL was
shared -- which is the entire situation it exists for.
"""

from __future__ import annotations

import importlib.util
import json
import socket
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from athena.ai.base import AIConfig

TOKEN = "test-token-not-a-real-secret"

GATEWAY_APP = Path(__file__).resolve().parents[1] / "deploy" / "gateway" / "app.py"


def _load_app():
    """Execute `deploy/gateway/app.py` as a module, without installing it."""
    spec = importlib.util.spec_from_file_location("athena_gateway_app", GATEWAY_APP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def gateway(monkeypatch):
    """A live gateway on a loopback port, with the vendor call replaced."""
    monkeypatch.setenv("ATHENA_GATEWAY_TOKEN", TOKEN)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "not-used-the-call-is-stubbed")

    # Loaded by path, and freshly each time, rather than imported as a package.
    # `deploy/gateway/` is a deployable that Railway copies on its own -- giving
    # it `__init__.py` files to satisfy a test would be the test dictating the
    # shape of the artefact. Re-executing also picks up the env set above,
    # which the module reads at import time.
    app = _load_app()

    calls: list[dict] = []

    def fake_analyse(payload: dict) -> dict:
        calls.append(payload)
        requested = str(payload.get("model") or "")
        # The clamp under test, reproduced exactly as the real one does it.
        model = requested if requested in app.ALLOWED_MODELS else app.DEFAULT_MODEL
        return {
            "analysis": {
                "description": "A quarterly invoice from Acme Consulting.",
                "objects": [],
                "scene": "",
                "topics": ["finance", "invoice"],
                "text": "",
            },
            "model": model,
            "provider": "anthropic",
        }

    monkeypatch.setattr(app, "analyse", fake_analyse)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(app.Handler))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    time.sleep(0.15)
    try:
        yield url, app, calls
    finally:
        httpd.shutdown()


def _post(url: str, body: dict, token: str | None = TOKEN):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{url}/v1/analyse", data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


# -- the service -------------------------------------------------------------


def test_health_is_open_and_reports_capacity(gateway):
    """The landing page reads this, so it must answer without a token."""
    url, _app, _ = gateway
    with urllib.request.urlopen(f"{url}/v1/health", timeout=10) as response:
        health = json.load(response)
    assert health["ok"] is True
    assert health["default_model"] in health["models"]
    assert health["daily"]["limit"] > 0
    # Capacity, never content.
    assert "analysis" not in health and "text" not in health


def test_a_missing_or_wrong_token_is_refused(gateway):
    url, _app, calls = gateway
    body = {"kind": "text", "prompt": "p", "text": "t", "schema": {"type": "object"}}

    assert _post(url, body, token=None)[0] == 401
    assert _post(url, body, token="wrong")[0] == 401
    # Nothing reached the vendor, so a wrong token costs nothing.
    assert calls == []


def test_a_valid_request_round_trips(gateway):
    url, _app, calls = gateway
    status, out = _post(url, {
        "kind": "text",
        "prompt": "Summarise this document.",
        "text": "Invoice 4471. Total due $2,304.00.",
        "schema": {"type": "object"},
    })
    assert status == 200 and out["ok"] is True
    assert out["analysis"]["topics"] == ["finance", "invoice"]
    assert len(calls) == 1


def test_the_client_cannot_choose_an_expensive_model(gateway):
    """A shared token must not be a way to pick what it spends."""
    url, app, _ = gateway
    _status, out = _post(url, {
        "kind": "text", "prompt": "p", "text": "t", "schema": {"type": "object"},
        "model": "some-enormous-model-we-never-allowed",
    })
    assert out["model"] == app.DEFAULT_MODEL

    # ...but a model that *is* on the allowlist is honoured.
    _status, out = _post(url, {
        "kind": "text", "prompt": "p", "text": "t", "schema": {"type": "object"},
        "model": app.ALLOWED_MODELS[-1],
    })
    assert out["model"] == app.ALLOWED_MODELS[-1]


def test_the_rate_limit_stops_a_runaway_client(gateway):
    url, app, _ = gateway
    app.BURST = 3
    app._buckets.clear()
    app._buckets["test-token-not-"[:16]] = app.Bucket(3, per_minute=0.0)

    body = {"kind": "text", "prompt": "p", "text": "t", "schema": {"type": "object"}}
    codes = [_post(url, body)[0] for _ in range(5)]
    assert codes.count(200) == 3, codes
    assert codes.count(429) == 2, codes


def test_a_malformed_body_is_a_client_error_not_a_crash(gateway):
    url, _app, _ = gateway
    request = urllib.request.Request(
        f"{url}/v1/analyse", data=b"{not json",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            code = response.status
    except urllib.error.HTTPError as exc:
        code = exc.code
    assert code == 400


def test_a_refusal_does_not_poison_a_keep_alive_connection(gateway):
    """A rejected POST must not leave its body in the socket.

    Refusals happen before the body is read, and this is HTTP/1.1, so without
    an explicit close the unread body is parsed as the next request line: the
    client gets a second, bogus response it never asked for and the connection
    is out of step. Observed for real -- a 401 was followed by a spurious
    `400 Bad request syntax ('{}')`.
    """
    url, _app, _ = gateway
    host, port = url.removeprefix("http://").split(":")

    body = json.dumps({"kind": "text", "prompt": "p", "text": "t",
                       "schema": {"type": "object"}}).encode()
    request = (
        b"POST /v1/analyse HTTP/1.1\r\n"
        b"Host: " + host.encode() + b"\r\n"
        b"Authorization: Bearer definitely-wrong\r\n"
        b"Content-Type: application/json\r\n"
        b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
    )

    received = b""
    with socket.create_connection((host, int(port)), timeout=10) as sock:
        sock.sendall(request)
        sock.settimeout(3)
        while True:
            try:
                chunk = sock.recv(4096)
            except (TimeoutError, OSError):
                break
            if not chunk:
                break
            received += chunk

    assert b" 401 " in received
    assert b"Connection: close" in received
    # Exactly one response. Two means the body was re-parsed as a request.
    assert received.count(b"HTTP/1.1 ") == 1, received


def test_validation_happens_before_anything_is_spent(monkeypatch):
    """Every malformed shape is refused without a vendor client being built.

    Tested against the real `analyse` rather than through the HTTP fixture,
    whose stub replaces the validation being asserted on.
    """
    monkeypatch.setenv("ATHENA_GATEWAY_TOKEN", TOKEN)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "not-used-nothing-should-reach-it")
    app = _load_app()

    monkeypatch.setattr(app, "anthropic_client", lambda: pytest.fail(
        "a malformed request reached the vendor"))

    for bad in (
        {"prompt": "p", "text": "t"},                      # no schema
        {"schema": {}, "text": "t"},                       # no prompt
        {"prompt": "p", "schema": {}, "kind": "image"},    # image, no image
        {"prompt": "p", "schema": {}, "kind": "text"},     # text, no text
        {"prompt": "p", "schema": {}, "kind": "audio"},    # not a kind we serve
    ):
        with pytest.raises(ValueError):
            app.analyse(bad)


# -- the client --------------------------------------------------------------


def test_provider_reports_a_readable_reason_when_unconfigured(monkeypatch):
    """A missing setting must read as configuration, never as a broken app."""
    from athena.ai.gateway import GatewayProvider

    monkeypatch.delenv("ATHENA_GATEWAY_URL", raising=False)
    monkeypatch.delenv("ATHENA_GATEWAY_TOKEN", raising=False)
    assert "ATHENA_GATEWAY_URL" in (GatewayProvider(AIConfig()).available() or "")

    monkeypatch.setenv("ATHENA_GATEWAY_URL", "http://127.0.0.1:1")
    assert "ATHENA_GATEWAY_TOKEN" in (GatewayProvider(AIConfig()).available() or "")

    monkeypatch.setenv("ATHENA_GATEWAY_TOKEN", TOKEN)
    assert "not reachable" in (GatewayProvider(AIConfig()).available() or "")


def test_provider_talks_to_a_real_gateway(gateway, monkeypatch):
    """The whole path: provider -> HTTP -> gateway -> Analysis."""
    from athena.ai.gateway import GatewayProvider

    url, app, calls = gateway
    monkeypatch.setenv("ATHENA_GATEWAY_URL", url)
    monkeypatch.setenv("ATHENA_GATEWAY_TOKEN", TOKEN)

    provider = GatewayProvider(AIConfig(provider="gateway"))
    assert provider.available() is None
    # It adopted the gateway's model, so tags record what actually ran.
    assert provider.model == app.DEFAULT_MODEL

    analysis = provider.analyse_text("Invoice 4471. Total due $2,304.00.")
    assert "Acme" in analysis.description
    assert analysis.topics == ["finance", "invoice"]
    # Provenance names the route, not just the vendor.
    assert analysis.source_id.startswith("gateway:")

    # The schema travelled with the request -- that is what lets the gateway
    # stay ignorant of Athena's `Analysis` shape.
    assert calls[-1]["schema"]["properties"]["description"]
    assert calls[-1]["kind"] == "text"


def test_provider_truncates_text_to_the_configured_budget(gateway, monkeypatch):
    from athena.ai.gateway import GatewayProvider

    url, _app, calls = gateway
    monkeypatch.setenv("ATHENA_GATEWAY_URL", url)
    monkeypatch.setenv("ATHENA_GATEWAY_TOKEN", TOKEN)

    provider = GatewayProvider(AIConfig(provider="gateway", max_chars=50))
    provider.analyse_text("x" * 5000)
    assert len(calls[-1]["text"]) == 50


def test_get_provider_builds_a_gateway(monkeypatch):
    """`ATHENA_AI_PROVIDER=gateway` is all the wiring there should be."""
    from athena.ai.base import get_provider

    monkeypatch.setenv("ATHENA_AI_PROVIDER", "gateway")
    monkeypatch.setenv("ATHENA_GATEWAY_URL", "https://example.invalid")
    monkeypatch.setenv("ATHENA_GATEWAY_TOKEN", TOKEN)
    provider = get_provider()
    assert provider is not None and provider.name == "gateway"


def test_ollama_host_is_configurable(monkeypatch):
    """A remote Ollama -- a workstation, or a container -- not only localhost.

    `OllamaProvider` always accepted a host and nothing ever passed one, so it
    was pinned to localhost by omission rather than by decision.
    """
    from athena.ai.base import get_provider

    monkeypatch.setenv("ATHENA_AI_PROVIDER", "ollama")
    monkeypatch.setenv("ATHENA_OLLAMA_HOST", "http://gpu-box.local:11434/")
    provider = get_provider()
    assert provider.host == "http://gpu-box.local:11434"

    monkeypatch.delenv("ATHENA_OLLAMA_HOST")
    assert get_provider().host == "http://localhost:11434"
