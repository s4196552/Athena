"""One OCR engine, two package names, one result shape.

RapidOCR was renamed. `rapidocr-onnxruntime` stopped publishing wheels after
1.2.3 and never gained a Python 3.13/3.14 one; the project continues as
`rapidocr`, which is the same PaddleOCR-derived models behind a different
import and a different return type:

    rapidocr_onnxruntime   engine(array) -> (list[(box, text, score)], elapsed)
    rapidocr               engine(array) -> RapidOCROutput(.txts, .scores, .boxes)

Both are supported rather than one being chosen, because the choice is not
Athena's to make: whichever is installable depends on the interpreter someone
already has. Preferring the new name means a fresh install on a current Python
works, and keeping the old one means an existing environment is not broken by
this file.

Everything above here sees `read(array) -> list[(text, score)]` and does not
know which package answered.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

log = logging.getLogger("athena.extractors.ocr")

#: Package names in preference order, with the module attribute to construct.
_CANDIDATES = ("rapidocr", "rapidocr_onnxruntime")

_engine: Any = None
_flavour: str = ""
_lock = threading.Lock()


def available() -> str | None:
    """None if OCR can run, otherwise the reason it cannot."""
    for name in _CANDIDATES:
        try:
            __import__(name)
            return None
        except ImportError:
            continue
    return (
        "no OCR engine installed (pip install rapidocr, or "
        "rapidocr-onnxruntime on Python 3.12 and below)"
    )


def engine() -> Any:
    """Process-global. Loading the models costs ~1.5s and several hundred MB,
    which is why the scheduler gives the ML tier its own small pool."""
    global _engine, _flavour
    with _lock:
        if _engine is not None:
            return _engine
        for name in _CANDIDATES:
            try:
                module = __import__(name, fromlist=["RapidOCR"])
            except ImportError:
                continue
            # RapidOCR logs three INFO lines per model at construction. Across a
            # library that is noise in the middle of a progress bar, and the
            # information -- which ONNX file it picked -- is not actionable.
            logging.getLogger("RapidOCR").setLevel(logging.WARNING)
            _engine, _flavour = module.RapidOCR(), name
            log.debug("OCR engine: %s", name)
            return _engine
        raise ImportError(available() or "no OCR engine")


def read(array: Any, min_confidence: float = 0.5) -> list[tuple[str, float]]:
    """Recognised lines above `min_confidence`, newest API or oldest.

    Returns [] rather than raising for an image with no text in it, which is
    the common case and not an error -- most photographs have no text, and an
    extractor that treated that as a failure would fill the run ledger with
    red rows for files that are perfectly fine.
    """
    result = engine()(array)
    if result is None:
        return []

    # New API: an object carrying parallel tuples.
    txts = getattr(result, "txts", None)
    if txts is not None:
        scores = getattr(result, "scores", None) or ()
        pairs = zip(txts, list(scores) + [1.0] * (len(txts) - len(scores)))
        return [
            (text.strip(), float(score))
            for text, score in pairs
            if text and text.strip() and float(score) >= min_confidence
        ]

    # Old API: (rows, elapsed), each row (box, text, score).
    rows = result[0] if isinstance(result, tuple) else result
    if not rows:
        return []
    out: list[tuple[str, float]] = []
    for row in rows:
        try:
            _box, text, score = row
        except (TypeError, ValueError):
            continue
        if text and text.strip() and float(score) >= min_confidence:
            out.append((text.strip(), float(score)))
    return out
