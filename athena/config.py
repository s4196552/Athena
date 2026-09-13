"""Where Athena is allowed to write.

Exactly three locations, all outside every indexed root, all safe to delete:

* the catalogue (SQLite + WAL) -- rebuildable by re-scanning;
* the thumbnail cache -- rebuildable from the catalogue;
* models and logs.

Keeping this in one module makes the promise auditable: if a path is not
derived from `AppPaths`, nothing should be writing to it. A sidecar file next
to the user's photo would be far more convenient for several features -- and is
precisely what this product exists not to do.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

APP_NAME = "Athena"


def _base_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")


@dataclass(frozen=True, slots=True)
class AppPaths:
    root: Path

    @classmethod
    def default(cls) -> "AppPaths":
        override = os.environ.get("ATHENA_HOME")
        return cls(Path(override) if override else _base_dir() / APP_NAME)

    @property
    def db(self) -> Path:
        return self.root / "catalogue.sqlite3"

    @property
    def thumbs(self) -> Path:
        return self.root / "thumbnails"

    @property
    def models(self) -> Path:
        return self.root / "models"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    def ensure(self) -> "AppPaths":
        for directory in (self.root, self.thumbs, self.models, self.logs):
            directory.mkdir(parents=True, exist_ok=True)
        return self

    def contains(self, path: str | os.PathLike[str]) -> bool:
        """True if `path` lies inside Athena's own storage.

        Used to refuse adding the app's own data directory as a library root,
        which would otherwise have the engine indexing its own thumbnails and
        growing without bound.
        """
        try:
            Path(path).resolve().relative_to(self.root.resolve())
            return True
        except (ValueError, OSError):
            return False
