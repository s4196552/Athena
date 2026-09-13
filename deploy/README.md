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
| **Vercel** | `../cloud/` — the landing page and Athena Cloud | serverless + CDN | It is the public front door, and a *shared* catalogue is by definition not one machine's. |

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

## Vercel — Athena Cloud

`cloud/` is a Next.js app: the landing page, mock accounts, and a shared,
multi-tenant read of a catalogue with an Obsidian-style graph over it — drawn
three ways, as a cloud of files, a cloud of tags, or a pyramid that stacks the
tags from broadest to most specific by which ones contain which. It
replaces the hand-written `site/index.html`, which was ported into
`cloud/app/page.tsx` and removed (git still has it).

On top of the read sit the things a viewer can do without the catalogue ever
being written to: correct a wrong tag, collect files into an album, summarise a
selection, and hear that summary read aloud. Corrections and albums are a
read-time lens applied at one chokepoint, held in a per-workspace cookie.

`/w/[ws]/agent` is the engine's classifier brought to the browser, with the
same split the engine keeps — arithmetic answers what it can, and a model is
asked only where arithmetic runs out:

| Verb | Model? | What it does |
|---|---|---|
| Ask for a view | yes | Turns a question into a filter and picks one of the three drawings. It never reports a quantity; the repository counts. |
| Label | yes | Proposes a doctype and topic for a file that has neither. Proposing and accepting are separate, so a spend is never tied to a write. |
| Explain | yes | Describes a file from its name, folder, labels and neighbours — and lists what it could not determine without opening it. |
| Related | **no** | Cosine similarity over idf-weighted tag vectors. Runs on its own when a file opens, because it costs nothing. |
| Same name, several places | **no** | Names filed across multiple folders. Not a duplicate finder: every content hash in this catalogue is distinct, so there are none to find. |

### Project settings — do this before the first push

1. **Root Directory → `cloud`.**
2. **Turn OFF "Include source files outside of the Root Directory in the Build
   Step."**

The second toggle is what actually solves the problem the old static config was
written around. `pyproject.toml` sits at the repo root, and zero-config Vercel
would detect a Python project and try to install Athena itself. Previously that
was suppressed by pinning `framework: null`; now `pyproject.toml` is simply not
in the build context at all, so the detection is structurally impossible rather
than merely overridden.

The consequence to accept, deliberately rather than by surprise: **the build
cannot read `athena/`.** So the seed catalogue is generated locally and
committed, and `npm run check:taxonomy` — which compares `cloud/lib/taxonomy.ts`
against `athena/agent/taxonomy.py` and fails on drift — is a local and CI step,
never a build step.

Note also that Vercel reads `vercel.json` **from the Root Directory**. The
repo-root one is therefore no longer read at all and has been deleted rather
than left behind as config that lies about what deploys.

`cloud/vercel.json` pins `framework: "nextjs"` and nothing else. Two things
about that file are deliberate and easy to undo by accident:

- **No comment key.** JSON has no comments, and Vercel validates `vercel.json`
  with `additionalProperties: false` -- a `"//"` key is rejected outright with
  *"should NOT have additional property"*, and the deploy fails before it
  builds. Explanations go here instead.
- **No `headers` block.** Those live in `cloud/next.config.ts`, because
  `vercel.json` headers are applied by Vercel's edge and therefore do not exist
  under `next dev`. Keeping them here would let development and production
  disagree about CSP, whose failure mode is a silently blank page.

`framework` is pinned so a stray config elsewhere can never re-trigger the
Python detection the old static setup existed to avoid.

### Environment

| Variable | Required | What it does |
|---|---|---|
| `AUTH_SECRET` | **yes, in production** | Signs the session cookie (HMAC-SHA256). Unset in production the app throws at first use — loudly, rather than silently rejecting every session and presenting as an unexplained redirect loop back to `/login`. |
| `ATHENA_DATA_DRIVER` | no (`json`) | Which repository driver backs the catalogue. |
| `ATHENA_GATEWAY_URL` | no | Shows the Railway gateway's health on the landing page. Fetched **server-side**, which is why the CSP can be `connect-src 'self'` instead of the old `connect-src *`. |
| `GEMINI_API_KEY` | no | Lets **Summarise this selection** add a model-written opening paragraph. Without it the site still produces the counted brief, which is the half carrying every number. `GOOGLE_API_KEY` is accepted as an alias. |
| `GEMINI_MODEL` | no (`gemini-3.5-flash-lite`) | Model ids move faster than deploys. |
| `ATHENA_AI_VIEWER_DAILY` | no (`25`) | Model-written summaries per viewer per day. |
| `ATHENA_AI_DAILY_MAX` | no (`400`) | Per lambda instance per day. See the caveat below. |
| `ELEVENLABS_API_KEY` | no | Adds **Listen** to a summary — the brief read aloud. Without it the summary still appears in full and the button is simply absent, because a control that cannot work should not be drawn. Needs a key with synthesis rights; a read-scoped key is not enough. |
| `ELEVENLABS_MODEL` | no (`eleven_flash_v2_5`) | Flash bills at half the character rate of the v2 models and returns in well under a second. |
| `ELEVENLABS_VOICE_ID` | no (`21m00Tcm4TlvDq8ikWAM`) | Rachel, a stock voice present on every account including the free tier. A cloned or premium voice id works and then 404s for anyone deploying with their own key. |
| `ELEVENLABS_FORMAT` | no (`mp3_44100_128`) | The highest bitrate not gated behind a paid tier. `mp3_44100_192` needs Creator; PCM and WAV at 44.1 kHz need Pro. |
| `ATHENA_TTS_VIEWER_DAILY` | no (`8000`) | **Characters**, not calls, per viewer per day. |
| `ATHENA_TTS_DAILY_MAX` | no (`150000`) | Characters per lambda instance per day. |

