"""Pattern detectors: the structural evidence in a file's text.

The taxonomy in `taxonomy.py` asks *which words appear*. This module asks a
different and more reliable question: *what shape is this content*. A file with
forty lines that each begin with a timestamp and a severity is a log whatever
vocabulary it uses; a file containing `Invoice No: 4471` and `Total Due` is an
invoice even if the rest is in German.

Shape beats vocabulary for a specific reason worth stating: word counting is
fooled by discussion. An email *about* invoices scores as an invoice. A
structural pattern is not, because an email about invoices does not contain an
invoice number field followed by a currency total.

Every pattern here is:

* **named** -- it becomes a `pattern` tag, so "show me everything with
  monetary amounts in it" is a filter, not a re-scan;
* **weighted** -- it votes for a doctype and/or a topic, and the agent adds
  the votes up rather than letting the first match win;
* **quoted** -- it keeps a short sample of what matched, so the UI can explain
  a tag instead of asserting it.

Two detectors deliberately find things nobody asked for: `credentials` and
`national-id`. Athena stores only that the pattern fired and how many times,
never what it matched. Knowing "nine files in this folder contain what look
like API keys" is the entire value, and keeping copies of the keys in a second
database would be a remarkably poor way to deliver it.
"""

from __future__ import annotations

import calendar
import json
import re
from dataclasses import dataclass

MAX_SAMPLE = 60
#: Cap on how much text the detectors scan. Beyond this the marginal pattern
#: is vanishingly rare and the regex pass starts to show up in the profile.
MAX_SCAN = 400_000


@dataclass(frozen=True, slots=True)
class Pattern:
    name: str
    display: str
    regex: re.Pattern[str]
    #: Hits needed before the pattern is considered to have fired. Raised for
    #: patterns that occur incidentally -- one date in a memo means nothing,
    #: forty timestamped lines mean it is a log.
    min_hits: int = 1
    #: (doctype, weight per hit up to `vote_cap`).
    doctype: tuple[str, float] | None = None
    topic: tuple[str, float] | None = None
    vote_cap: int = 4
    #: Shown in the detail panel next to the tag.
    note: str = ""
    #: Match against the filename rather than the body.
    on_name: bool = False


@dataclass(slots=True)
class Hit:
    pattern: Pattern
    count: int
    sample: str = ""

    @property
    def name(self) -> str:
        return self.pattern.name


def _p(pattern: str, flags: int = re.IGNORECASE) -> re.Pattern[str]:
    return re.compile(pattern, flags)


# ---------------------------------------------------------------------------
#  The catalogue of shapes
# ---------------------------------------------------------------------------

