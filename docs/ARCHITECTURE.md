# Athena — architecture

A local-first data manager: Google Photos for everything, with one rule that
overrides every other design goal.

> **Athena reads your files. It never writes to them, moves them, renames them,
> or changes the shape of your folders.**

Everything below follows from that sentence. Where the rule costs performance
or convenience, the rule wins.

---

## 1. Enforcing the rule

"We'll be careful" is not an architecture. The guarantee is enforced four
different ways, at four different levels, because each catches what the others
miss.

### 1.1 A single gateway

`athena/core/safety.py` is the only module permitted to touch a path inside a
library. Everything else calls `open_ro()`, `stat_ro()`, `reader_for()` or
`materialise()`. One file to audit, one file to review carefully, instead of
the same argument re-litigated in every extractor.

Four things can break the promise, and the gateway handles all four:

| Risk | Handling |
|---|---|
| Writing | Descriptors are `O_RDONLY` / `GENERIC_READ`. No write mode exists on the path. |
| Access-time drift | `O_NOATIME` on Linux; the `-1` sentinel to `SetFileTime` on Windows. Reading a file is itself a metadata mutation that a backup tool will notice. |
| Locking | `CreateFileW` with `FILE_SHARE_READ\|WRITE\|DELETE`. Python's default `open()` on Windows makes an open file undeletable in Explorer — indexing 100k files must not make the user's own library feel broken. |
| "Helpful" libraries | Parsers that rewrite their input (PDF linearisation, ID3 rebuilds, ZIP repair) never receive a real path. They get an in-memory buffer, or a scratch copy. |

### 1.2 A runtime guard

Every extraction runs inside `safety.guard()`, which fingerprints the file
(size, mtime, ctime) before and after. A mismatch raises, the derived metadata
is **discarded rather than stored**, and the event is written to
`integrity_audit`. Metadata from a file we may have damaged is worse than no
metadata.

This also catches the benign case — the user edited a file while we were
reading it — which invalidates the extraction either way.

### 1.3 Everything we produce lives elsewhere

`athena/config.py` defines the only three writable locations, all under the OS
app-data directory, all safe to delete: the SQLite catalogue, the thumbnail
cache, and models/logs. Sidecar files next to the user's photos would be more
convenient for several features. That is exactly what this product exists not
to do.

### 1.4 A census test in CI

`tests/test_never_mutates.py` snapshots every path, size, mtime and SHA-256 in
a sample library plus the shape of the directory tree, runs the full pipeline,
and asserts the snapshot is identical. It is the test that should fail the
build loudest.

A census beats spot-checks because it catches what nobody predicted: a parser
that rewrites EXIF, a library that drops a `.lock` beside its input, a temp
file created and deleted too quickly for a human to see.

---

## 2. Tech stack

### Recommended

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** (Rust) | ~10 MB binaries against Electron's ~150 MB; no bundled Chromium; native file dialogs and drag-and-drop; real OS integration for a tool that lives in the tray. |
| UI | **React + TypeScript**, TanStack Virtual, Zustand | Virtualisation is non-negotiable at 100k rows. |
| Read path | Rust `rusqlite`, **read-only, WAL** | The UI queries SQLite *directly*. No RPC, no serialisation layer, no API to keep in sync — filter changes are a prepared statement away. |
| Write path | **Python engine** (this repo), supervised sidecar | Python owns the parsing and ML ecosystem. Isolated in its own process, so a segfault in libav cannot take the window down. |
| Control channel | newline-delimited JSON on stdio | Commands only (`scan`, `pause`, `boost`). No socket, no port, no auth surface. |
| ML runtime | **ONNX Runtime** (DirectML / CoreML / CUDA) | A tenth the install size of PyTorch, int8 quantisation, uses whatever accelerator the machine has. |

**The key structural decision: SQLite *is* the IPC.** WAL mode allows unlimited
concurrent readers alongside one writer. The UI reads the catalogue directly;
only commands cross the process boundary. This removes an entire API layer and
makes filtering as fast as SQLite, which is very fast.

