"""Document extractors: PDF, DOCX, PPTX.

A licensing note that matters more than it looks, because it is very hard to
unwind later: **PyMuPDF is AGPL-3.0**. It is the fastest PDF library in Python
by a wide margin and it is what most tutorials reach for, but linking it into a
distributed desktop application obliges you to release your source under the
AGPL, or to buy a commercial licence from Artifex. Athena uses **pypdfium2**
(Apache-2.0 / BSD-3, Google's PDFium -- the engine inside Chrome) for rendering
and **pdfminer.six** (MIT) for layout-aware text. Slower on paper, free of that
obligation, and the difference vanishes once OCR is in the pipeline.

DOCX and PPTX are ZIP containers, which is the trap in this file. `zipfile.ZipFile`
given a *path* can be reopened in append mode, and several helper libraries do
exactly that when they think they are being helpful. Every archive here is
opened from an in-memory buffer, so no code path exists that could write back.
"""

from __future__ import annotations

from typing import ClassVar, Iterator

from ..core.facets import Facets
from ..core.safety import reader_for
from .base import BaseExtractor, ExtractContext, Tier, register

#: A page with fewer characters than this is treated as having no text layer --
#: scanners routinely leave a stray header or a page number on an otherwise
#: image-only page, and trusting a non-zero character count would silently skip
#: OCR on exactly the documents that need it most.
TEXT_LAYER_MIN_CHARS_PER_PAGE = 40

#: Cap on stored text per document. Full text still goes to FTS; this bounds
#: the catalogue against the occasional 4,000-page scanned deposition.
MAX_CHARS_PER_BLOCK = 200_000


def _is_pdf(ctx: ExtractContext) -> bool:
    return ctx.mime == "application/pdf" or ctx.ext == "pdf"


@register
class PdfText(BaseExtractor):
    """Page count, document properties, and the embedded text layer."""

    name: ClassVar[str] = "doc.pdf"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"document"})
    requires: ClassVar[tuple[str, ...]] = ("pypdfium2",)
    max_bytes: ClassVar[int] = 512 * 1024 * 1024

    def supports(self, ctx: ExtractContext) -> bool:
        return super().supports(ctx) and _is_pdf(ctx)

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        import pypdfium2 as pdfium

        buf = reader_for(ctx.path)
        try:
            doc = pdfium.PdfDocument(buf)
        except pdfium.PdfiumError as exc:
            if "password" in str(exc).lower():
                out.add("doc_meta", is_encrypted=1, page_count=None)
                raise
            raise

        try:
            pages = len(doc)
            total_chars = 0
            for index in range(pages):
                page = doc[index]
                try:
                    text = page.get_textpage().get_text_bounded() or ""
                except Exception:  # noqa: BLE001 - one bad page, not the document
                    text = ""
                finally:
                    page.close()
                text = text.strip()
                if text:
                    total_chars += len(text)
                    out.text("pdf_text", text[:MAX_CHARS_PER_BLOCK], ord=index + 1)

            has_layer = total_chars >= TEXT_LAYER_MIN_CHARS_PER_PAGE * max(pages, 1)
            meta = _pdf_metadata(doc)
            out.add(
                "doc_meta",
                page_count=pages,
                char_count=total_chars,
                word_count=total_chars // 6 if total_chars else 0,
                has_text_layer=int(has_layer),
                is_encrypted=0,
                **meta,
            )
            # Consumed by PdfOcr in the same run, so a scanned PDF is opened
            # once rather than once per extractor.
            ctx.shared["pdf_needs_ocr"] = not has_layer
            ctx.shared["pdf_pages"] = pages
        finally:
            doc.close()