PATTERNS: tuple[Pattern, ...] = (
    Pattern(
        "money", "Monetary amounts",
        _p(r"(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?"
           r"|\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|CAD|AUD|CHF|JPY)\b)"),
        min_hits=2, topic=("finance", 1.5),
        note="currency figures appear in the text",
    ),
    Pattern(
        "invoice-number", "Invoice reference",
        _p(r"\b(?:invoice|inv)\s*(?:number|no\.?|#)\s*[:\-]?\s*[A-Z0-9][A-Z0-9\-/]{2,}"),
        doctype=("invoice", 8.0), topic=("finance", 3.0),
        note="an invoice reference field",
    ),
    Pattern(
        "amount-due", "Amount due",
        _p(r"\b(?:total|amount|balance)\s+(?:due|payable|outstanding)\b"),
        doctype=("invoice", 6.0), topic=("finance", 2.0),
        note="a payable total",
    ),
    Pattern(
        "tax-id", "Tax registration",
        _p(r"\b(?:VAT|GST|EIN|TIN|ABN)\s*(?:number|no\.?|#|reg(?:istration)?)?"
           r"\s*[:\-]?\s*[A-Z0-9][A-Z0-9\- ]{5,}"),
        topic=("finance", 2.0),
        note="a tax registration number",
    ),
    Pattern(
        "iban", "Bank details",
        _p(r"\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b", re.NOFLAG),
        doctype=("statement", 3.0), topic=("finance", 2.0),
        note="something shaped like an IBAN",
    ),
    Pattern(
        "accounting-period", "Accounting period",
        _p(r"\b(?:Q[1-4]|FY)\s?(?:20)?\d{2}\b|\bfiscal\s+(?:year|quarter)\b"),
        topic=("finance", 2.0),
        note="a fiscal quarter or year",
    ),
    Pattern(
        "log-line", "Timestamped log lines",
        _p(r"^\s*(?:\[)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}", re.MULTILINE),
        min_hits=5, doctype=("log", 4.0), topic=("engineering", 1.5), vote_cap=6,
        note="lines that start with a timestamp",
    ),
    Pattern(
        "severity-level", "Severity levels",
        _p(r"\b(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b", re.NOFLAG),
        min_hits=4, doctype=("log", 2.5), topic=("engineering", 1.0), vote_cap=6,
        note="uppercase severity keywords",
    ),
    Pattern(
        "stack-trace", "Stack trace",
        _p(r"Traceback \(most recent call last\)"
           r"|^\s+at [\w$.]+\(.*?:\d+\)"
           r"|^\s+File \".*?\", line \d+", re.MULTILINE),
        doctype=("log", 7.0), topic=("engineering", 3.0),
        note="a stack trace",
    ),
    Pattern(
        "source-code", "Code",
        _p(r"^\s*(?:def |class |function |import |from \w+ import|#include"
           r"|public\s+(?:static|class)|const \w+\s?=|package \w+;)", re.MULTILINE),
        min_hits=3, doctype=("source-code", 4.0), topic=("engineering", 2.0),
        vote_cap=5, note="declarations in a programming language",
    ),
    Pattern(
        "sql", "SQL",
        _p(r"\bSELECT\b[\s\S]{0,200}?\bFROM\b|\b(?:CREATE|ALTER|DROP)\s+TABLE\b"),
        min_hits=2, topic=("engineering", 2.0),
        note="SQL statements",
    ),
    Pattern(
        "url", "Links",
        _p(r"https?://[\w.\-]+(?:/[\w./\-%?=&#+]*)?"),
        min_hits=2, note="web links",
    ),
    Pattern(
        "email-address", "Email addresses",
        _p(r"\b[\w.+\-]+@[\w\-]+\.[\w.\-]{2,}\b"),
        note="email addresses",
    ),
    Pattern(
        "phone-number", "Phone numbers",
        # The lookarounds are the whole trick here. Without them this fires on
        # the middle of any long digit group -- an IBAN, an account number, a
        # hash -- because "three runs of two-to-four digits" is exactly what
        # those look like. Requiring that the match is not itself surrounded by
        # further digits removed every false positive in the test corpus.
        # The trailing guard rejects a number that *continues*, not one that
        # merely ends a sentence: `(?![\d\-.])` would refuse to match
        # "(555) 123-4567." because of the full stop, which is where phone
        # numbers usually sit.
        _p(r"(?<![\d\-.])(?<!\d )"
           r"(?:\+\d{1,3}[ \-.]?)?(?:\(\d{2,4}\)|\d{2,4})[ \-.]"
           r"\d{3,4}[ \-.]?\d{3,4}"
           r"(?!\d)(?![-.]\d)(?! \d)"),
        min_hits=1, note="telephone numbers",
    ),
    Pattern(
        "ip-address", "IP addresses",
        _p(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
        min_hits=2, topic=("engineering", 1.0),
        note="IP addresses",
    ),
    Pattern(
        "signature-block", "Signature",
        _p(r"(?:^|\n)\s*(?:sincerely|yours faithfully|yours sincerely|best regards"
           r"|kind regards|regards|thanks|many thanks)\s*,?\s*\n"),
        doctype=("letter", 4.0),
        note="a closing signature",
    ),
    Pattern(
        "salutation", "Salutation",
        _p(r"(?:^|\n)\s*dear\s+(?:mr|mrs|ms|miss|dr|prof|sir|madam|colleagues|team|all)\b"),
        doctype=("letter", 4.0),
        note="an opening salutation",
    ),
    Pattern(
        "action-items", "Action items",
        _p(r"\baction\s+items?\b|\bfollow[- ]ups?\b|\bowner\s*[:|]"
           r"|^\s*(?:TODO|ACTION)\b", re.IGNORECASE | re.MULTILINE),
        doctype=("meeting-notes", 4.0),
        note="tracked actions",
    ),
    Pattern(
        "attendees", "Attendees",
        _p(r"\b(?:attendees|present|apologies|participants)\s*[:|]"),
        doctype=("meeting-notes", 5.0),
        note="an attendee list",
    ),
    Pattern(
        "legalese", "Legal boilerplate",
        _p(r"\b(?:hereinafter|hereunder|whereas|thereof|herein|in witness whereof"
           r"|shall be deemed|notwithstanding)\b"),
        min_hits=2, doctype=("contract", 4.0), topic=("legal", 3.0), vote_cap=5,
        note="contractual boilerplate",
    ),
    Pattern(
        "clause-numbering", "Numbered clauses",
        _p(r"^\s*\d+\.\d+(?:\.\d+)?\s+[A-Z]", re.MULTILINE),
        min_hits=4, doctype=("contract", 2.5), topic=("legal", 1.0),
        note="hierarchically numbered clauses",
    ),
    Pattern(
        "citation", "Citations",
        _p(r"\bet al\.?\b|\[\d{1,3}\]\s|\bdoi:\s?10\.\d{4,}"),
        min_hits=2, doctype=("paper", 3.0), topic=("research", 2.0),
        note="academic citations",
    ),
    Pattern(
        "table-row", "Tabular data",
        _p(r"^[^\n|]{1,60}(?:\s\|\s[^\n|]{1,60}){2,}$", re.MULTILINE),
        min_hits=3, doctype=("spreadsheet", 1.5), vote_cap=8,
        note="rows of tabular data",
    ),
    Pattern(
        "blank-field", "Fillable fields",
        _p(r"_{4,}|\.{6,}\s*$|\[\s*\]", re.MULTILINE),
        min_hits=4, doctype=("form", 4.0), vote_cap=6,
        note="blanks waiting to be filled in",
    ),
    Pattern(
        "percentage", "Percentages",
        _p(r"\b\d{1,3}(?:\.\d+)?\s?%"),
        min_hits=3, note="percentage figures",
    ),
    Pattern(
        "credentials", "Possible secrets",
        _p(r"\b(?:api[_ \-]?key|secret[_ \-]?key|access[_ \-]?token|client[_ \-]?secret"
           r"|password|passwd|bearer)\b\s*[:=]\s*\S{6,}"
           r"|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
           r"|\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})\b"),
        topic=("security", 4.0),
        note="text shaped like a credential -- worth reviewing",
    ),
    Pattern(
        "national-id", "Possible national ID",
        _p(r"\b\d{3}-\d{2}-\d{4}\b|\b[A-Z]{2}\d{6}[A-D]\b", re.NOFLAG),
        note="something shaped like a national insurance or social security number",
    ),
    Pattern(
        "date-of-birth", "Date of birth",
        _p(r"\b(?:date of birth|d\.?o\.?b\.?|born on)\b"),
        note="a date of birth field",
    ),
    Pattern(
        "medical-terms", "Clinical language",
        _p(r"\b(?:diagnosis|prescribed|dosage|mg\b|patient id|icd-?10|symptoms)\b"),
        min_hits=2, topic=("medical", 3.0),
        note="clinical vocabulary",
    ),
    Pattern(
        "screenshot-name", "Named as a screenshot",
        _p(r"screen[ _\-]?shot|screenshot|snip|capture[ _\-]?\d"),
        doctype=("screenshot", 8.0), on_name=True,
        note="the filename says screenshot",
    ),
    Pattern(
        "sequence-name", "Camera sequence name",
        _p(r"^(?:img|dsc|dcim|p|photo|vid|mov)[ _\-]?\d{3,}", re.IGNORECASE),
        on_name=True, note="a camera's own filename",
    ),
    Pattern(
        "version-name", "Versioned filename",
        _p(r"\b(?:v\d+(?:\.\d+)*|final|draft|rev\d+|copy|\(\d+\))\b"),
        on_name=True, note="a version or draft marker in the filename",
    ),
)

PATTERN_BY_NAME = {p.name: p for p in PATTERNS}


def detect(text: str, filename: str) -> list[Hit]:
    """Run every detector. Returns only the patterns that actually fired."""
    body = text[:MAX_SCAN] if text else ""
    lower_name = filename.lower()
    hits: list[Hit] = []
    for pattern in PATTERNS:
        subject = lower_name if pattern.on_name else body
        if not subject:
            continue
        found = pattern.regex.findall(subject)
        if len(found) < pattern.min_hits:
            continue
        first = found[0]
        if isinstance(first, tuple):
            first = next((part for part in first if part), "")
        hits.append(Hit(pattern, len(found), str(first).strip()[:MAX_SAMPLE]))
    return hits


# ---------------------------------------------------------------------------
#  Quantities worth pulling out as values, not just as flags
# ---------------------------------------------------------------------------

_MONEY = re.compile(
    r"(?P<sym>[$€£¥])\s?(?P<a>\d[\d,]*(?:\.\d{1,2})?)"
    r"|(?P<b>\d[\d,]*\.\d{2})\s?(?P<code>USD|EUR|GBP|CAD|AUD|CHF|JPY)",
    re.IGNORECASE,
)

_SYMBOL_CODE = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}


