# Athena

A local, private data manager — Google Photos for general data — built on one
non-negotiable rule:

> **Athena reads your files. It never writes to them, moves them, renames them,
> or changes the shape of your folders.**

All extracted metadata lives in an isolated SQLite catalogue under your OS
app-data directory. Delete it and your library is exactly as it was.

## Status

The indexing engine is implemented and tested. The Tauri UI is not yet built —
see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design,
including the stack recommendation and the concurrency model.

## Quick start

```bash
python -m venv .venv && .venv/Scripts/activate      # source .venv/bin/activate on POSIX
pip install -e ".[media,docs,dev]"                  # add ",ml" for OCR and tagging

python -m athena.cli ui                             # opens http://127.0.0.1:8731
```

Paste a folder path into the sidebar and hit Scan — the grid fills in live. Or
drive it from the terminal:

```bash
python -m athena.cli scan /path/to/library --wait
python -m athena.cli status
python -m athena.cli search quarterly revenue
```

## Managing libraries

```bash
python -m athena.cli libraries        # list them, with counts and offline status
python -m athena.cli forget <path>    # remove one from the catalogue
```

Or the **remove** button on each library in the sidebar.

The operation is called **forget**, not delete, and that is deliberate. It
removes Athena's rows, tags, captions and thumbnails. It does not delete,
move, rename or touch a single file inside the folder — which is the whole
point of the product, and the one button a user could catastrophically
misread, so the UI says so in plain words before it will proceed.

Two things it gets right that a naive implementation would not:

- **Content shared with another library survives.** Assets are only purged once
  no path anywhere still refers to them.
- **`--keep-metadata`** orphans the extracted metadata instead of purging it.
  Because assets are keyed by content hash, re-adding that folder later rebinds
  to them — the library comes back in seconds with no re-parsing and no AI spend.

## What the agent does with your files

When a file is parsed, an agent looks at what came out and decides what the
file actually *is*. No configuration, no model required.

| Axis | Example values | Where it comes from |
|---|---|---|
| **Kind** | invoice, contract, deck, log, CV, meeting notes | structural patterns + lexicons |
| **Topic** | finance, legal, engineering, HR, security | the same, on a separate axis |
| **Author** | Jane Doe | document properties, a signature, a byline, the filename |
| **Year** | 2024 | the date *inside* the document, not its mtime |
| **Contains** | monetary amounts, stack traces, possible secrets | ~30 pattern detectors |
| **Named** | Acme Consulting Ltd | organisations and people in the text |
| **My tags** | whatever you type | you |

It works by *shape*, not just vocabulary. An email discussing invoices is not
an invoice; a file with forty timestamped severity lines is a log whatever
language it is in. Nothing is written to your files — every tag lives in the
local SQLite catalogue.

**Filters combine the way you'd expect:** picking two topics means *either*,
while a topic plus an author means *both*. So "the finance invoices from Jane
Doe" is three clicks.

**Then do something with the selection.** "Summarise this selection" rolls the
whole filtered set up into a brief:

```
2 invoices: Finance, by Jane Doe

2 files matching Finance, by Jane Doe — 69.5 KB, dated 15 Mar 2024 to 16 Apr 2024.

$4,608.00 across 2 documents (USD); largest single figure $2,304.00.

Who they came from
  Jane Doe — 2
```

Every figure there is arithmetic over extracted values — no model involved, and
nothing that can be hallucinated. If you have a provider configured, **Ask a
model to write it** adds a paragraph of prose on top; the numbers stay
arithmetic.

**Graph view** draws the tags rather than the files: topics, kinds and authors
as nodes, joined where they appear on the same file. Click a node to filter by
it. It is capped at 60 nodes so it stays a diagram rather than a hairball.

### Where the AI actually gets used

The rules settle most files on their own — `invoice-4471.pdf` in a folder
called `Invoices` needs no language model. A model is asked only about the
files the rules could not classify, typically 10–20% of a library:

```
rules alone      ~3 ms per file, no GPU, no API key, no network
rules + model    the model sees the residue
```

So the feature is complete without a key, and adding one makes it better rather
than making it work.

## AI: local or cloud, your choice

Athena can have a model actually read your files — caption a photo, name what's
in it, read a sign, summarise a contract. Where that model runs is one
environment variable, and the app always shows which is active.

