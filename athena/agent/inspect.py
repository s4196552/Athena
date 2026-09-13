"""The inspection agent.

Parsing answers *what is in this file*. This answers *what is this file*, which
is a different question and the one a person actually asks. It runs after the
parsers, over the text and metadata they already produced, and decides:

    doctype   what the file is        invoice, deck, log, CV
    topic     what it is about        finance, legal, engineering
    author    who made it            from metadata, a signature, a filename
    date      when it is about       from metadata, the text, the filename
    patterns  what shape it has      monetary amounts, stack traces, secrets
    entities  who is named in it     organisations and people

It is an agent rather than an extractor in one specific sense: it does not
compute a fixed output from a fixed input. It gathers evidence, weighs sources
against each other, decides whether it is confident, and *escalates to a
language model only when it is not*. That last part is the whole design.

    rules alone      ~3 ms per file, no GPU, no API key, no network
    rules + model    the model is asked about the residue -- typically the
                     10-20% of files the lexicons cannot separate

Which means the feature works on a laptop with nothing installed, and spending
money makes it better rather than making it work. A classifier that phones a
vendor for all 100,000 files to discover that 40,000 of them are named
`invoice-*.pdf` is not a smarter design, just a more expensive one.

Every verdict carries its reasoning. `agent_finding.decided_by` and
`reasoning` are written on every row, so the UI can answer "why is this
tagged Finance?" with the actual evidence rather than a shrug. A verdict whose
workings are visible is one a user can correct -- which is what the custom
tags are for.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from . import patterns as pat
from . import taxonomy as tax

#: Below this, the agent says it does not know rather than guessing. A wrong
#: confident label is worse than an absent one: it puts a file into a filter
#: where someone will fail to find it, and they will never think to look in
#: the bucket it was wrongly placed in.
MIN_SCORE = 6.0

#: Below this the rules are "unsure" and a model is worth asking, if one is
#: configured. Above it, escalating would spend money to confirm what the
#: filename already said.
ESCALATE_BELOW = 14.0

#: Confidence floor for a *relative* winner. A category needs this share of
#: the total score on its axis, otherwise the axis is genuinely ambiguous --
#: a finance-and-legal contract should not be silently filed as one or other.
MIN_SHARE = 0.34

#: Text beyond this is not read. Classification signal saturates early; the
#: first few thousand words of a document decide it, and a 400-page scan adds
#: latency without changing the answer.
MAX_TEXT = 120_000


@dataclass(slots=True)
class Evidence:
    """Everything the agent is allowed to look at. No file handles, no DB."""

    filename: str = ""
    rel_path: str = ""
    ext: str = ""
    media_type: str = "other"
    size_bytes: int = 0
    text: str = ""
    #: Straight from the container: PDF /Author, DOCX core properties, ID3.
    meta: dict[str, object] = field(default_factory=dict)

    @property
    def name_key(self) -> str:
        """Filename and parent folder, lowercased. The folder matters: a file
        inside `2024/Invoices/` is evidence about the file even when the file
        itself is called `scan0042.pdf`, which is exactly what a scanner names
        things."""
        return f"{self.rel_path} {self.filename}".lower().replace("\\", "/")


@dataclass(slots=True)
class Verdict:
    doctype: str | None = None
    doctype_score: float = 0.0
    topic: str | None = None
    topic_score: float = 0.0
    author: str | None = None
    author_source: str | None = None
    event_at: int | None = None
    event_source: str | None = None
    patterns: list[str] = field(default_factory=list)
    entities: list[str] = field(default_factory=list)
    people: list[str] = field(default_factory=list)
    numbers: dict[str, object] = field(default_factory=dict)
    years: list[int] = field(default_factory=list)
    #: Topics that scored but did not win the axis. Kept as tags so a
    #: finance-and-legal contract is findable under both, while the single
    #: `topic` column stays unambiguous for grouping and for the graph.
    extra_topics: list[str] = field(default_factory=list)
    decided_by: str = "rules"
    reasoning: str = ""
    escalated: bool = False

    @property
    def unsure(self) -> bool:
        """True when a language model would add something.

        Note what does *not* count as unsure: a file with no text at all. A
        3 MB JPEG with no EXIF has nothing for a text classifier to work with
        either, so escalating it would spend a call to learn nothing.
        """
        return self.topic_score < ESCALATE_BELOW or self.doctype is None

    def is_empty(self) -> bool:
        return not (self.doctype or self.topic or self.author or self.patterns
                    or self.entities or self.event_at)


# ---------------------------------------------------------------------------
#  Step 1-2: observe, then detect shape
# ---------------------------------------------------------------------------


def inspect(ev: Evidence) -> Verdict:
    """Run the deterministic pass. Never raises; returns what it found."""
    text = ev.text[:MAX_TEXT]
    name = ev.name_key
    hits = pat.detect(text, name)
    verdict = Verdict(patterns=[h.name for h in hits])

    # -- classify -----------------------------------------------------------
    # Two sources of evidence per axis, added rather than ranked: lexicon hits
    # (what words appear) and pattern votes (what shape the content is). The
    # patterns are weighted higher because they are much harder to trigger by
    # accident -- see the module docstring in patterns.py.
    doctype_scores = dict(tax.rank(text, name, ev.ext, "doctype"))
    topic_scores = dict(tax.rank(text, name, ev.ext, "topic"))

    for hit in hits:
        if hit.pattern.doctype:
            label, weight = hit.pattern.doctype
            votes = min(hit.count, hit.pattern.vote_cap)
            doctype_scores[label] = doctype_scores.get(label, 0.0) + weight * votes
        if hit.pattern.topic:
            label, weight = hit.pattern.topic
            votes = min(hit.count, hit.pattern.vote_cap)
            topic_scores[label] = topic_scores.get(label, 0.0) + weight * votes

    verdict.doctype, verdict.doctype_score = _decide(doctype_scores)
    verdict.topic, verdict.topic_score = _decide(topic_scores)
    verdict.extra_topics = [
        name for name, score in sorted(topic_scores.items(), key=lambda kv: -kv[1])[:4]
        if name != verdict.topic and score >= MIN_SCORE
    ]

    # Media type carries a fact the text cannot: an untitled JPEG with no
    # distinguishing words is still a photograph, and leaving its doctype null
    # would put every holiday snap in the library outside the facet entirely.
    if verdict.doctype is None:
        fallback = {"image": "photo", "video": "recording", "audio": "recording"}
        guess = fallback.get(ev.media_type)
        if guess:
            verdict.doctype, verdict.doctype_score = guess, MIN_SCORE

    # -- resolve the author -------------------------------------------------
    verdict.author, verdict.author_source = _resolve_author(ev, text)

    # -- resolve the date the content is *about* ---------------------------
    verdict.event_at, verdict.event_source, verdict.years = _resolve_date(ev, text)

    # -- names and quantities ----------------------------------------------
    verdict.entities = pat.organisations(text)
    named = pat.people(text)
    verdict.people = [n for n, _ in named]
    amounts = pat.money(text)
    if amounts:
        verdict.numbers["money"] = amounts
    counts = {h.name: h.count for h in hits if h.count > 1}
    if counts:
        verdict.numbers["patterns"] = counts
    if text:
        verdict.numbers["words"] = len(text.split())

    verdict.reasoning = _explain(verdict, hits, ev)
    return verdict


def _decide(scores: dict[str, float]) -> tuple[str | None, float]:
    """Pick a winner, or decline to.

    Declining is a first-class outcome. Two conditions have to hold: the
    winner must clear an absolute floor (there is enough evidence at all) and
    it must hold a big enough share of the axis (the evidence points somewhere
    in particular rather than everywhere at once).
    """
    if not scores:
        return None, 0.0
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    best, score = ranked[0]
    total = sum(max(s, 0.0) for s in scores.values()) or 1.0
    if score < MIN_SCORE or score / total < MIN_SHARE:
        return None, score
    return best, round(score, 2)


# ---------------------------------------------------------------------------
#  Step 3: whose is it
# ---------------------------------------------------------------------------

#: Producer strings that are software, not people. `doc_meta.creator` is the
#: application for a PDF and the last editor for a DOCX, so it has to be
#: filtered rather than trusted -- otherwise the author facet fills up with
#: "Microsoft Word" and the feature is worthless.
_SOFTWARE = re.compile(
    r"microsoft|adobe|acrobat|word|excel|powerpoint|libreoffice|openoffice"
    r"|google|docs|pages|keynote|latex|pdflatex|tex|ghostscript|quartz"
    r"|pdfium|skia|chrome|canva|figma|scanner|scansnap|epson|canon|hp\b"
    r"|printer|distiller|writer|producer|unknown|admin|user|owner|none"
    r"|python|reportlab|openpyxl|xlsxwriter|pandoc|wkhtmltopdf|weasyprint"
    r"|imagemagick|ffmpeg|pillow|jasper|itext|fpdf|tcpdf|prince|chromium",
    re.IGNORECASE,
)

#: Placeholders that mean "no author was recorded" while technically being a
#: value. Every document toolchain has its own, and they arrive through the
#: same field a real name would, so the only way to tell them apart is to know
#: them. Anything fully parenthesised is treated the same way: "(anonymous)",
#: "(unspecified)", "(none)" are all the field admitting it is empty.
_PLACEHOLDER = re.compile(
    r"^\(.*\)$|^(?:anonymous|unspecified|untitled|not set|n/?a|null|nil|tbd"
    r"|default|test|sample|example|author|creator|me|self)$",
    re.IGNORECASE,
)


def _looks_like_a_person(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    name = " ".join(value.split()).strip(" .,;:-_")
    if not (2 <= len(name) <= 60):
        return None
    if _SOFTWARE.search(name) or _PLACEHOLDER.match(name):
        return None
    if not any(ch.isalpha() for ch in name):
        return None
    # A single lowercase token carrying a hyphen or a digit is a package or a
    # build identifier -- "python-docx", "pdfkit2", "libreoffice7". People's
    # names have neither, and the ones that do (a username) are not worth the
    # false positives they bring with them.
    if " " not in name and name.islower() and any(
        ch.isdigit() or ch == "-" for ch in name
    ):
        return None
    # An email address in an author field is a person, just written oddly.
    if "@" in name:
        local = name.split("@")[0]
        parts = [p for p in re.split(r"[._\-]", local) if p]
        if len(parts) >= 2:
            return " ".join(p.capitalize() for p in parts)
        return local.capitalize()
    return name


def _resolve_author(ev: Evidence, text: str) -> tuple[str | None, str | None]:
    """Best available source, in order of how much it deserves trust.

    Embedded metadata first -- whoever saved the file said so explicitly.
    Then the document's own signature or byline, which is the author's own
    claim in the body. Then the filename convention, then an email address.
    The ordering is the point: a file whose properties say "Jane Doe" should
    not be reattributed because someone's address appears in the footer.
    """
    for key, source in (
        ("author", "metadata"),
        ("artist", "id3"),
        ("album_artist", "id3"),
        ("creator", "metadata"),
    ):
        name = _looks_like_a_person(ev.meta.get(key))
        if name:
            return name, source

    for name, source in pat.people(text):
        if source in ("signature", "byline"):
            return name, source

    from_name = pat.name_from_filename(ev.filename)
    if from_name:
        return from_name, "filename"

    for name, source in pat.people(text):
        if source == "email":
            return name, source

    return None, None


# ---------------------------------------------------------------------------
#  Step 4: when is it about
# ---------------------------------------------------------------------------


#: A `created` timestamp this far from every date in the document's own text is
#: not describing this document. One year is chosen because a genuine document
#: and the dates inside it are normally within months of each other, while
#: template inheritance is normally out by many years.
CORROBORATION_WINDOW_S = 365 * 24 * 3600


def _resolve_date(ev: Evidence, text: str) -> tuple[int | None, str | None, list[int]]:
    """The date the *content* concerns, which is rarely the file's mtime.

    A scanned 2019 invoice filed last Tuesday has an mtime of last Tuesday,
    and sorting a library by mtime puts it next to this week's photographs.
    The date inside the document is the one a person means. mtime is still
    recorded on `file`; it is simply not the answer to this question.

    The source ordering is the interesting part, and it is not the obvious one.

    `captured_at` from a camera is trusted outright -- the clock was set by the
    device at the moment of capture and there is nothing better available.

    `doc_created_at` is **not**, and the reason is templates. Office documents
    inherit the `created` property of the template they were made from, so a
    deck written this morning from a corporate template routinely reports a
    creation date years old. Every DOCX built by `python-docx` in this
    project's own fixtures dates itself to 2013 for exactly this reason. So the
    embedded date is used only when the document's own text corroborates it;
    otherwise the text wins and `event_source` says so.

    Every year mentioned is returned alongside the single best date, because a
    contract covering 2023-2026 belongs in all four year filters, not only the
    one its header happens to lead with.
    """
    found = pat.dates(text)
    years = {_year(stamp) for stamp in found} - {None}

    def result(stamp: int | None, source: str | None):
        if stamp:
            year = _year(stamp)
            if year:
                years.add(year)
        return stamp, source, sorted(y for y in years if y)      # type: ignore[misc]

    captured = ev.meta.get("captured_at")
    if isinstance(captured, (int, float)) and captured > 0:
        return result(int(captured), "capture time")

    # The most frequently repeated date, not the first: a report's header date
    # appears once, while the period it covers appears throughout.
    best_text = Counter(found).most_common(1)[0][0] if found else None

    created = ev.meta.get("doc_created_at")
    if isinstance(created, (int, float)) and created > 0:
        stamp = int(created)
        corroborated = best_text is None or any(
            abs(stamp - candidate) <= CORROBORATION_WINDOW_S for candidate in found
        )
        if corroborated:
            return result(stamp, "document properties")
        years.add(_year(stamp))  # type: ignore[arg-type]
        return result(best_text, "text")

    if best_text is not None:
        return result(best_text, "text")

    in_name = pat.date_in_name(ev.filename)
    if in_name:
        return result(in_name, "filename")

    modified = ev.meta.get("doc_modified_at")
    if isinstance(modified, (int, float)) and modified > 0:
        return result(int(modified), "document properties")

    return result(None, None)


def _year(stamp: int | None) -> int | None:
    if not stamp:
        return None
    import time

    try:
        return time.gmtime(stamp).tm_year
    except (ValueError, OSError, OverflowError):
        return None


# ---------------------------------------------------------------------------
#  Step 5: say why
# ---------------------------------------------------------------------------


def _explain(verdict: Verdict, hits: list[pat.Hit], ev: Evidence) -> str:
    """One line a person can check the agent's work against."""
    doctype = tax.display_of(verdict.doctype, "doctype") if verdict.doctype else ""
    topic = tax.display_of(verdict.topic, "topic").lower() if verdict.topic else ""
    # Parenthesised rather than slash-separated: several display names contain
    # a slash themselves ("CV / Resume"), and "CV / Resume / people & hr" reads
    # as three labels rather than one classification on two axes.
    if doctype and topic:
        head = f"{doctype} ({topic})"
    else:
        head = doctype or topic or "no confident classification"

    notes = [h.pattern.note for h in sorted(hits, key=lambda h: -h.count)
             if h.pattern.note][:3]
    why = "; ".join(notes)

    if verdict.author:
        why = f"{why}; author from {verdict.author_source}" if why else \
              f"author from {verdict.author_source}"
    if not why:
        why = f"{ev.ext or ev.media_type} with no distinctive content"
    return f"{head} -- {why}"[:500]