### Alternatives considered

- **PySide6 / PyQt6, all Python.** Ships faster if the team is Python-only, and
  `QAbstractItemModel` with `canFetchMore` handles huge lists well. Rejected as
  the primary: 120 MB+ of wheels, dated-feeling UI, Qt's licensing.
- **Electron + Python.** Same architecture as the recommendation, 15x the
  install size and ~300 MB idle RSS. Choose it only if the team's React tooling
  investment outweighs that.
- **Pure Rust, no Python.** Fastest, smallest. Rejected because it gives up
  `python-pptx`, `mutagen`, RapidOCR and the whole ML ecosystem, and would cost
  months re-implementing parsers that already exist.

### Libraries, and the licence trap

| Job | Use | Avoid / note |
|---|---|---|
| Hashing | `blake3` (Rust, releases the GIL, GB/s) | — |
| Type sniffing | `puremagic` (pure Python) | `python-magic` needs a libmagic DLL on Windows |
| Images | `Pillow`, `pillow-heif` | — |
| PDF | **`pypdfium2`** (Apache-2.0, Chrome's engine) + `pdfminer.six` (MIT) | **`PyMuPDF` is AGPL-3.0.** Fastest by far, and shipping it obliges you to release your source or buy a commercial licence. Very hard to unwind later. |
| Office | `python-docx`, `python-pptx` | Both take file objects — never hand them a path |
| Audio | `mutagen` | A read/write library; only ever construct it from a buffer |
| Video | `PyAV` (ffmpeg bindings) | Not an `ffmpeg` subprocess: ~30 ms spawn per file, and output templates have a history of writing next to the input |
| OCR | **RapidOCR** (ONNX, PP-OCRv4) | pip-installable with bundled weights. Tesseract needs a system binary on Windows and is worse on the angled, messy photographs this actually sees |
| Tagging / search | **SigLIP 2** or OpenCLIP, ONNX int8 | One model gives zero-shot scene tags, text→image search, and "find similar". Highest leverage single model in the stack |
| Detection | **RT-DETR** (Apache-2.0) | **Ultralytics YOLOv8/v11 is AGPL-3.0**, weights included |
| Transcription | `faster-whisper` (CTranslate2, MIT) | 4x `openai-whisper` on CPU at int8 |
| Vectors | numpy brute force to ~1M; then `sqlite-vec` | 100k × 512 float16 is 100 MB — a brute-force cosine scan is ~10 ms |

Faces (`insightface`) are deliberately **off by default**: biometric data
carries real regulatory exposure (BIPA, GDPR Art. 9). Opt-in, with the
consequences stated plainly.

---

## 3. Data model

Full DDL in [`athena/db/schema.sql`](../athena/db/schema.sql).

### 3.1 Content identity, not paths

```
asset  ← a unit of content, keyed by BLAKE3 of the bytes
file   ← a path that currently (or formerly) held that content
```

Every piece of extracted metadata hangs off `asset_id`. Three consequences,
all of which matter for a tool that refuses to organise your files for you:

1. **Moves are free.** Reorganise the entire library outside the app; on the
   next scan the content rebinds to the same asset and every tag, colour, box
   and OCR line is still attached. Reconciliation confirms candidates by NTFS
   file id / POSIX inode, which a rename preserves and a copy does not.
2. **Duplicates collapse.** One asset, many files. Expensive work runs once.
   Verified in practice: the test library's four identical photos produce one
   asset and one OCR pass.
3. **Re-index cost tracks distinct content**, not path count.

### 3.2 The state machine

```
              ┌──────────┐
   discover   │          │  content changed / extractor version bumped
  ──────────► │  QUEUED  │ ◄──────────────────────────────────┐
              │          │                                    │
              └────┬─────┘                                    │
          claimed  │                                          │
         ┌─────────┴─────────┐                                │
         ▼                   ▼                                │
   ┌───────────┐       ┌───────────┐                          │
   │  INDEXED  │       │   ERROR   │──── retry (retryable ────┘
   └─────┬─────┘       └─────┬─────┘      kind, < 3 attempts)
         │                   │
         │  path gone        │  path gone
         ▼                   ▼
              ┌───────────┐
              │  MISSING  │
              └─────┬─────┘
                    │ path returns: same content → INDEXED directly
                    │              otherwise    → QUEUED
                    └──────────────────────────────────────►
```

**There is deliberately no `Processing` state.** A row being worked on is still
`queued`, with `lease_owner` and `lease_expires_at` set. This removes a whole
class of bug: with a `Processing` state, every hard kill — power loss, OOM
killer, force-quit — strands rows in it, and a startup sweep cannot distinguish
"stranded from last run" from "actively being worked on right now". With
leases, a crashed run's claims simply expire. **Recovery is the absence of
code.**

`ERROR` is not terminal either. Errors carry a kind and an attempt count, and
retry automatically when their cause plausibly changed — a file that failed
because ffmpeg was not installed should heal itself once ffmpeg is.

### 3.3 The extractor ledger

`extractor_run(asset_id, extractor, version, status, …)` records "extractor E
at version V has been applied to asset A".

This is how a model improves without a full re-index. Bump the version, and:

```sql
SELECT a.id FROM asset a
LEFT JOIN extractor_run r ON r.asset_id = a.id AND r.extractor = 'image.ocr'
WHERE a.media_type = 'image'
  AND (r.version IS NULL OR r.version < 2);
```

Ship a better OCR model on a 100k library: 8,000 documents re-process, 92,000
are untouched, and EXIF/colour/thumbnails are never re-run just because OCR
improved.

### 3.4 Filters

| Filter | Mechanism |
|---|---|
| Keywords / objects / scenes | `asset_tag` + `tag`, indexed `(tag_id, confidence DESC)`. Boxes live separately in `detection`, so an image with 40 detected people is still one row in the filter index. |
| Colour | `color` stores exact Lab **and** a coarse `bucket`. Bucket drives the swatch chips (indexed equality); Lab drives "near this colour" (ΔE distance). |
| Location | `geo` + an **R\*Tree** virtual table — map viewport queries in log time. |
| Size / dimensions | Plain indexed columns on `file` and `*_meta`. |
| Text | **FTS5** in external-content mode, so text is stored exactly once. Filenames get a second `trigram` index for substring search. |
| Semantic | `embedding` blobs, float16, L2-normalised. |
| Kind / topic / author / year | `asset_tag` with a `kind`, written by the inspection agent (§4). Each kind is a separate axis in the rail. |
| Structural patterns | `pattern` tags — "contains monetary amounts", "contains a stack trace", "contains something shaped like an API key". |
| Custom | `tag.kind = 'custom'`, `asset_tag.source = 'user'`. A person's tag and a model's guess coexist rather than overwriting each other, because the primary key includes the source. |

**How they compose: OR within an axis, AND across axes.** Two topics selected
means "either"; a topic plus an author means "both". Each axis compiles to its
own `asset_id IN (...)` subquery rather than a join — with joins, three tag
filters multiply rows and the result count becomes a lie that `DISTINCT` then
has to launder. With subqueries the planner intersects index scans, the count
is honest, and a fourth filter costs one more index probe.

---

## 4. Background processing at 100,000 files

The question is not "how do we go fast", it is "how do we stay responsive and
never lose work". Six mechanisms.

### 4.1 Tiers, not a queue

| Tier | Work | Pool | Bound by |
|---|---|---|---|
| 0 · walk | `os.scandir`, stat only | 1 thread | the filesystem |
| 1 · identity | BLAKE3 + type sniff | **threads** (GIL released) | disk |
| 2 · cheap | EXIF, GPS, colour, dimensions, tags, document text, thumbnails | `cpu_count − 1` **processes** | CPU |
| 3 · ML | OCR, detection, embeddings, transcription | 1–2 processes | RAM (ONNX sessions) |

Measured on the 606-file test library: the walk finished in **1.1 s (577
files/s)**, tier 2 sustained **~120 files/s**. The library is browsable with
real names, sizes and dates within seconds; the expensive tiers fill in behind
it. That progressive enhancement *is* the responsiveness story.

Leave a core free. Pegging every core is what makes a background indexer feel
like malware.

### 4.2 The database is the queue

No broker, no in-memory work list. Workers are fed by `claim()`, one
`UPDATE … RETURNING` that leases rows atomically. Kill the app mid-scan and
nothing is lost or duplicated. Restart resumes exactly where it stopped.

### 4.3 One writer, batched

One thread, one connection, one queue, WAL. Because only one connection ever
writes, `SQLITE_BUSY` **cannot occur** — no retry loops, no busy-handler
tuning, no lock contention to debug at 2 a.m. Worker processes are given no
write connection at all, so they cannot break the invariant by accident.

Batching is not a micro-optimisation. SQLite's per-transaction cost is
dominated by the commit: one commit per file is ~1 ms, so 100k files is ~100
seconds of pure commit time, and it starves the WAL checkpointer. Batches of
500 drop that under a second. Batches close on size **or** a 250 ms latency
bound — without the latency bound, results at the tail of a scan sit
uncommitted, and therefore invisible to the UI's read connections.

`synchronous=NORMAL` is right for a *derived* catalogue: a power cut costs the
last few transactions, which the next scan re-derives, and in exchange we skip
an fsync per commit.

### 4.4 Crash attribution

Over 100,000 real files, some *will* find a segfault or an infinite loop in
libav, PDFium or libwebp. The only reliable remedy is to kill the process.

A worker announces the file it is about to touch **before** touching it. When
one dies, the supervisor knows exactly which file killed it, marks that one
file `error/worker_crash`, and spawns a replacement.

`concurrent.futures.ProcessPoolExecutor` cannot do this: it raises
`BrokenProcessPool`, discards the entire in-flight batch, and re-feeds the
poison file to the replacement worker until the app gives up. That is why
`scheduler.py` drives `mp.Process` directly.

A watchdog applies the same treatment to wedged workers on a per-stage
timeout — a hung decoder is indistinguishable from a slow one, so the only safe
move is to bound it. Killing is cheap precisely because a worker holds no lock,
no transaction and no lease of its own.

### 4.5 Backpressure

Every queue is bounded. When extraction outruns the writer, producers block
instead of growing an in-memory backlog that OOMs two hours into a scan.

### 4.6 Never emit per-file events

100,000 progress events will destroy any UI. 100,000 React re-renders is a far
more common cause of "the app froze" than any amount of indexing. The
supervisor keeps counters and publishes an aggregate snapshot four times a
second — counts per state, throughput, ETA.

On the UI side: virtualised rows, keyset pagination (never `OFFSET`),
lazy-loaded thumbnails through a custom protocol handler, and a `priority`
column the viewport can boost so what the user is looking at is indexed first.


---

## 5. The inspection agent

Parsing answers *what is in this file*. The agent answers *what is this file*,
which is the question a person actually asks. It runs after the parsers, over
the text and metadata they have already produced, and decides six things:

| | |
|---|---|
| `doctype` | what the file **is** — invoice, deck, log, CV, contract |
| `topic` | what it is **about** — finance, legal, engineering, HR |
| `author` | who made it — from metadata, a signature, a byline, a filename |
| `date` | the date the **content** concerns, not the file's mtime |
| `patterns` | what shape it has — currency figures, stack traces, secrets |
| `entities` | the organisations and people named in it |

### 5.1 Two axes, not one

`doctype` and `topic` are kept separate on purpose. Collapsing them into one
list of tags is the obvious shortcut and it ruins the filter: "Finance" and
"presentation" are not alternatives, and the useful query is *both at once*.
The rail renders them as separate groups for the same reason.

Both are **closed vocabularies** (`agent/taxonomy.py`). Every label, whether it
came from a regex or from a language model, is resolved onto that vocabulary or
dropped. A model asked for free-form topics returns "finance", "financial",
"finances" and "budgeting" across four files that belong in one bucket — and an
axis with forty one-file values is an axis nobody can filter by.

### 5.2 Shape beats vocabulary

Two layers of evidence, added rather than ranked:

* **Lexicons** ask *which words appear*. Cheap, and fooled by discussion: an
  email *about* invoices scores as an invoice.
* **Patterns** (`agent/patterns.py`) ask *what shape the content is*. A file
  with forty lines that each begin with a timestamp and a severity is a log
  whatever vocabulary it uses. An email about invoices does not contain an
  invoice-number field followed by a currency total.

Pattern hits are weighted higher because they are much harder to trigger by
accident. Every pattern is also a tag in its own right, so "show me everything
with monetary amounts in it" is an index lookup rather than a re-scan.

### 5.3 Escalation, which is the whole cost argument

The agent does not compute a fixed output from a fixed input. It gathers
evidence, weighs sources against each other, decides whether it is confident,
and **asks a language model only when it is not**.

```
rules alone      ~3 ms per file, no GPU, no API key, no network
rules + model    the model sees the residue -- typically the 10-20% of files
                 the lexicons cannot separate
```

So the feature works on a laptop with nothing installed, and spending money
makes it *better* rather than making it *work*. A classifier that phones a
vendor for all 100,000 files to discover that 40,000 of them are named
`invoice-*.pdf` is not a smarter design, just a more expensive one.

Mechanically: `agent.inspect` is a `Tier.CHEAP` extractor that runs on every
file; `agent.classify` is a `Tier.ML` extractor that claims only files whose
`agent_finding` row says the rules were unsure. The scores travel from one tier
to the other on the task itself (`Task.hints`, filled by `claim()`), so the ML
tier never has to escalate a file just to discover it did not need to.

### 5.4 Extractor ordering is now explicit

`agent.inspect` reads the text blocks the document extractors put into the
shared `Facets`, so it must run after them. That used to work by accident — the
registry sorted by name, and `text.keywords` happens to sort after `doc.pdf`.
An extractor named `agent.*` would have silently broken it by sorting *first*
and seeing no text at all, with no error: just empty tags on every file. There
is now an explicit `order` field, and the two dependent extractors declare it.

### 5.5 Saying why

`agent_finding` stores the reasoning next to the verdict: which patterns fired,
where the author name came from, whether a model was consulted. The detail
panel shows it. A classification a user can check is one they can correct; one
they cannot check is one they stop trusting the first time it is wrong — and
correcting it is what the custom tags are for.

### 5.6 Dates, and why embedded metadata is not trusted

A scanned 2019 invoice filed last Tuesday has an mtime of last Tuesday. The
date inside the document is the one a person means.

But `doc_created_at` is not trusted either, because of templates: Office files
inherit the `created` property of the template they were made from, so a deck
written this morning routinely reports a creation date years old. Every DOCX
built by this project's own fixtures dates itself to 2013. The embedded date is
therefore used only when a date in the document's own text corroborates it
(within a year); otherwise the text wins, and `event_source` records which.

A camera's `captured_at` *is* trusted outright — the clock was set by the
device at the moment of capture and there is nothing better available.

---

## 6. Answering questions about a set

Three things are built on the agent's output, and all three act on the current
**filter** rather than on a hand-picked set — which is what makes them work at
4,000 files as well as at four.

**Briefs** (`agent/brief.py`). "Filter to Finance + Jane Doe, then ask what
these add up to." Two producers, one output shape: a deterministic roll-up over
extracted values, and an optional model pass that writes prose on top of it.

The deterministic brief is not a degraded fallback. *"Eleven invoices from two
authors between March and May 2024, totalling $27,648, three of which mention a
tax registration"* is a **better** answer than generated prose, because every
figure in it is arithmetic over extracted values rather than a model's
recollection of them. The model's advantage is describing what documents are
*about*; the numbers do not come from it, and `write_brief` is handed the totals
as facts and told not to recompute them.

Two details that are easy to get wrong and are tested:

* Totals are computed **per asset**, not per file — a folder holding the same
  invoice three times reports one invoice and one total.
* Each document contributes its **largest** figure, not the sum of its figures.
  On an invoice the biggest number is the total; adding every line item plus
  the subtotal plus the total would roughly treble it.

Briefs are cached against a canonical form of the filter that excludes paging,
so scrolling to page three and asking again is the same question — and with a
paid provider, not a second charge.

**Custom tags.** Typed by a person, stored with `source = 'user'` so they never
displace what the agent found. They attach to the **asset**, so tagging one copy
of a photograph tags every copy — including copies a later scan of a different
folder turns up.

**The graph** (`/api/graph`). Nodes are *tags*, not files, and that is the whole
design decision: a node per file gives a 100,000-point cloud that renders slowly
and says nothing, while a node per tag gives forty points whose shape is the
actual structure of the library. An edge means "these two tags appear on the
same file".

Each edge carries two numbers, and the difference between them is what makes
the picture worth looking at. `weight` is how many files — the number a person
can check, so it is what the tooltip shows. `strength` is
`weight / min(count(a), count(b))`, so 1.0 means "wherever the rarer of these
two appears, the other does too". **The layout pulls on `strength`.** Ranking by
raw count produced a graph whose strongest links were all *2024 — something*:
nearly every file has a year, so a year co-occurs with everything. That is a
base rate, not a relationship. Normalising by the rarer endpoint surfaced the
real structure instead — Invoice and "Monetary amounts" at 1.0, because every
invoice has figures in it and hardly anything else does.

Two caps keep it a high-level view rather than a hairball: at most 60 nodes
overall, and at most 12 per kind. The per-kind cap matters more than it looks —
without it the graph fills with whichever axis has the most values, which on a
real library is always `date`, and years are the least informative nodes there
are: every file has one, so a year connects to everything and the layout
collapses into a wheel with 2024 at the hub.

Clicking a node adds it to the filter, which makes the graph a way of navigating
rather than a picture to admire.

---

## 7. What is built, and what is next

**Working and tested** — read-only gateway, catalogue schema, scanner with move
reconciliation, single writer, lease-based supervisor with watchdog and crash
attribution, EXIF/GPS, dominant colour, thumbnails, dHash, PDF/DOCX/PPTX text,
audio tags, video probe, keyword extraction, the census test.

Plus the **AI tier** (`athena/ai/`): a model reads the file and returns a
caption, objects, scene, topics and any legible text. Four interchangeable
backends — Ollama for local inference, or Anthropic / OpenAI / Google — behind
one `Analysis` contract, so the schema, extractors and UI never branch on
vendor. Captions land in the same FTS5 index as document text, which means
natural-language search works with no embeddings and no vector store.

Plus the **inspection agent** (`athena/agent/`, §5): pattern detection,
doctype/topic/author/date classification with escalation to a model only where
the rules are unsure, multi-axis filtering, user tags, selection briefs and the
tag graph.

**Next, in order of value:**

1. **SigLIP 2 embeddings** — "find visually similar", which captions cannot do.
2. **`watchdog` filesystem events** — with debounce, and a periodic full rescan
   for reconciliation, because FS events are lossy. On Windows, handle the
   buffer-overflow notification by rescanning that subtree.
3. **Offline reverse geocoding** — GPS coordinates are not a place name, and
   nobody searches for `37.77, -122.41`.
4. **Near-duplicate grouping** — the pHash index exists; the BK-tree over it
   does not.
5. **Idle/battery throttling** — pause on battery, resume on idle.
