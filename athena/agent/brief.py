"""Briefs: what comes out of "summarise this selection".

The user flow this exists for: filter to *Finance + Jane Doe*, look at eleven
documents, and ask what they add up to. Answering that is not a search problem
and it is not a per-file problem -- it is a question about a *set*, which is
exactly the thing a file manager has never been able to answer.

Two producers, same output shape:

* **`compile_brief`** is deterministic. It rolls up what the agent already
  extracted -- doctypes, authors, dates, currency totals, patterns, entities --
  and writes it out. No model, no network, no key, a few milliseconds. This is
  the one that runs today.

* **`write_brief`** hands the same rolled-up digest to a language model and
  asks for prose. It sends the digest and a short excerpt per file, never the
  files themselves.

The deterministic brief is not a degraded fallback and it is worth being clear
about why. "Eleven invoices from two authors between March and May 2024,
totalling $27,648, three of which mention a tax registration" is a *better*
answer than a paragraph of generated prose, because every figure in it is
arithmetic over extracted values rather than a model's recollection of them.
The model's advantage is describing what the documents are *about*; the numbers
should not come from it, and here they don't -- `write_brief` is handed the
totals as facts and told not to recompute them.

Briefs are cached in the `brief` table, keyed by the canonical filter string.
A selection summarised twice costs one call, not two.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from dataclasses import dataclass, field

from . import taxonomy as tax

#: Files described individually in the brief. Beyond this the roll-ups carry
#: the information and a list of 400 filenames carries none.
MAX_DETAIL = 25

#: Characters of body text taken from each file for the model pass.
EXCERPT_CHARS = 400

#: Total characters of excerpt sent. Keeps a 400-file selection inside one
#: request instead of silently truncating mid-document.
MAX_EXCERPT_TOTAL = 12_000


@dataclass(slots=True)
class Item:
    """One file in the selection, as the brief needs it."""

    name: str
    rel_path: str = ""
    media_type: str = "other"
    size_bytes: int = 0
    doctype: str | None = None
    topic: str | None = None
    author: str | None = None
    event_at: int | None = None
    patterns: list[str] = field(default_factory=list)
    numbers: dict = field(default_factory=dict)
    excerpt: str = ""

    @classmethod
    def from_row(cls, row) -> "Item":
        def loads(value):
            if not value:
                return None
            try:
                return json.loads(value)
            except (TypeError, ValueError):
                return None

        keys = row.keys() if hasattr(row, "keys") else row
        get = (lambda k: row[k]) if hasattr(row, "keys") else row.get
        return cls(
            name=get("name") or "",
            rel_path=(get("rel_path") if "rel_path" in keys else "") or "",
            media_type=(get("media_type") if "media_type" in keys else "") or "other",
            size_bytes=(get("size_bytes") if "size_bytes" in keys else 0) or 0,
            doctype=get("doctype") if "doctype" in keys else None,
            topic=get("topic") if "topic" in keys else None,
            author=get("author") if "author" in keys else None,
            event_at=get("event_at") if "event_at" in keys else None,
            patterns=loads(get("patterns") if "patterns" in keys else None) or [],
            numbers=loads(get("numbers") if "numbers" in keys else None) or {},
            excerpt=(get("excerpt") if "excerpt" in keys else "") or "",
        )


@dataclass(slots=True)
class Digest:
    """The arithmetic. Computed once, used by both producers."""

    count: int = 0
    total_bytes: int = 0
    doctypes: list[tuple[str, int]] = field(default_factory=list)
    topics: list[tuple[str, int]] = field(default_factory=list)
    authors: list[tuple[str, int]] = field(default_factory=list)
    years: list[tuple[int, int]] = field(default_factory=list)
    money: dict[str, dict[str, float]] = field(default_factory=dict)
    patterns: list[tuple[str, int]] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    earliest: int | None = None
    latest: int | None = None
    undated: int = 0


#: Patterns worth saying out loud in a brief, with the wording to use. These
#: are the ones a person would want to be told about a folder they were about
#: to share, rather than facts about its contents.
NOTABLE = {
    "credentials": "contain text shaped like API keys, tokens or passwords",
    "national-id": "contain something shaped like a national ID number",
    "iban": "contain bank account details",
    "date-of-birth": "contain a date of birth field",
}


def digest(items: list[Item]) -> Digest:
    out = Digest(count=len(items))
    doctypes: Counter[str] = Counter()
    topics: Counter[str] = Counter()
    authors: Counter[str] = Counter()
    years: Counter[int] = Counter()
    patterns: Counter[str] = Counter()

    for item in items:
        out.total_bytes += item.size_bytes or 0
        if item.doctype:
            doctypes[item.doctype] += 1
        if item.topic:
            topics[item.topic] += 1
        if item.author:
            authors[item.author] += 1
        for name in item.patterns:
            patterns[name] += 1

        if item.event_at:
            years[_year(item.event_at)] += 1
            out.earliest = min(out.earliest or item.event_at, item.event_at)
            out.latest = max(out.latest or item.event_at, item.event_at)
        else:
            out.undated += 1

        # The largest figure in a document, not the sum of its figures. On an
        # invoice the biggest number is the total, and adding up every line
        # item plus the subtotal plus the total would roughly treble it.
        for code, stats in (item.numbers.get("money") or {}).items():
            bucket = out.money.setdefault(code, {"documents": 0, "total": 0.0, "largest": 0.0})
            largest = float(stats.get("max") or 0.0)
            bucket["documents"] += 1
            bucket["total"] = round(bucket["total"] + largest, 2)
            bucket["largest"] = max(bucket["largest"], largest)

    out.doctypes = doctypes.most_common()
    out.topics = topics.most_common()
    out.authors = authors.most_common()
    out.years = sorted(years.items())
    out.patterns = patterns.most_common()
    out.flags = [
        f"{count} {'file' if count == 1 else 'files'} {NOTABLE[name]}"
        for name, count in patterns.most_common()
        if name in NOTABLE
    ]
    return out


# ---------------------------------------------------------------------------
#  The deterministic brief
# ---------------------------------------------------------------------------


def compile_brief(items: list[Item], label: str) -> tuple[str, str]:
    """(title, markdown body) from arithmetic alone."""
    if not items:
        return "Nothing selected", "No indexed files match this filter."

    d = digest(items)
    title = _title(d, label)
    lines: list[str] = [_headline(d, label), ""]

    if d.money:
        for code, stats in sorted(d.money.items()):
            symbol = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}.get(code, "")
            lines.append(
                f"**{symbol}{stats['total']:,.2f}** across {stats['documents']} "
                f"{'document' if stats['documents'] == 1 else 'documents'} "
                f"({code}); largest single figure {symbol}{stats['largest']:,.2f}."
            )
        lines.append("")
        lines.append(
            "_Each document contributes its largest figure, which on an invoice "
            "or a statement is the total. Line items are not added separately._"
        )
        lines.append("")

    if d.flags:
        lines.append("### Worth a look")
        lines += [f"- {flag}" for flag in d.flags]
        lines.append("")

    for heading, rows, axis in (
        ("What these are", d.doctypes, "doctype"),
        ("What they are about", d.topics, "topic"),
    ):
        if rows:
            lines.append(f"### {heading}")
            lines += [
                f"- {tax.display_of(name, axis)} — {count}"
                for name, count in rows[:10]
            ]
            lines.append("")

    if d.authors:
        lines.append("### Who they came from")
        lines += [f"- {name} — {count}" for name, count in d.authors[:10]]
        if d.count - sum(c for _, c in d.authors) > 0:
            lines.append(f"- _no author identified — "
                         f"{d.count - sum(c for _, c in d.authors)}_")
        lines.append("")

    if d.years:
        spread = ", ".join(f"{year} ({count})" for year, count in d.years)
        lines.append("### When")
        lines.append(spread)
        if d.undated:
            lines.append(f"\n{d.undated} with no date in the content.")
        lines.append("")

    detail = sorted(items, key=lambda i: (-(i.event_at or 0), i.name))[:MAX_DETAIL]
    lines.append("### The files")
    for item in detail:
        lines.append(f"- {_one_liner(item)}")
    if len(items) > MAX_DETAIL:
        lines.append(f"- _and {len(items) - MAX_DETAIL} more_")

    return title, "\n".join(lines)


def _title(d: Digest, label: str) -> str:
    if d.doctypes and len(d.doctypes) == 1:
        noun = tax.display_of(d.doctypes[0][0], "doctype")
        return f"{d.count} {noun.lower()}{'' if d.count == 1 else 's'}: {label}"
    return f"{d.count} files: {label}" if label else f"{d.count} files"


def _headline(d: Digest, label: str) -> str:
    head = f"**{d.count}** {'file' if d.count == 1 else 'files'}"
    if label:
        head += f" matching _{label}_"
    head += f" — {_bytes(d.total_bytes)}"
    if d.earliest and d.latest:
        span = _date(d.earliest)
        if _date(d.latest) != span:
            span = f"{span} to {_date(d.latest)}"
        head += f", dated {span}"
    return head + "."


def _one_liner(item: Item) -> str:
    bits = [f"**{item.name}**"]
    tail: list[str] = []
    if item.doctype:
        tail.append(tax.display_of(item.doctype, "doctype").lower())
    if item.author:
        tail.append(item.author)
    if item.event_at:
        tail.append(_date(item.event_at))
    money = item.numbers.get("money") or {}
    for code, stats in sorted(money.items())[:1]:
        symbol = {"USD": "$", "EUR": "€", "GBP": "£"}.get(code, f"{code} ")
        tail.append(f"{symbol}{float(stats.get('max') or 0):,.2f}")
    if tail:
        bits.append("— " + ", ".join(tail))
    return " ".join(bits)


def _year(stamp: int) -> int:
    return time.gmtime(stamp).tm_year


def _date(stamp: int) -> str:
    return time.strftime("%d %b %Y", time.gmtime(stamp)).lstrip("0")


def _bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} TB"


# ---------------------------------------------------------------------------
#  The model brief
# ---------------------------------------------------------------------------

BRIEF_PROMPT = """You are summarising a set of files someone has filtered in a file manager.