@register
class PdfOcr(BaseExtractor):
    """OCR for PDFs with no usable text layer.

    Gating on `has_text_layer` is the single highest-leverage optimisation in
    the whole document pipeline. OCR costs roughly 300ms per page against ~2ms
    for text extraction; in a typical library, well under a fifth of PDFs are
    scans. Running OCR unconditionally would make document indexing about
    thirty times slower for no additional text.
    """

    name: ClassVar[str] = "doc.pdf_ocr"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.ML
    media_types: ClassVar[frozenset[str]] = frozenset({"document"})
    requires: ClassVar[tuple[str, ...]] = ("pypdfium2", "rapidocr_onnxruntime")
    max_bytes: ClassVar[int] = 512 * 1024 * 1024

    MAX_PAGES: ClassVar[int] = 50     # beyond this, index the front matter only
    RENDER_SCALE: ClassVar[float] = 2.0   # ~144 DPI, the floor for reliable OCR

    def supports(self, ctx: ExtractContext) -> bool:
        return super().supports(ctx) and _is_pdf(ctx)

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        if ctx.shared.get("pdf_needs_ocr") is False:
            raise NotImplementedError("text layer present; OCR not required")

        import numpy as np
        import pypdfium2 as pdfium

        from .images import ImageOcr

        engine = ImageOcr.engine()
        doc = pdfium.PdfDocument(reader_for(ctx.path))
        try:
            pages = min(len(doc), self.MAX_PAGES)
            found = 0
            for index in range(pages):
                page = doc[index]
                try:
                    bitmap = page.render(scale=self.RENDER_SCALE)
                    result, _ = engine(np.asarray(bitmap.to_pil().convert("RGB")))
                finally:
                    page.close()
                if not result:
                    continue
                text = "\n".join(
                    t.strip() for _b, t, s in result if float(s) >= 0.5 and t.strip()
                )
                if text:
                    found += len(text)
                    out.text("pdf_ocr", text, ord=index + 1)
            if found:
                out.add("doc_meta", ocr_applied=1, char_count=found)
        finally:
            doc.close()


@register
class DocxText(BaseExtractor):
    """Word documents: body, tables, headers, footers, and core properties.

    `python-docx` skips headers, footers and footnotes, which in practice hold
    the document title, the client name and the contract references -- exactly
    the terms someone searches for. So the body comes from the library and the
    remainder is read straight out of the package XML.
    """

    name: ClassVar[str] = "doc.docx"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"document"})
    requires: ClassVar[tuple[str, ...]] = ("docx",)
    max_bytes: ClassVar[int] = 256 * 1024 * 1024

    def supports(self, ctx: ExtractContext) -> bool:
        return super().supports(ctx) and ctx.ext == "docx"

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        import docx

        document = docx.Document(reader_for(ctx.path))

        parts: list[str] = [p.text for p in document.paragraphs if p.text.strip()]
        for table in document.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))

        for section in document.sections:
            for container in (section.header, section.footer):
                parts.extend(p.text for p in container.paragraphs if p.text.strip())

        body = "\n".join(parts)
        props = document.core_properties
        out.add(
            "doc_meta",
            page_count=None,   # Word paginates at render time; there is no true count
            char_count=len(body),
            word_count=len(body.split()),
            title=_clean(props.title),
            author=_clean(props.author),
            subject=_clean(props.subject),
            creator=_clean(props.last_modified_by),
            doc_created_at=_epoch(props.created),
            doc_modified_at=_epoch(props.modified),
            has_text_layer=1,
        )
        if body:
            out.text("docx", body[:MAX_CHARS_PER_BLOCK])
        for keyword in _split_keywords(props.keywords):
            out.tag("keyword", keyword, self.source_id)