def money(text: str) -> dict[str, dict[str, float]]:
    """Currency amounts grouped by currency.

    `max` is the interesting one and the reason this is extracted as a value
    rather than a flag: on an invoice the largest figure is almost always the
    total, which makes "the biggest invoices in this folder" answerable without
    understanding invoices. Summing every figure on a page would instead
    double-count each line item plus the subtotal plus the total.
    """
    out: dict[str, list[float]] = {}
    for m in _MONEY.finditer(text[:MAX_SCAN]):
        raw = m.group("a") or m.group("b")
        code = _SYMBOL_CODE.get(m.group("sym") or "", "") or (m.group("code") or "").upper()
        try:
            value = float(raw.replace(",", ""))
        except (TypeError, ValueError):
            continue
        out.setdefault(code or "?", []).append(value)
    return {
        code: {"count": len(v), "max": max(v), "sum": round(sum(v), 2)}
        for code, v in out.items()
    }


_MONTHS = {
    m.lower(): i
    for i, m in enumerate(calendar.month_name)
    if m
} | {
    m.lower(): i
    for i, m in enumerate(calendar.month_abbr)
    if m
}

_DATE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), "ymd"),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b"), "dmy_or_mdy"),
    (re.compile(r"\b(\d{1,2})[ \-]([A-Za-z]{3,9})\.?[ \-](\d{4})\b"), "dmy_name"),
    (re.compile(r"\b([A-Za-z]{3,9})\.?[ \-](\d{1,2}),?[ \-]?(\d{4})\b"), "mdy_name"),
)