Write, in this order:
  description -- two or three sentences on what this collection is, what it is
                 for, and anything a person should notice about it.
  topics      -- up to five recurring themes, as short phrases.
  objects     -- the organisations and people this set is mostly about.
  scene       -- leave empty.
  text        -- leave empty.

The counts and totals below are already computed and are correct. Refer to
them; do not recalculate them and do not contradict them. Describe only what
is in the material given -- if the excerpts do not support a claim, leave it
out.

SELECTION: {label}

{digest}

EXCERPTS
{excerpts}
"""


def digest_text(d: Digest) -> str:
    """The arithmetic, flattened for a prompt."""
    lines = [
        f"{d.count} files, {_bytes(d.total_bytes)}.",
    ]
    if d.earliest and d.latest:
        lines.append(f"Dated {_date(d.earliest)} to {_date(d.latest)}; "
                     f"{d.undated} undated.")
    if d.doctypes:
        lines.append("Kinds: " + ", ".join(
            f"{tax.display_of(n, 'doctype')} x{c}" for n, c in d.doctypes[:10]))
    if d.topics:
        lines.append("Subjects: " + ", ".join(
            f"{tax.display_of(n, 'topic')} x{c}" for n, c in d.topics[:10]))
    if d.authors:
        lines.append("Authors: " + ", ".join(f"{n} x{c}" for n, c in d.authors[:10]))
    for code, stats in sorted(d.money.items()):
        lines.append(f"Monetary totals ({code}): {stats['total']:,.2f} across "
                     f"{stats['documents']} documents, largest {stats['largest']:,.2f}.")
    if d.flags:
        lines.append("Flagged: " + "; ".join(d.flags))
    return "\n".join(lines)


def excerpts_text(items: list[Item]) -> str:
    out: list[str] = []
    used = 0
    for item in items:
        body = " ".join((item.excerpt or "").split())[:EXCERPT_CHARS]
        if not body:
            continue
        chunk = f"--- {item.name}\n{body}"
        if used + len(chunk) > MAX_EXCERPT_TOTAL:
            out.append(f"[{len(items) - len(out)} further files not excerpted]")
            break
        out.append(chunk)
        used += len(chunk)
    return "\n\n".join(out) or "(no extracted text in this selection)"


def write_brief(items: list[Item], label: str, provider) -> tuple[str, str, str]:
    """(title, markdown body, produced_by) using a language model.

    The deterministic roll-up is still computed and still rendered -- the model
    contributes an opening paragraph and a themes list on top of it. Numbers
    stay arithmetic; prose comes from the model. Mixing those the other way
    round is how summaries end up confidently wrong about totals.
    """
    d = digest(items)
    prompt = BRIEF_PROMPT.format(
        label=label or "everything",
        digest=digest_text(d),
        excerpts=excerpts_text(items),
    )
    analysis = provider.analyse_text(prompt, "")
    title, body = compile_brief(items, label)

    head: list[str] = []
    if analysis.description:
        head.append(analysis.description.strip())
    if analysis.topics:
        head.append("**Recurring themes:** " + ", ".join(analysis.topics[:5]) + ".")
    if analysis.objects:
        head.append("**Mostly about:** " + ", ".join(analysis.objects[:6]) + ".")

    produced_by = analysis.source_id or "model"
    if head:
        body = "\n\n".join(head) + "\n\n---\n\n" + body
    return title, body, produced_by
