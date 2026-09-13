"""Content identity: hashing and type sniffing.

Two rules here, both learned the hard way by every file indexer ever written:

**Hash the content, not the path.** Paths are the user's business and they
change constantly -- renames, reorganisations, a folder dragged to a new drive.
Content hashes do not. Keying every piece of extracted metadata to the hash is
what lets a user reorganise their entire library between sessions and lose
nothing, which is precisely the guarantee a tool that refuses to move their
files needs to make.

**Sniff the type, do not trust the extension.** `.jpg` files that are really
PNGs, `.mp4` files that are really MKVs, and `.docx` files that are really ZIPs
of something else are all routine in real libraries. Handing a mislabelled file
to the wrong parser is the single largest source of spurious `Error` states.
The extension is used only as a cheap prefilter during the walk; the real
decision is made from the first few hundred bytes.
"""

from __future__ import annotations

import os
import struct
from typing import Final

from .safety import CHUNK, open_ro, read_tail

try:
    from blake3 import blake3 as _blake3

    HASH_NAME: Final[str] = "blake3"
except ImportError:  # pragma: no cover - fallback path
    _blake3 = None
    import hashlib

    HASH_NAME = "blake2b"


#: Extensions worth opening at all. Checked during the walk, before any I/O, so
#: a folder of 400k source files costs nothing to skip. Deliberately a
#: superset of the shipping parsers: a file we recognise but cannot yet parse
#: should surface as a known asset, not vanish from the library.
IMAGE_EXTS: Final[frozenset[str]] = frozenset(
    "jpg jpeg png webp gif bmp tif tiff heic heif avif jxl".split()
)
VIDEO_EXTS: Final[frozenset[str]] = frozenset(
    "mp4 mkv webm mov avi m4v wmv flv mpg mpeg".split()
)
AUDIO_EXTS: Final[frozenset[str]] = frozenset(
    "mp3 wav flac m4a aac ogg opus wma aiff".split()
)
DOC_EXTS: Final[frozenset[str]] = frozenset(
    # `log`, `csv` and `tsv` are here because the inspection agent classifies
    # by shape: a timestamped log and a delimited export are two of the most
    # recognisable shapes there are, and excluding them would leave the `log`
    # and `spreadsheet` doctypes permanently dead.
    #
    # Source-code extensions are deliberately still absent. One `node_modules`
    # is 400,000 files, and a file manager that indexes it by default is a file
    # manager nobody runs twice. The `source-code` doctype still fires on code
    # pasted into a .txt or .md, which is where it is actually useful.
    "pdf docx pptx xlsx doc ppt xls odt odp ods rtf txt md log csv tsv epub".split()
)

INDEXABLE_EXTS: Final[frozenset[str]] = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS | DOC_EXTS

_EXT_MEDIA: Final[dict[str, str]] = {
    **{e: "image" for e in IMAGE_EXTS},
    **{e: "video" for e in VIDEO_EXTS},
    **{e: "audio" for e in AUDIO_EXTS},
    **{e: "document" for e in DOC_EXTS},
}

#: (offset, signature, mime, media_type). Ordered most-specific first.
_SIGNATURES: Final[tuple[tuple[int, bytes, str, str], ...]] = (
    (0, b"\xff\xd8\xff", "image/jpeg", "image"),
    (0, b"\x89PNG\r\n\x1a\n", "image/png", "image"),
    (0, b"GIF87a", "image/gif", "image"),
    (0, b"GIF89a", "image/gif", "image"),
    (0, b"BM", "image/bmp", "image"),
    (0, b"II*\x00", "image/tiff", "image"),
    (0, b"MM\x00*", "image/tiff", "image"),
    (0, b"%PDF-", "application/pdf", "document"),
    (0, b"\x1a\x45\xdf\xa3", "video/x-matroska", "video"),   # EBML: mkv or webm
    (0, b"OggS", "audio/ogg", "audio"),
    (0, b"fLaC", "audio/flac", "audio"),
    (0, b"ID3", "audio/mpeg", "audio"),
    (0, b"\xff\xfb", "audio/mpeg", "audio"),
    (0, b"\xff\xf3", "audio/mpeg", "audio"),
    (0, b"\xff\xf2", "audio/mpeg", "audio"),
    (0, b"{\\rtf", "application/rtf", "document"),
    (0, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "application/x-ole-storage", "document"),
)