# ---------------------------------------------------------------------------
#  Escalation: what to ask a model, and what to do with the answer
# ---------------------------------------------------------------------------

CLASSIFY_PROMPT_TEMPLATE = """Classify this file for a searchable library. Answer only from what is here.

Put your answers in these fields:
  scene       -- what the file IS, one of: {doctypes}
  topics      -- what it is ABOUT, one to three of: {topics}
  objects     -- organisations and people named in it, as written
  description -- one sentence on what this file is and who it is for
  text        -- leave empty

Use only the listed words for `scene` and `topics`. If none fits, leave the
field empty rather than inventing a label. Do not guess at anything not
present in the content below.

Filename: {filename}
"""


def classify_prompt(filename: str = "") -> str:
    """The escalation prompt.

    The field mapping is deliberate and worth being explicit about, because it
    looks like a hack and is a choice. Athena has exactly one response schema
    shared by every provider -- local Ollama constrains decoding with it, and
    each cloud vendor gets the same JSON schema, which is why swapping backends
    is one environment variable. Adding a second schema would mean threading it
    through four provider implementations, two of which cannot be tested
    without a paid key.

    So the existing five fields are reused with a prompt that states plainly
    what each one means here: `scene` (the setting of a photo) carries the
    doctype, `topics` carries topics, `objects` (things visible) carries named
    entities. The model is told the closed vocabulary, and `taxonomy.match()`
    enforces it on the way back regardless of what arrives.
    """
    return CLASSIFY_PROMPT_TEMPLATE.format(
        doctypes=", ".join(c.name for c in tax.DOCTYPES),
        topics=", ".join(c.name for c in tax.TOPICS),
        filename=filename or "(unknown)",
    )