_FILENAME_DATE = re.compile(r"(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})")


def _epoch(year: int, month: int, day: int) -> int | None:
    if not (1900 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31):
        return None
    try:
        return calendar.timegm((year, month, day, 12, 0, 0, 0, 0, 0))
    except (ValueError, OverflowError):
        return None


def dates(text: str) -> list[int]:
    """Every plausible date in the text, as epoch seconds.

    Ambiguous `03/04/2024` is read day-first, which is wrong for roughly half
    the world. It is recorded anyway because the *year* is what the date facet
    groups by and the year is unambiguous either way -- and guessing a locale
    from the content would be a worse kind of wrong, silently.
    """
    found: list[int] = []
    body = text[:MAX_SCAN]
    for pattern, kind in _DATE_PATTERNS:
        for m in pattern.finditer(body):
            a, b, c = m.groups()
            stamp = None
            if kind == "ymd":
                stamp = _epoch(int(a), int(b), int(c))
            elif kind == "dmy_or_mdy":
                stamp = _epoch(int(c), int(b), int(a)) or _epoch(int(c), int(a), int(b))
            elif kind == "dmy_name":
                month = _MONTHS.get(b.lower())
                stamp = _epoch(int(c), month, int(a)) if month else None
            elif kind == "mdy_name":
                month = _MONTHS.get(a.lower())
                stamp = _epoch(int(c), month, int(b)) if month else None
            if stamp:
                found.append(stamp)
            if len(found) >= 500:
                return found
    return found


def date_in_name(filename: str) -> int | None:
    m = _FILENAME_DATE.search(filename)
    if not m:
        return None
    return _epoch(int(m.group(1)), int(m.group(2)), int(m.group(3)))


# ---------------------------------------------------------------------------
#  Who and what is named
# ---------------------------------------------------------------------------

_ORG = re.compile(
    r"\b([A-Z][\w&.'\-]*(?:[ ][A-Z][\w&.'\-]*){0,3})[ ]"
    r"(Inc|Incorporated|LLC|LLP|Ltd|Limited|GmbH|PLC|Corp|Corporation|Company"
    r"|Holdings|Partners|Group|University|Institute|Foundation|Bank|Trust)\b\.?"
)