_OOXML_MARKERS: Final[tuple[tuple[bytes, str, str], ...]] = (
    (b"word/", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    (b"ppt/", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
    (b"xl/", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
)


def content_hash(path: str | os.PathLike[str], *, size_hint: int = 0) -> str:
    """Streaming hash of the whole file.

    BLAKE3's Rust extension releases the GIL and runs at multiple GB/s, which
    is why stage 1 uses a *thread* pool: the work is I/O bound and the hashing
    itself does not contend for the interpreter. Falls back to BLAKE2b, which
    is slower but present in the stdlib, so the engine still runs on a machine
    where the wheel would not build.
    """
    if _blake3 is not None:
        hasher = _blake3(max_threads=1)
    else:  # pragma: no cover
        hasher = hashlib.blake2b(digest_size=32)

    with open_ro(path) as fh:
        while True:
            block = fh.read(CHUNK)
            if not block:
                break
            hasher.update(block)
    return hasher.hexdigest()


#: End-of-file markers, and how far back from EOF to look for them. Formats
#: append trailing padding of varying tidiness, so each gets its own window.
_TERMINATORS: Final[dict[str, tuple[bytes, int]]] = {
    "image/png": (b"IEND", 16),
    "image/jpeg": (b"\xff\xd9", 32),
    "image/gif": (b"\x3b", 4),
    "application/pdf": (b"%%EOF", 2048),
}


def is_truncated(path: str | os.PathLike[str], mime: str | None) -> bool:
    """True when a file's end-of-stream marker is missing.

    Worth the extra 64-byte read, because the alternative is silent garbage.
    Pillow with `LOAD_TRUNCATED_IMAGES` enabled will happily decode a 200-byte
    fragment of a PNG into a full-size mostly-black image: the file indexes
    "successfully", and the catalogue gains a black thumbnail, a bogus
    resolution and a "black" colour tag that pollutes every colour filter. A
    half-downloaded photo is genuinely corrupt, and saying so is far more
    useful to the user than inventing metadata for it.
    """
    marker_window = _TERMINATORS.get(mime or "")
    if marker_window is None:
        return False
    marker, window = marker_window
    try:
        return marker not in read_tail(path, window)
    except OSError:
        return False


def sniff(path: str | os.PathLike[str], head: bytes | None = None) -> tuple[str | None, str]:
    """Return `(mime, media_type)` decided from the bytes, not the name."""
    if head is None:
        with open_ro(path) as fh:
            head = fh.read(4096)

    for offset, sig, mime, media in _SIGNATURES:
        if head[offset : offset + len(sig)] == sig:
            if mime == "video/x-matroska":
                return _refine_ebml(path, head), "video"
            return mime, media

    # ISO base media (mp4/mov/m4a/heic) -- the brand lives at offset 8.
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return _refine_ftyp(head[8:12])

    if head[:4] == b"RIFF" and len(head) >= 12:
        fmt = head[8:12]
        if fmt == b"WEBP":
            return "image/webp", "image"
        if fmt == b"WAVE":
            return "audio/x-wav", "audio"
        if fmt == b"AVI ":
            return "video/x-msvideo", "video"

    if head[:2] == b"PK":
        return _refine_zip(path)

    # Optional but much broader coverage when installed.
    try:
        import puremagic

        guesses = puremagic.magic_string(head)
        if guesses:
            mime = guesses[0].mime_type or None
            return mime, _media_from_mime(mime)
    except Exception:  # noqa: BLE001 - sniffing is best-effort by nature
        pass

    ext = extension(path)
    return None, _EXT_MEDIA.get(ext, "other")


def _refine_ftyp(brand: bytes) -> tuple[str, str]:
    b = brand.decode("ascii", "replace").strip()
    if b in ("heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"):
        return "image/heic", "image"
    if b in ("avif", "avis"):
        return "image/avif", "image"
    if b in ("M4A ", "M4A", "M4B "):
        return "audio/mp4", "audio"
    if b in ("qt  ", "qt"):
        return "video/quicktime", "video"
    return "video/mp4", "video"


def _refine_ebml(path: str | os.PathLike[str], head: bytes) -> str:
    """MKV and WebM share a container; the DocType string separates them."""
    if b"webm" in head[:64]:
        return "video/webm"
    return "video/x-matroska"


def _refine_zip(path: str | os.PathLike[str]) -> tuple[str | None, str]:
    """OOXML files are ZIPs; the first entry name gives the flavour away.

    Read through an in-memory buffer rather than handing `zipfile` the path --
    `zipfile` opened on a path can be coaxed into write mode, and the whole
    point of this module is that nothing ever gets that chance.
    """
    try:
        from .safety import reader_for

        buf = reader_for(path, max_bytes=8192)
        chunk = buf.getvalue()
        for marker, mime, _kind in _OOXML_MARKERS:
            if marker in chunk:
                return mime, "document"
        if b"mimetypeapplication/epub" in chunk:
            return "application/epub+zip", "document"
        if b"mimetypeapplication/vnd.oasis" in chunk:
            return "application/vnd.oasis.opendocument.text", "document"
    except Exception:  # noqa: BLE001
        pass
    return "application/zip", "other"


def _media_from_mime(mime: str | None) -> str:
    if not mime:
        return "other"
    top = mime.split("/", 1)[0]
    if top in ("image", "video", "audio"):
        return top
    if mime in (
        "application/pdf",
        "application/rtf",
        "text/plain",
        "text/markdown",
    ) or "officedocument" in mime or "opendocument" in mime:
        return "document"
    return "other"


def extension(path: str | os.PathLike[str]) -> str:
    ext = os.path.splitext(os.fspath(path))[1]
    return ext[1:].lower() if ext else ""


def is_indexable(name: str) -> bool:
    ext = os.path.splitext(name)[1]
    return bool(ext) and ext[1:].lower() in INDEXABLE_EXTS


def media_type_for_ext(ext: str) -> str:
    return _EXT_MEDIA.get(ext.lower(), "other")


def pack_vector(values: "list[float]") -> bytes:
    """float32 list -> float16 blob. Halves the DB at no measurable recall cost."""
    try:
        import numpy as np

        arr = np.asarray(values, dtype=np.float32)
        norm = float(np.linalg.norm(arr)) or 1.0
        return (arr / norm).astype(np.float16).tobytes()
    except ImportError:  # pragma: no cover
        total = sum(v * v for v in values) ** 0.5 or 1.0
        return struct.pack(f"<{len(values)}e", *[v / total for v in values])