def merge_model_answer(verdict: Verdict, analysis, *, source: str) -> Verdict:
    """Fold a model's answer into a rules verdict.

    The model does not get to overwrite a confident rule. It fills gaps, and
    it breaks ties. A regex that found `Invoice No: 4471` is better evidence
    than a language model's impression of the same page, and letting the model
    win there would make the output non-reproducible for no gain.
    """
    verdict.escalated = True
    verdict.decided_by = source

    doctype = next(
        (m for m in (tax.match(analysis.scene or "", axis="doctype"),) if m), None
    )
    if doctype is None:
        doctype = next(
            (m for m in (tax.match(t, axis="doctype") for t in analysis.topics) if m),
            None,
        )
    if doctype and (verdict.doctype is None or verdict.doctype_score < MIN_SCORE):
        verdict.doctype = doctype
        verdict.doctype_score = max(verdict.doctype_score, MIN_SCORE)

    topics = [m for m in (tax.match(t, axis="topic") for t in analysis.topics) if m]
    if topics and (verdict.topic is None or verdict.topic_score < ESCALATE_BELOW):
        verdict.topic = topics[0]
        verdict.topic_score = max(verdict.topic_score, MIN_SCORE)
    for extra in topics[1:4]:
        if extra != verdict.topic and extra not in verdict.extra_topics:
            verdict.extra_topics.append(extra)

    for entity in analysis.objects[:8]:
        clean = " ".join(str(entity).split())[:60]
        if clean and clean.lower() not in {e.lower() for e in verdict.entities}:
            verdict.entities.append(clean)

    if analysis.description:
        verdict.reasoning = f"{analysis.description.strip()[:300]} (model)"
    return verdict