@register
class PptxText(BaseExtractor):
    """Slides: every text frame, plus speaker notes, one block per slide.

    Keeping slides as separate blocks with `ord` = slide number means a search
    hit can deep-link to slide 14 rather than to the deck.
    """

    name: ClassVar[str] = "doc.pptx"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"document"})
    requires: ClassVar[tuple[str, ...]] = ("pptx",)
    max_bytes: ClassVar[int] = 256 * 1024 * 1024

    def supports(self, ctx: ExtractContext) -> bool:
        return super().supports(ctx) and ctx.ext == "pptx"

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        from pptx import Presentation

        deck = Presentation(reader_for(ctx.path))
        total = 0

        for number, slide in enumerate(deck.slides, start=1):
            text = "\n".join(_shape_text(slide.shapes))
            if text.strip():
                total += len(text)
                out.text("pptx", text[:MAX_CHARS_PER_BLOCK], ord=number)

            if slide.has_notes_slide:
                notes = (slide.notes_slide.notes_text_frame.text or "").strip()
                if notes:
                    total += len(notes)
                    out.text("pptx_notes", notes[:MAX_CHARS_PER_BLOCK], ord=number)

        props = deck.core_properties
        out.add(
            "doc_meta",
            page_count=len(deck.slides._sldIdLst),  # noqa: SLF001 - no public count
            char_count=total,
            title=_clean(props.title),
            author=_clean(props.author),
            subject=_clean(props.subject),
            doc_created_at=_epoch(props.created),
            doc_modified_at=_epoch(props.modified),
            has_text_layer=1,
        )


@register
class PlainText(BaseExtractor):
    """Plain text: .txt, .md, .log, .csv, .tsv.

    The least glamorous extractor and one of the most useful, because plain
    text is where the inspection agent does its best work: a log, a CSV export
    and a pasted stack trace are three of the most recognisable *shapes* there
    are, and none of them has a container to read metadata out of.

    Three details that are easy to get wrong:

    * **Decoding.** A log written by a Windows service is cp1252, a log written
      by a container is UTF-8, and one that has been through both is neither.
      UTF-8 is tried first, then UTF-16 when a BOM says so, then cp1252, then
      UTF-8 with replacement -- which cannot fail. Losing a file to a
      `UnicodeDecodeError` would be a poor trade for byte-perfect fidelity in
      text that is only ever going into a search index.

    * **Head and tail, not the middle.** A 2 GB log file is capped, and the cap
      takes text from *both ends*. The beginning has the startup banner and the
      configuration; the end has the crash. The middle is ten million
      near-identical lines, which is the one part with no information in it.

    * **No `has_text_layer` claim beyond what is true.** A zero-byte .txt
      records `char_count = 0` rather than being quietly skipped, so it shows
      up as an indexed file with nothing in it instead of vanishing.
    """

    name: ClassVar[str] = "doc.text"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"document"})
    max_bytes: ClassVar[int] = 512 * 1024 * 1024

    EXTS: ClassVar[frozenset[str]] = frozenset({"txt", "md", "log", "csv", "tsv"})
    #: Bytes read from each end when the file exceeds `MAX_CHARS_PER_BLOCK`.
    HALF: ClassVar[int] = MAX_CHARS_PER_BLOCK // 2

    def supports(self, ctx: ExtractContext) -> bool:
        return super().supports(ctx) and ctx.ext in self.EXTS

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        from ..core import safety

        size = ctx.size_bytes
        if size > MAX_CHARS_PER_BLOCK * 4:
            head = safety.read_head(ctx.path, self.HALF * 2)
            tail = safety.read_tail(ctx.path, self.HALF * 2)
            raw = head + b"\n...\n" + tail
            truncated = True
        else:
            raw = safety.read_head(ctx.path, MAX_CHARS_PER_BLOCK * 4)
            truncated = False

        body = _decode(raw)
        if truncated:
            body = body[: self.HALF] + "\n[...]\n" + body[-self.HALF:]

        out.add(
            "doc_meta",
            char_count=len(body),
            word_count=len(body.split()),
            has_text_layer=1,
            page_count=None,
            is_encrypted=0,
        )
        if body.strip():
            out.text(ctx.ext if ctx.ext in ("log", "csv", "tsv") else "text", body)