```bash
# Local — nothing leaves the machine. ~3 GB VRAM, fits a 6 GB laptop GPU.
winget install Ollama.Ollama && ollama pull qwen2.5vl:3b
set ATHENA_AI_PROVIDER=ollama

# Or a cloud API
set ATHENA_AI_PROVIDER=anthropic   && set ANTHROPIC_API_KEY=sk-ant-...
set ATHENA_AI_PROVIDER=openai      && set OPENAI_API_KEY=sk-...
set ATHENA_AI_PROVIDER=gemini      && set GEMINI_API_KEY=...

# Or a shared gateway someone else deployed, so you need no key at all
set ATHENA_AI_PROVIDER=gateway
set ATHENA_GATEWAY_URL=https://athena-gateway.up.railway.app
set ATHENA_GATEWAY_TOKEN=...

python -m athena.cli ui --ml
```

| Variable | Default | Meaning |
|---|---|---|
| `ATHENA_AI_PROVIDER` | `none` | `ollama` · `anthropic` · `openai` · `gemini` · `gateway` |
| `ATHENA_AI_MODEL` | per provider | e.g. `claude-haiku-4-5` for cheap bulk tagging |
| `ATHENA_AI_IMAGE_PX` | `768` | Longest edge sent. Tokens scale with pixels. |
| `ATHENA_AI_MAX_FILES` | `500` | Hard ceiling per run, so a big library can't run up a bill |
| `ATHENA_AI_MAX_CHARS` | `6000` | Document text sent per summary |
| `ATHENA_OLLAMA_HOST` | `http://localhost:11434` | "Local" can be a GPU box on your network |
| `ATHENA_GATEWAY_URL` | — | A deployed `deploy/gateway`, for `provider=gateway` |
| `ATHENA_GATEWAY_TOKEN` | — | Its shared token. Revocable and rate-limited. |

Three cost controls are structural, not optional:

- **Work is keyed to content.** A given image is analysed once, ever. Re-scans,
  duplicates and moved files are free — four copies of a photo cost one call.
- **Images are downscaled** to 768px and re-encoded as JPEG before they are
  sent. A 24 MP original would cost roughly forty times more for the same tags.
- **A budget ceiling** that must be raised deliberately.

With AI off — the default — nothing breaks. The extractors record `skipped`
with the reason, and the rest of the library indexes exactly as before.

What actually leaves the machine on a cloud provider: a downscaled JPEG, or
already-extracted document text. Never the original file, never the path.

## The UI

A single HTML page served by [`athena/web/server.py`](athena/web/server.py) —
standard library only, no build step. Thumbnail grid, colour-swatch filters,
full-text search across document text and OCR, and a detail panel showing the
palette, tags, extracted text and which extractors ran.

The browser is sandboxed; the server is not. That split is why the page can
offer "reveal in file manager" and "index this folder" at all — it asks the
server, which is an ordinary local process. The one route that touches a user
file, `/api/raw`, reads through `safety.open_ro` like everything else.

Bound to loopback, with Host and Origin checks to close the DNS-rebinding path.

Optional dependency groups degrade gracefully: without `media` you still get a
catalogued library with sizes, types and duplicate detection, and the missing
extractors are recorded as `skipped` rather than as errors.

## The guarantee, tested

```bash
pytest tests -q
```

`tests/test_never_mutates.py` takes a byte-exact census of a sample library —
every path, size, mtime and SHA-256, plus the shape of the directory tree —
runs the full pipeline, and asserts the census is unchanged. It is the test
that should fail the build loudest.

## Layout

```
athena/
  config.py             the only three places Athena may write
  core/
    safety.py           the read-only gateway — all file access goes through here
    states.py           the four-state machine and its retry policy
    identity.py         BLAKE3 hashing, content sniffing, truncation detection
    scanner.py          the walk, the Missing sweep, move reconciliation
    scheduler.py        pools, leases, watchdog, crash attribution
    worker.py           child-process entry point
    facets.py           the worker → writer wire format
  db/
    schema.sql          the catalogue
    connection.py       WAL, pragmas, migrations
    writer.py           the single writer
  extractors/           one versioned unit per piece of derived metadata
```
