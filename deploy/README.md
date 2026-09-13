# Deploying Athena

Athena itself does not deploy. That is not a limitation to work around — it is
what the application is. Its input is a path on your disk, its output is a
SQLite catalogue next to it, and the guarantee is that neither the files nor
the folders are ever modified. Push that container to a host and it boots
pointing at a filesystem that has none of your files in it.

So exactly two pieces are hosted, and neither of them is the library:

| | What | Where | Why it cannot be local |
|---|---|---|---|
| **Railway** | `gateway/` — an authenticated, rate-limited relay to a model vendor | a long-lived container | It holds a **shared secret**. Ship a key inside a desktop app and you have published it. |
| **Vercel** | `../site/` — the landing page | static CDN | It is the public front door. Nothing to compute. |

If what you actually want is *your* Athena reachable from elsewhere, do not
move the app — expose the machine that has the files, with a Cloudflare Tunnel
in front of `athena serve`. The index, the files and the catalogue all stay
put, and it is a config change rather than a rewrite.

---

## Railway — the AI gateway

The gateway exists for one situation: someone clones the repo and wants the
model-backed features without opening an account with a model vendor. It holds
the vendor key; clients hold a gateway token you can revoke.

It is a **relay, not a reimplementation**. The caller sends the prompt *and the
JSON schema it wants back*, so the gateway never parses either and
`ANALYSIS_SCHEMA` can change in `athena/ai/base.py` with no redeploy here.
There is no second copy of the schema to drift.

### Deploy

```bash
cd deploy/gateway
railway init
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set ATHENA_GATEWAY_TOKEN="$(python -c 'import secrets;print(secrets.token_urlsafe(32))')"
railway up
```

In the Railway dashboard set **Root Directory** to `deploy/gateway` — the repo
root is the desktop app, and building that would pull in Pillow, pypdf and the
rest of a parsing stack this service never uses.

`railway.json` pins the Dockerfile builder, a `/v1/health` healthcheck, and
restart-on-failure. Railway injects `PORT`; the app binds `0.0.0.0` and lets the
platform terminate TLS.

### Point Athena at it

```bash
set ATHENA_AI_PROVIDER=gateway
set ATHENA_GATEWAY_URL=https://your-service.up.railway.app
set ATHENA_GATEWAY_TOKEN=...
```

### What it will and will not do

It refuses to start without both a token and a key, because an unauthenticated
relay in front of a billable API is a liability that should fail at boot rather
than on an invoice.

| Control | Default | What it stops |
|---|---|---|
| `ATHENA_GATEWAY_TOKEN` | *required* | Anyone at all using your key |
| `ATHENA_GATEWAY_MODELS` | haiku, then opus | A client choosing what it spends. Requests outside the list are clamped to the first, not rejected. |
| `ATHENA_GATEWAY_DAILY_CAP` | `5000` | The actual bill. Global across callers, resets at UTC midnight. |
| `ATHENA_GATEWAY_BURST` / `_PER_MINUTE` | `40` / `30` | One client draining the day in a loop. Token bucket, so a first scan can burst and then go quiet. |
| `ATHENA_GATEWAY_MAX_BODY` | 8 MB | A malformed client making the process allocate a gigabyte |
| `ATHENA_GATEWAY_MAX_TOKENS` | `1024` | Runaway generations. These answers are a sentence and two short lists. |

Request bodies are never logged — only size, outcome and latency. `/v1/health`
is unauthenticated on purpose: it reports capacity, never content, so the
landing page can show whether the demo is live.

### What reaches it

Exactly what `athena/ai/cloud.py` would have sent the vendor directly: a JPEG
downscaled to the configured longest edge, or at most `max_chars` of
already-extracted document text. Never an original file, never a path, never
anything else in the library.

This is still a real change in who can see that content — one more operator —
which is why `gateway` is off unless selected, and why tags record provenance
as `gateway:<model>` rather than `anthropic:<model>`. Someone auditing a
library later can tell which files went through a shared service.

### Ollama on Railway instead

`ATHENA_OLLAMA_HOST` now points the local provider anywhere, so a container
running Ollama works as a drop-in:

```bash
set ATHENA_AI_PROVIDER=ollama
set ATHENA_OLLAMA_HOST=https://your-ollama.up.railway.app
```

Worth knowing before committing to it: Railway is CPU, so a vision model will
be slow enough to feel on a 500-file run. The gateway is the better fit for a
demo; this is the better fit if the point is that no vendor sees the content.

---

## Vercel — the landing page

`site/index.html` is hand-written, dependency-free, and the only thing being
deployed. `vercel.json` at the repo root pins `framework`, `buildCommand` and
`installCommand` to empty on purpose — `pyproject.toml` sits at the root, and
zero-config Vercel would otherwise detect a Python project and try to install
Athena itself.

```bash
vercel deploy --prod
```

To show live gateway status on the page, set `GATEWAY` in the script block at
the bottom of `site/index.html` to your Railway URL. Left empty, the row says
so rather than failing — the page never depends on the gateway being up.

### What not to do with it

It is tempting to serve `athena/web/static/` from Vercel and point it at
`http://127.0.0.1:8731`. It does not work, and the second reason is the
important one:

- Browsers gate requests from public sites into the local network (Chrome's
  Private Network Access), so it is fragile across browsers in principle.
- `athena/web/server.py` refuses any non-loopback `Host` or `Origin` outright.
  That guard exists because `/api/scan` and `/api/reveal` have side effects and
  a page on the open internet could otherwise drive them by DNS rebinding.
  Making a hosted UI work means deleting the protection that stops a website
  talking to this server.

Not a trade worth making to avoid serving three static files locally, which the
app already does.