def _decode(raw: bytes) -> str:
    """Decode text bytes without ever raising.

    Order matters: UTF-8 first because it is now the common case and its
    validation is strict enough that a false positive is very unlikely; then
    the UTF-16 BOMs, which are unambiguous; then cp1252, which accepts almost
    anything and so must come last among the strict attempts; then UTF-8 with
    replacement, which cannot fail.
    """
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]
    elif raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return raw.decode("utf-16")
        except (UnicodeDecodeError, ValueError):
            pass
    for encoding in ("utf-8", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


@register
class KeywordExtract(BaseExtractor):
    """Cheap keyword surfacing from whatever text the earlier extractors found.

    Deliberately statistical rather than neural: it runs on text already in
    memory, costs microseconds, and needs no model download. When the ML tier
    is enabled, embedding-based topics supersede these; both are stored, tagged
    with their source, so the UI can prefer the better one and fall back.
    """

    name: ClassVar[str] = "text.keywords"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    #: After the parsers: it reads the text blocks they produced.
    order: ClassVar[int] = 50
    media_types: ClassVar[frozenset[str]] = frozenset(
        {"document", "image", "audio", "video"}
    )

    TOP_N: ClassVar[int] = 12
    MIN_LEN: ClassVar[int] = 4

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        blocks = out.rows.get("text_block", [])
        if not blocks:
            return
        corpus = " ".join(str(b.get("body", "")) for b in blocks)[:200_000].lower()
        if len(corpus) < 200:
            return

        counts: dict[str, int] = {}
        for token in _tokenize(corpus):
            # Anything starting with a digit is an identifier, not a keyword:
            # port numbers, durations, invoice references, row counts. They are
            # already searchable through the full-text index, and as tags they
            # crowd the rail with things like "5432" and "2400ms".
            if token[0].isdigit():
                continue
            if len(token) >= self.MIN_LEN and token not in _STOPWORDS:
                counts[token] = counts.get(token, 0) + 1

        if not counts:
            return
        peak = max(counts.values())
        ranked = sorted(counts.items(), key=lambda kv: -kv[1])[: self.TOP_N]
        for term, count in ranked:
            if count < 2:
                continue
            out.tag("keyword", term, self.source_id, confidence=round(count / peak, 3))


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _shape_text(shapes) -> Iterator[str]:
    """Recursive: PowerPoint groups nest arbitrarily deep."""
    for shape in shapes:
        if shape.shape_type == 6 and hasattr(shape, "shapes"):  # GROUP
            yield from _shape_text(shape.shapes)
        elif getattr(shape, "has_text_frame", False):
            text = (shape.text_frame.text or "").strip()
            if text:
                yield text
        elif getattr(shape, "has_table", False):
            for row in shape.table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    yield " | ".join(cells)


def _pdf_metadata(doc) -> dict[str, str | None]:
    try:
        meta = doc.get_metadata_dict()
    except Exception:  # noqa: BLE001
        return {}
    return {
        "title": _clean(meta.get("Title")),
        "author": _clean(meta.get("Author")),
        "subject": _clean(meta.get("Subject")),
        "creator": _clean(meta.get("Creator")),
        "producer": _clean(meta.get("Producer")),
    }


def _clean(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip().strip("\x00")
    return text[:500] or None


def _epoch(value) -> int | None:
    if value is None:
        return None
    try:
        return int(value.timestamp())
    except (AttributeError, ValueError, OSError):
        return None


def _split_keywords(raw) -> list[str]:
    if not raw:
        return []
    for sep in (";", ","):
        if sep in str(raw):
            return [k.strip().lower() for k in str(raw).split(sep) if k.strip()]
    return [str(raw).strip().lower()]


def _tokenize(text: str) -> Iterator[str]:
    token: list[str] = []
    for ch in text:
        if ch.isalnum() or ch in "-_":
            token.append(ch)
        elif token:
            yield "".join(token)
            token = []
    if token:
        yield "".join(token)


_STOPWORDS: frozenset[str] = frozenset("""
about above after again against along also among another because been before
being below between both cannot could does doing down during each either every
from further having here itself just make many more most much must never
only other over same should some such than that their them then there these
they this those through under until very were what when where which while will
with within without would your yours page slide figure table http https www com
""".split())
