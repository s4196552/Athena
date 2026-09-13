"""The vocabulary the inspection agent is allowed to use.

Two axes, kept separate on purpose:

* **doctype** -- what the file *is*: an invoice, a deck, a log, a CV.
* **topic**   -- what it is *about*: finance, legal, engineering, HR.

Collapsing them into one list of "tags" is the obvious shortcut and it ruins
the filter. "Finance" and "presentation" are not alternatives -- the useful
query is *both at once*, "the finance decks", and that only works if they live
on different axes. The rail renders them as separate groups for the same
reason.

A closed vocabulary is also what makes the tags worth filtering by. A model
asked for free-form topics returns "finance", "financial", "finances" and
"budgeting" across four files that belong in one bucket; every label here,
whether it came from a regex or from a language model, is resolved back into
this list or dropped. That resolution is `match()` at the bottom of the file.

Scoring is deliberately dull: count whole-word hits, cap each term's
contribution, sum. It runs on text already in memory in a few milliseconds, it
is reproducible, and it needs no model download -- which is what lets the
feature work on a machine with no GPU and no API key, and get *better* rather
than start working when one is present.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

#: One term can contribute at most this many hits. Without the cap, a 40-page
#: ledger that says "invoice" 300 times drowns out every other signal in every
#: other category, and a document's shape stops mattering at all.
TERM_CAP = 4


@dataclass(frozen=True, slots=True)
class Category:
    name: str
    display: str
    #: Whole-word cues. Multi-word entries match across a single space run.
    terms: tuple[str, ...] = ()
    #: Cues worth more than one hit -- near-unambiguous giveaways.
    strong: tuple[str, ...] = ()
    #: Filename cues. A file called `invoice-4471.pdf` is evidence even when
    #: the text layer is empty, which is exactly the scanned-receipt case.
    filename: tuple[str, ...] = ()
    #: Extensions that imply the category outright.
    exts: frozenset[str] = field(default_factory=frozenset)

    def score(self, text: str, name: str, ext: str) -> float:
        total = 0.0
        if ext and ext in self.exts:
            total += 6.0
        for term in self.strong:
            total += 3.0 * min(_count(text, term), TERM_CAP)
        for term in self.terms:
            total += 1.0 * min(_count(text, term), TERM_CAP)
        for cue in self.filename:
            if cue in name:
                total += 4.0
        return total


@lru_cache(maxsize=4096)
def _word(term: str) -> re.Pattern[str]:
    # A plain \b fails on terms that end in punctuation, and multi-word terms
    # need to tolerate the newline where a PDF wrapped the line.
    body = r"\s+".join(re.escape(part) for part in term.split())
    return re.compile(r"(?<!\w)" + body + r"(?!\w)", re.IGNORECASE)


def _count(text: str, term: str) -> int:
    return len(_word(term).findall(text)) if text else 0


# ---------------------------------------------------------------------------
#  What the file is
# ---------------------------------------------------------------------------

DOCTYPES: tuple[Category, ...] = (
    Category(
        "invoice", "Invoice",
        strong=("invoice number", "invoice no", "amount due", "total due",
                "balance due", "remit to", "payment terms", "net 30", "bill to"),
        terms=("invoice", "subtotal", "vat", "gst", "purchase order",
               "po number", "due date", "quantity", "unit price"),
        filename=("invoice", "inv-", "inv_", "bill"),
    ),
    Category(
        "receipt", "Receipt",
        strong=("thank you for your purchase", "order confirmation",
                "transaction id", "card ending", "change due", "cashier"),
        terms=("receipt", "order number", "merchant", "refund", "subtotal",
               "tendered", "auth code"),
        filename=("receipt", "order"),
    ),
    Category(
        "statement", "Statement",
        strong=("account summary", "closing balance", "opening balance",
                "statement period", "available credit", "minimum payment"),
        terms=("statement", "account number", "deposits", "withdrawals",
               "interest", "transactions", "sort code", "iban"),
        filename=("statement", "stmt"),
    ),
    Category(
        "contract", "Contract",
        strong=("hereinafter", "whereas", "in witness whereof", "governing law",
                "the parties agree", "shall be deemed", "indemnify",
                "termination for convenience", "entire agreement"),
        terms=("agreement", "contract", "clause", "parties", "liability",
               "confidentiality", "warranty", "jurisdiction", "effective date",
               "executed"),
        filename=("contract", "agreement", "nda", "msa", "sow", "terms"),
    ),
    Category(
        "report", "Report",
        strong=("executive summary", "key findings", "recommendations",
                "table of contents", "appendix", "methodology"),
        terms=("report", "analysis", "overview", "summary", "conclusion",
               "quarter", "annual", "performance", "metrics", "kpi"),
        filename=("report", "review", "analysis", "q1", "q2", "q3", "q4"),
    ),
    Category(
        "presentation", "Presentation",
        strong=("agenda slide", "thank you questions", "next steps",
                "our mission", "key takeaways"),
        terms=("slide", "agenda", "roadmap", "vision", "takeaway", "appendix"),
        filename=("deck", "slides", "presentation", "pitch", "kickoff",
                  "all hands", "allhands", "townhall"),
        exts=frozenset({"pptx", "ppt", "key", "odp"}),
    ),
    Category(
        "spreadsheet", "Spreadsheet",
        terms=("total", "sum", "row", "column", "sheet", "average"),
        filename=("sheet", "table", "export", "tracker"),
        exts=frozenset({"xlsx", "xls", "csv", "tsv", "ods"}),
    ),
    Category(
        "log", "Log",
        strong=("stack trace", "exception in thread", "connection refused",
                "segmentation fault", "traceback"),
        terms=("error", "warn", "warning", "info", "debug", "trace", "fatal",
               "exception", "timeout", "retry", "request", "response", "status"),
        filename=("log", "logs", "syslog", "stderr", "stdout", "crash",
                  "dump", "trace"),
        exts=frozenset({"log"}),
    ),
    Category(
        "source-code", "Source code",
        strong=("public static void", "def ", "function ", "#include",
                "import ", "class ", "const ", "namespace "),
        terms=("var", "let", "null", "true", "false", "async", "await", "self",
               "params", "endpoint", "return"),
        filename=(".py", ".js", ".ts", ".java", ".go", ".rs", ".cpp",
                  ".rb", ".cs", ".sh", ".sql"),
        exts=frozenset({"py", "js", "ts", "tsx", "jsx", "java", "go", "rs", "c",
                        "h", "cpp", "rb", "cs", "sh", "ps1", "sql", "json",
                        "yaml", "yml", "toml"}),
    ),
    Category(
        "resume", "CV / Resume",
        strong=("curriculum vitae", "work experience", "professional experience",
                "references available", "career objective", "employment history"),
        terms=("resume", "education", "skills", "certifications", "achievements",
               "responsibilities", "bachelor", "master", "graduated"),
        filename=("resume", "cv", "curriculum"),
    ),
    Category(
        "letter", "Letter",
        strong=("dear sir", "dear madam", "yours sincerely", "yours faithfully",
                "kind regards", "to whom it may concern", "best regards"),
        terms=("dear", "sincerely", "regards", "enclosed", "writing to"),
        filename=("letter", "cover", "memo"),
    ),
    Category(
        "meeting-notes", "Meeting notes",
        strong=("action items", "attendees", "minutes of the meeting",
                "apologies for absence", "follow up items", "decisions made"),
        terms=("meeting", "agenda", "notes", "discussion", "owner", "standup",
               "retro", "retrospective"),
        filename=("notes", "minutes", "meeting", "standup", "retro"),
    ),
    Category(
        "form", "Form",
        strong=("please complete", "for office use only", "signature date",
                "tick as appropriate", "check all that apply"),
        terms=("form", "applicant", "please print", "required", "surname",
               "date of birth"),
        filename=("form", "application", "questionnaire", "survey"),
    ),
    Category(
        "paper", "Paper",
        strong=("abstract", "et al", "literature review", "we propose",
                "related work", "future work", "doi"),
        terms=("hypothesis", "methodology", "experiment", "dataset", "results",
               "citation", "references", "journal", "arxiv"),
        filename=("paper", "thesis", "dissertation", "arxiv", "preprint"),
    ),
    Category(
        "manual", "Manual",
        strong=("getting started", "troubleshooting", "before you begin",
                "safety instructions", "step by step"),
        terms=("manual", "guide", "instructions", "installation", "setup",
               "configuration", "requirements", "caution", "chapter"),
        filename=("manual", "guide", "handbook", "readme", "howto", "docs"),
    ),
    Category(
        "policy", "Policy",
        strong=("this policy applies", "scope and purpose", "code of conduct",
                "acceptable use", "compliance with"),
        terms=("policy", "procedure", "guideline", "mandatory", "compliance",
               "governance", "retention"),
        filename=("policy", "procedure", "compliance"),
    ),
    Category(
        "proposal", "Proposal",
        strong=("statement of work", "scope of work", "deliverables",
                "proposed approach", "timeline and milestones"),
        terms=("proposal", "quotation", "estimate", "tender", "scope",
               "assumptions", "milestone"),
        filename=("proposal", "quote", "rfp", "estimate"),
    ),
    Category(
        "transcript", "Transcript",
        strong=("speaker 1", "speaker 2", "inaudible", "crosstalk"),
        terms=("transcript", "interview", "recording", "verbatim", "timestamp"),
        filename=("transcript", "interview", "recording"),
        exts=frozenset({"srt", "vtt"}),
    ),
    Category(
        "screenshot", "Screenshot",
        filename=("screenshot", "screen shot", "screen_shot", "snip", "capture"),
    ),
    # Assigned from media type rather than from content: an untitled holiday
    # photo has no distinguishing words, and leaving its doctype null would put
    # every snapshot in the library outside the facet entirely.
    Category("photo", "Photo", filename=("photo", "pic", "img")),
    Category("recording", "Recording", filename=("recording", "audio", "video")),
    Category(
        "certificate", "Certificate",
        strong=("this certifies that", "hereby certifies", "certificate of"),
        terms=("certificate", "certification", "awarded", "valid until",
               "credential", "diploma"),
        filename=("certificate", "cert", "diploma", "licence", "license"),
    ),
)


# ---------------------------------------------------------------------------
#  What the file is about
# ---------------------------------------------------------------------------

TOPICS: tuple[Category, ...] = (
    Category(
        "finance", "Finance",
        strong=("balance sheet", "income statement", "cash flow", "ebitda",
                "gross margin", "profit and loss", "accounts payable",
                "accounts receivable", "fiscal year", "amount due"),
        terms=("invoice", "revenue", "expense", "budget", "forecast", "cost",
               "payment", "tax", "vat", "ledger", "transaction", "interest",
               "capital", "depreciation", "opex", "capex", "variance",
               "margin", "valuation", "funding", "payroll"),
        filename=("finance", "budget", "invoice", "expense", "payroll",
                  "accounts", "tax"),
    ),
    Category(
        "legal", "Legal",
        strong=("governing law", "hereinafter", "in witness whereof",
                "intellectual property", "limitation of liability",
                "force majeure", "dispute resolution"),
        terms=("agreement", "contract", "clause", "liability", "warranty",
               "indemnity", "litigation", "counsel", "statute", "regulation",
               "jurisdiction", "plaintiff", "defendant", "trademark",
               "copyright", "patent"),
        filename=("legal", "contract", "nda", "agreement", "terms"),
    ),
    Category(
        "hr", "People & HR",
        strong=("employment agreement", "performance review", "notice period",
                "annual leave", "probation period", "onboarding"),
        terms=("employee", "candidate", "recruiter", "salary", "benefits",
               "sick leave", "appraisal", "promotion", "headcount", "hiring",
               "resignation", "offer letter"),
        filename=("hr", "people", "hiring", "recruit", "onboarding", "resume",
                  "cv"),
    ),
    Category(
        "engineering", "Engineering",
        strong=("pull request", "unit test", "stack trace", "api endpoint",
                "database schema", "deployment pipeline", "root cause"),
        terms=("server", "client", "api", "database", "query", "latency",
               "throughput", "deploy", "release", "commit", "branch",
               "container", "kubernetes", "docker", "repository", "refactor",
               "architecture", "endpoint", "schema", "cache"),
        filename=("eng", "dev", "build", "deploy", "api", "src", "code",
                  "architecture"),
    ),
    Category(
        "marketing", "Marketing",
        strong=("brand guidelines", "target audience", "conversion rate",
                "go to market", "customer journey", "campaign performance"),
        terms=("campaign", "brand", "audience", "impressions", "engagement",
               "ctr", "seo", "newsletter", "creative", "messaging",
               "positioning", "funnel", "awareness"),
        filename=("marketing", "campaign", "brand", "social", "content"),
    ),
    Category(
        "sales", "Sales",
        strong=("pipeline review", "closed won", "closed lost", "renewal date",
                "deal desk"),
        terms=("prospect", "opportunity", "pipeline", "quota", "deal",
               "discount", "renewal", "churn", "upsell", "crm"),
        filename=("sales", "pipeline", "deals", "crm"),
    ),
    Category(
        "research", "Research",
        strong=("literature review", "we hypothesise", "we hypothesize",
                "statistically significant", "control group", "peer review"),
        terms=("study", "experiment", "hypothesis", "sample", "dataset",
               "correlation", "variable", "methodology", "survey", "findings",
               "citation", "journal", "abstract"),
        filename=("research", "study", "paper", "thesis", "experiment"),
    ),
    Category(
        "medical", "Medical",
        strong=("patient name", "medical history", "treatment plan",
                "diagnosis", "prescribed", "icd 10"),
        terms=("patient", "clinic", "hospital", "symptoms", "dosage",
               "prescription", "referral", "consultant", "vaccination",
               "allergy"),
        filename=("medical", "health", "patient", "clinic", "prescription"),
    ),
    Category(
        "education", "Education",
        strong=("learning outcomes", "course syllabus", "assignment brief",
                "marking criteria"),
        terms=("course", "lecture", "student", "assignment", "exam", "grade",
               "module", "syllabus", "curriculum", "homework", "tutor",
               "university", "coursework"),
        filename=("course", "lecture", "class", "school", "university",
                  "assignment", "exam"),
    ),
    Category(
        "operations", "Operations",
        strong=("standard operating procedure", "service level agreement",
                "incident report", "supply chain", "inventory count"),
        terms=("workflow", "logistics", "inventory", "supplier", "vendor",
               "shipment", "warehouse", "capacity", "maintenance", "sop",
               "sla", "downtime"),
        filename=("ops", "operations", "logistics", "inventory", "vendor",
                  "supplier"),
    ),
    Category(
        "security", "Security",
        strong=("access control", "threat model", "penetration test",
                "security incident", "multi factor", "least privilege"),
        terms=("password", "credential", "token", "encryption", "vulnerability",
               "exploit", "firewall", "breach", "phishing", "malware",
               "permission", "mfa", "cve"),
        filename=("security", "secrets", "keys", "credentials", "vault"),
    ),
    Category(
        "personal", "Personal",
        strong=("happy birthday", "see you soon", "family photo"),
        terms=("family", "birthday", "wedding", "friends", "recipe", "hobby",
               "shopping", "diary", "journal"),
        filename=("personal", "family", "diary", "birthday", "wedding"),
    ),
    Category(
        "travel", "Travel",
        strong=("boarding pass", "flight number", "check in time",
                "booking reference", "departure gate", "itinerary"),
        terms=("flight", "hotel", "booking", "reservation", "passport", "visa",
               "airport", "departure", "arrival", "baggage", "destination"),
        filename=("travel", "trip", "flight", "hotel", "booking", "itinerary",
                  "holiday", "vacation"),
    ),
    Category(
        "design", "Design",
        strong=("design system", "style guide", "wireframe", "user flow",
                "colour palette", "color palette"),
        terms=("mockup", "prototype", "layout", "typography", "palette", "icon",
               "spacing", "component", "accessibility"),
        filename=("design", "mockup", "wireframe", "figma", "assets"),
    ),
)


DOCTYPE_BY_NAME = {c.name: c for c in DOCTYPES}
TOPIC_BY_NAME = {c.name: c for c in TOPICS}

#: Labels a model is likely to return that mean one of ours. Applied before
#: the vocabulary match, which is what stops "financial" and "finances"
#: becoming two more buckets nobody filters by.
SYNONYMS: dict[str, str] = {
    "financial": "finance", "finances": "finance", "accounting": "finance",
    "accounts": "finance", "budgeting": "finance", "billing": "finance",
    "invoicing": "finance",
    "law": "legal", "contractual": "legal", "compliance": "legal",
    "regulatory": "legal",
    "human resources": "hr", "people": "hr", "recruitment": "hr",
    "recruiting": "hr", "hiring": "hr", "personnel": "hr", "payroll": "hr",
    "software": "engineering", "development": "engineering",
    "devops": "engineering", "technical": "engineering",
    "technology": "engineering", "it": "engineering",
    "infrastructure": "engineering", "programming": "engineering",
    "advertising": "marketing", "promotion": "marketing",
    "branding": "marketing", "growth": "marketing",
    "communications": "marketing",
    "selling": "sales", "business development": "sales",
    "science": "research", "scientific": "research", "academic": "research",
    "analytics": "research", "statistics": "research",
    "health": "medical", "healthcare": "medical", "clinical": "medical",
    "teaching": "education", "learning": "education", "training": "education",
    "academia": "education", "school": "education",
    "supply chain": "operations", "manufacturing": "operations",
    "procurement": "operations",
    "infosec": "security", "cybersecurity": "security", "privacy": "security",
    "leisure": "personal", "home": "personal",
    "vacation": "travel", "tourism": "travel", "holiday": "travel",
    "graphic design": "design", "ux": "design", "ui": "design",
    "creative": "design",
    # doctype synonyms
    "slide deck": "presentation", "slides": "presentation",
    "deck": "presentation", "powerpoint": "presentation",
    "pitch deck": "presentation",
    "bill": "invoice", "invoices": "invoice",
    "cv": "resume", "curriculum vitae": "resume",
    "logs": "log", "logfile": "log", "log file": "log",
    "code": "source-code", "script": "source-code", "program": "source-code",
    "nda": "contract", "terms of service": "contract",
    "minutes": "meeting-notes", "notes": "meeting-notes",
    "meeting": "meeting-notes",
    "email": "letter", "memo": "letter", "correspondence": "letter",
    "article": "paper", "publication": "paper", "thesis": "paper",
    "documentation": "manual", "readme": "manual", "guide": "manual",
    "handbook": "policy", "sop": "policy",
    "quote": "proposal", "quotation": "proposal", "estimate": "proposal",
    "bank statement": "statement", "account statement": "statement",
    "excel": "spreadsheet", "csv": "spreadsheet",
}


def match(label: str, *, axis: str) -> str | None:
    """Resolve a free-form label onto the closed vocabulary, or drop it.

    Called on everything a language model returns. Dropping a label is the
    right outcome far more often than inventing a bucket for it: an axis with
    forty one-file values is an axis nobody can filter by.
    """
    table = DOCTYPE_BY_NAME if axis == "doctype" else TOPIC_BY_NAME
    key = " ".join(label.strip().lower().replace("_", " ").replace("/", " ").split())
    if not key:
        return None
    if key in table:
        return key
    hyphen = key.replace(" ", "-")
    if hyphen in table:
        return hyphen
    mapped = SYNONYMS.get(key)
    if mapped and mapped in table:
        return mapped
    # Last resort: a label that is a prefix of exactly one entry
    # ("presentat" -> "presentation"). Ambiguous prefixes are dropped.
    if len(key) >= 5:
        hits = [n for n in table if n.startswith(key[:5])]
        if len(hits) == 1:
            return hits[0]
    return None


def display_of(name: str, axis: str) -> str:
    table = DOCTYPE_BY_NAME if axis == "doctype" else TOPIC_BY_NAME
    cat = table.get(name)
    return cat.display if cat else name.replace("-", " ").title()


def rank(text: str, name: str, ext: str, axis: str) -> list[tuple[str, float]]:
    """Score every category on one axis, best first, zeroes dropped."""
    cats = DOCTYPES if axis == "doctype" else TOPICS
    scored = [(c.name, c.score(text, name, ext)) for c in cats]
    return sorted(
        [(n, s) for n, s in scored if s > 0], key=lambda kv: -kv[1]
    )