#### One key, a public demo

The site calls Gemini **server-side only** — `lib/ai/gemini.ts` imports
`server-only`, so an accidental import from a client component fails the build
rather than shipping the key to a browser. The key travels in an
`x-goog-api-key` header rather than the query string, because a URL with a key
in it ends up in logs and proxies.

What leaves the server is a few hundred tokens of **already-aggregated counts**
— "42 invoices, 3 authors, 2023–2025". Not file content, because this catalogue
has none: the seed holds names, sizes, dates and tag ids. The caller cannot make
a request bigger, because the caller does not supply the payload; the server
builds it from the catalogue.

Be clear-eyed about the caps in `lib/brief/budget.ts`. The per-viewer counter is
a cookie and the per-instance counter resets on a cold start and is not shared
between lambdas. They keep the demo tidy; they are **not** a billing guarantee.
What actually bounds the exposure is the payload shape above. **Set a spending
limit in Google AI Studio as well** if this deployment is public.

`GET /api/health` reports `ai.configured` — presence only, never the value — so
a deployment that is quietly serving counted-only briefs is distinguishable from
one where the model is working.

#### The second key, and why it is counted differently

`ELEVENLABS_API_KEY` follows every rule above — `server-only` in
`lib/ai/elevenlabs.ts`, the key in an `xi-api-key` header rather than a query
string, presence-only reporting at `GET /api/health` under `speech`. Two things
differ, and both are deliberate.

**The caller does not supply the text.** `POST /api/w/[ws]/speak` takes the same
filter string the library page is already using and rebuilds the brief from the
catalogue. An endpoint that speaks whatever it is posted is a free
text-to-speech service for anyone who can reach the login screen, billed to one
shared key — and a per-call length cap does not fix that, because the abuse is
unlimited *calls* of legal length. Rebuilding costs nothing: the brief is
produced in `cached-only` mode, which never spends a model call.

**The budget counts characters, not calls** (`lib/speech/budget.ts`), because
that is the unit ElevenLabs bills. Counting calls would price a forty-character
title the same as a two-thousand-character brief. It is a separate counter from
the brief's, so listening to a summary does not spend the allowance for writing
one. **Set a usage limit on the key in the ElevenLabs dashboard** if this
deployment is public; the same caveat as above applies, for the same reasons.

`GET /api/health?speech=1` asks ElevenLabs whether the key is accepted *from
this server*, which is not the same question as whether the variable is set. It
lists voices rather than synthesising, so it costs no characters, and it reports
the account's remaining character quota when the key is allowed to read it.

```bash
cd cloud
npm install
npm run seed            # regenerate the committed catalogue (deterministic)
npm run check:taxonomy  # fails if the TS taxonomy has drifted from the Python
npm run check:pyramid   # the pyramid layout, checked without a browser
npm run check:contrast  # every text pair against the WCAG ratio, both themes
npm run check:speech    # the brief-to-speech translation, no key needed
npm run check:related   # the two arithmetic agent verbs, against the real seed
npm run build
vercel deploy --prod
```

The last three need neither a server nor a key, which is the point of having
them: a ranking and a contrast ratio both fail *silently* — they return a list
or a colour either way, and nothing about a wrong one looks wrong.

`GET /api/health` answers "did the Next.js build actually deploy?";
`GET /api/health?deep=1` additionally reads the catalogue, which is how you
confirm `outputFileTracingIncludes` packaged `data/seed` into the lambda. That
failure mode is the nasty one — it works locally and 500s on Vercel.

### Security headers

They live in `cloud/next.config.ts`, **not** in `vercel.json`. `vercel.json`
headers are applied by Vercel's edge and so do not exist under `next dev`,
which would let development and production disagree about CSP — the one setting
whose failure mode is a silently blank page.

`script-src` still carries `'unsafe-inline'`, because the App Router streams
hydration data as inline `<script>` tags. Removing it means a per-request nonce
set in middleware, which forces every nonce-bearing route to render dynamically
and gives up static generation. That is a deliberate later trade, not something
to adopt before the app works.

### What does not persist

Vercel's filesystem is read-only at runtime and lambdas are ephemeral, so:
mock sign-ups live for one server process, and colour groups are stored per
viewer in `localStorage`. Tag corrections, albums and accepted agent
suggestions are held in a per-workspace cookie, and brief text is cached in
module memory for thirty minutes — as is synthesised audio, capped at 12 MB
rather than by entry count, because what is scarce there is bytes of lambda
memory and not rows. Both AI budgets are cookies too, which is why they are
described in the UI as speed bumps rather than limits. All of them say so in
the UI. The repository interface already has the seams
(`getColorGroups`, and `readOverlay` in `lib/overlay/store.ts`) for when there
is a real store.

### What not to do with it

Athena Cloud reads a *committed* catalogue. It is tempting instead to serve
`athena/web/static/` from Vercel and point it at a running `athena serve` on
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
