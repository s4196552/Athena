"""Extractor package.

`load_all()` imports every extractor module so their `@register` decorators
run. Called explicitly rather than at import time because worker processes use
the `spawn` start method: each child re-imports the package from scratch, and
making that import cheap and explicit keeps worker startup predictable.
"""

from __future__ import annotations

import importlib
import logging

log = logging.getLogger("athena.extractors")

_MODULES = ("images", "documents", "av", "agent", "ai")
_loaded = False


def load_all() -> None:
    global _loaded
    if _loaded:
        return
    for name in _MODULES:
        try:
            importlib.import_module(f"{__name__}.{name}")
        except Exception:  # noqa: BLE001
            # A module whose optional dependency is missing at *import* time
            # must not take the engine down -- the remaining extractors still
            # produce a useful library.
            log.warning("extractor module %r failed to import", name, exc_info=True)
    _loaded = True


__all__ = ["load_all"]