# A bare "by" is deliberately not in here. It matches "executed by Acme
# Holdings Ltd" and "signed by the Supplier", which then become the document's
# author -- and a company filed as a person is worse than no author at all,
# because it pollutes the facet everyone is meant to filter by. Only phrases
# that specifically claim authorship qualify, plus a line-initial "From:".
_BYLINE = re.compile(
    r"(?:\b(?:author|authored by|prepared by|written by|submitted by"
    r"|created by|reported by|presented by)"
    r"|(?:^|\n)\s*from)\s*[:\-]?\s*"
    r"([A-Z][\w.'\-]+(?:[ \t]+[A-Z][\w.'\-]+){0,2})",
    re.IGNORECASE,
)

#: Corporate suffixes. A candidate ending in one of these is an organisation,
#: whatever anchored it.
_CORPORATE = re.compile(
    r"\b(?:inc|incorporated|llc|llp|ltd|limited|gmbh|plc|corp|corporation"
    r"|company|holdings|partners|group|university|institute|foundation"
    r"|bank|trust|associates|solutions|services|technologies|systems)\b\.?$",
    re.IGNORECASE,
)

_SIGNOFF = re.compile(
    r"(?:sincerely|yours faithfully|yours sincerely|best regards|kind regards"
    r"|regards|many thanks|thanks)\s*,?\s*\n+\s*"
    r"([A-Z][\w.'\-]+(?:[ \t]+[A-Z][\w.'\-]+){0,2})",
    re.IGNORECASE,
)

_EMAIL = re.compile(r"\b([\w.+\-]+)@([\w\-]+)\.[\w.\-]{2,}\b")

#: Words that look like names at the start of a line but are not.
_NOT_A_NAME = frozenset("""
the this that these those page total subject date from to cc bcc re fwd
dear sincerely regards thanks note please invoice receipt report summary
confidential draft final copyright all rights reserved company customer
client project chapter section appendix figure table
""".split())


def _plausible_name(candidate: str) -> bool:
    parts = candidate.split()
    if not parts or len(parts) > 3:
        return False
    if any(p.lower() in _NOT_A_NAME for p in parts):
        return False
    if any(len(p) < 2 for p in parts):
        return False
    if _CORPORATE.search(candidate):
        return False
    return all(p[0].isupper() for p in parts)


def organisations(text: str) -> list[str]:
    """Named organisations, deduplicated, most frequent first."""
    counts: dict[str, int] = {}
    for m in _ORG.finditer(text[:MAX_SCAN]):
        name = f"{m.group(1)} {m.group(2)}".strip().rstrip(".")
        if len(name) > 60:
            continue
        counts[name] = counts.get(name, 0) + 1
    return [n for n, _ in sorted(counts.items(), key=lambda kv: -kv[1])[:12]]


def people(text: str) -> list[tuple[str, str]]:
    """(name, where it came from) for person names, best evidence first."""
    body = text[:MAX_SCAN]
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def push(name: str, source: str) -> None:
        clean = " ".join(name.split()).strip(".,;:")
        key = clean.lower()
        if clean and key not in seen and _plausible_name(clean):
            seen.add(key)
            out.append((clean, source))

    for m in _SIGNOFF.finditer(body):
        push(m.group(1), "signature")
    for m in _BYLINE.finditer(body):
        push(m.group(1), "byline")
    for m in _EMAIL.finditer(body):
        local = m.group(1)
        if "." in local or "_" in local:
            push(" ".join(p.capitalize() for p in re.split(r"[._]", local) if p), "email")
    return out[:12]


def name_from_filename(filename: str) -> str | None:
    """`Q3 Report - Jane Doe.docx` -> `Jane Doe`.

    Only the separated-tail convention, because it is the only one that is
    actually a convention. Guessing at `jdoe_report_final_v2` produces
    confident nonsense, and a wrong author is worse than no author -- it puts
    the file in someone else's filter.
    """
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", filename)
    for sep in (" - ", " by ", " -- ", "_-_"):
        if sep in stem.lower():
            index = stem.lower().rindex(sep)
            tail = stem[index + len(sep):].strip()
            if _plausible_name(tail) and len(tail.split()) >= 2:
                return tail
    return None


def as_json(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)
