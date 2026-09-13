"""Local web UI for Athena.

A single-process HTTP server bound to loopback, serving one HTML page and a
small JSON API over the catalogue. Standard library only -- no FastAPI, no
uvicorn, no build step. Edit the HTML, hit refresh.

The architecture note that makes this work: the browser is sandboxed, but this
server is not. Anything the page cannot do -- open Explorer, read an arbitrary
path, start a scan -- it asks the server to do on its behalf. The page is a
renderer; the server is the application.

Two rules this file inherits and must not break:

* **Reads of user files go through `safety.open_ro`.** The `/api/raw` route
  streams original files to the browser, which makes it the one place in the UI
  that touches a library. Using a plain `open()` here would put a hole straight
  through the product's central promise -- and `tests/test_never_mutates.py`
  would notice.

* **One writer.** The server owns the single `Writer` and hands every request
  thread a read-only connection, so the UI cannot contend with the indexer.
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import mimetypes
import os
import queue
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..agent import brief as briefing
from ..config import AppPaths
from ..core import safety
from ..core.library import forget_library, list_libraries
from ..core.scanner import Scanner
from ..core.scheduler import Supervisor
from ..db.connection import connect_ro
from ..db.writer import Writer
from .queries import (
    TAG_KINDS,
    build_filter,
    brief_by_id,
    canonical_query,
    detail,
    facets,
    filter_label,
    find_brief,
    graph,
    library,
    recent_briefs,
    selection_items,
)

STATIC = Path(__file__).with_name("static")


class Service:
    """Owns the engine. One writer, one supervisor, many read connections."""

    def __init__(self, paths: AppPaths, enable_ml: bool = False) -> None:
        self.paths = paths.ensure()
        self.writer = Writer(str(paths.db)).start()
        self.supervisor = Supervisor(
            self.writer, str(paths.db), paths.thumbs, enable_ml=enable_ml
        )
        self.supervisor.start()
        # A small pool of read-only connections.
        #
        # The obvious approach -- a `threading.local()` connection -- leaks
        # badly here. ThreadingHTTPServer creates a thread per *connection*,
        # and a page loading a wall of thumbnails churns through hundreds of
        # them; each one would open a SQLite connection that is never closed,
        # until the process runs out of file handles and every route starts
        # failing at once. A bounded pool caps it: connections are reused, and
        # any surplus beyond MAX_POOL is closed on return instead of kept.
        self._pool: queue.LifoQueue[sqlite3.Connection] = queue.LifoQueue()
        self._scan_thread: threading.Thread | None = None
        self.scan_status = "idle"

    MAX_POOL = 8

    @contextlib.contextmanager
    def db(self):
        try:
            conn = self._pool.get_nowait()
        except queue.Empty:
            conn = connect_ro(self.paths.db)
        try:
            yield conn
        finally:
            if self._pool.qsize() >= self.MAX_POOL:
                conn.close()
            else:
                self._pool.put(conn)

    def close(self) -> None:
        self.supervisor.stop()
        self.writer.close()
        while not self._pool.empty():
            self._pool.get_nowait().close()

    # -- scanning ----------------------------------------------------------

    def start_scan(self, target: str) -> tuple[bool, str]:
        path = Path(target).expanduser()
        if not path.is_dir():
            return False, f"not a directory: {path}"
        if self.paths.contains(path):
            return False, "refusing to index Athena's own data directory"
        if self._scan_thread and self._scan_thread.is_alive():
            return False, "a scan is already running"

        resolved = str(path.resolve())

        def run() -> None:
            self.scan_status = "scanning"
            try:
                root_id = self.writer.call(lambda cur: _ensure_root(cur, resolved))
                Scanner(self.writer).scan_root(root_id, resolved)
                self.scan_status = "indexing"
            except Exception as exc:  # noqa: BLE001
                self.scan_status = f"failed: {exc}"

        self._scan_thread = threading.Thread(target=run, daemon=True)
        self._scan_thread.start()
        return True, f"scanning {resolved}"


def _ensure_root(cur: sqlite3.Cursor, path: str) -> int:
    cur.execute(
        "INSERT INTO root (path, label) VALUES (?, ?) ON CONFLICT(path) DO NOTHING",
        (path, Path(path).name),
    )
    return int(cur.execute("SELECT id FROM root WHERE path = ?", (path,)).fetchone()[0])


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Athena"

    def __init__(self, service: Service, *args, **kwargs) -> None:
        self.service = service
        super().__init__(*args, **kwargs)

    def log_message(self, fmt: str, *args) -> None:  # quieter console for a demo
        pass

    # -- routing -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if not self._check_origin():
            return
        url = urlparse(self.path)
        route, params = url.path, parse_qs(url.query)
        try:
            if route == "/" or route == "/index.html":
                return self._static("index.html")
            if route in ("/app.css", "/app.js"):
                return self._static(route.lstrip("/"))
            if route == "/api/library":
                with self.service.db() as db:
                    return self._json(library(db, params))
            if route == "/api/roots":
                with self.service.db() as db:
                    return self._json({
                        "libraries": [dataclasses.asdict(lib) for lib in list_libraries(db)]
                    })
            if route == "/api/facets":
                with self.service.db() as db:
                    return self._json(facets(db))
            if route.startswith("/api/detail/"):
                with self.service.db() as db:
                    item = detail(db, int(route.rsplit("/", 1)[1]))
                return self._json(item) if item else self._error(404, "not found")
            if route.startswith("/api/thumb/"):
                return self._thumb(int(route.rsplit("/", 1)[1]))
            if route.startswith("/api/raw/"):
                return self._raw(int(route.rsplit("/", 1)[1]))
            if route == "/api/graph":
                with self.service.db() as db:
                    return self._json(graph(db, params))
            if route == "/api/briefs":
                with self.service.db() as db:
                    return self._json({"briefs": recent_briefs(db)})
            if route.startswith("/api/brief/"):
                with self.service.db() as db:
                    found = brief_by_id(db, int(route.rsplit("/", 1)[1]))
                return self._json(found) if found else self._error(404, "not found")
            if route == "/api/progress":
                if params.get("once"):
                    with self.service.db() as db:
                        return self._json(self._progress_snapshot(db))
                return self._progress_stream()
            return self._error(404, "no such route")
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            self._error(500, f"{type(exc).__name__}: {exc}")

    def do_POST(self) -> None:  # noqa: N802
        if not self._check_origin():
            return
        route = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        try:
            if route == "/api/scan":
                ok, msg = self.service.start_scan(body.get("path", ""))
                return self._json({"ok": ok, "message": msg}, 200 if ok else 400)
            if route == "/api/reveal":
                return self._json(self._reveal(int(body["file_id"])))
            if route == "/api/roots/forget":
                # Named "forget", not "delete". This removes catalogue rows and
                # Athena's own thumbnails; it never unlinks anything inside the
                # library. The UI copy says so in as many words.
                result = forget_library(
                    self.service.writer,
                    self.service.paths,
                    int(body["root_id"]),
                    forget_metadata=bool(body.get("forget_metadata", True)),
                )
                if result is None:
                    return self._error(404, "no such library")
                return self._json({"ok": True, **dataclasses.asdict(result),
                                   "message": result.summary})
            if route == "/api/tag":
                return self._json(self._tag(body))
            if route == "/api/brief":
                return self._json(self._brief(body))
            if route == "/api/pause":
                if body.get("paused"):
                    self.service.supervisor.pause()
                else:
                    self.service.supervisor.resume()
                return self._json({"paused": bool(body.get("paused"))})
            return self._error(404, "no such route")
        except Exception as exc:  # noqa: BLE001
            self._error(500, f"{type(exc).__name__}: {exc}")

    # -- writes a person makes ---------------------------------------------

    def _tag(self, body: dict) -> dict:
        """Add or remove a tag a person typed, on one file or a whole selection.

        Two ways to say what to tag, because the UI needs both: `file_ids` for
        "tag this one", and `filter` for "tag all forty of these". The second
        is resolved server-side from the same filter the grid is showing, so
        the page never has to send forty ids.
        """
        kind = (body.get("kind") or "custom").strip().lower()
        if kind not in TAG_KINDS:
            return {"ok": False, "message": f"cannot write tags of kind {kind!r}"}
        name = (body.get("name") or "").strip()
        if not name or len(name) > 80:
            return {"ok": False, "message": "a tag needs a name of 1-80 characters"}

        asset_ids = self._assets_for(body)
        if not asset_ids:
            return {"ok": False, "message": "nothing selected"}

        if body.get("remove"):
            removed = self.service.writer.unset_tag(asset_ids, kind, name)
            return {"ok": True, "removed": removed, "assets": len(asset_ids),
                    "message": f"removed {name} from {len(asset_ids)} items"}

        self.service.writer.set_tag(asset_ids, kind, name)
        noun = "item" if len(asset_ids) == 1 else "items"
        return {"ok": True, "assets": len(asset_ids),
                "message": f"tagged {len(asset_ids)} {noun} {name}"}

    def _assets_for(self, body: dict) -> list[int]:
        """Resolve a tag request to distinct asset ids.

        Distinct *assets*, not files: tagging a selection that happens to hold
        three copies of one photograph is one write, and the tag lands on the
        content so every copy of it shows the tag -- including copies a later
        scan of a different folder turns up.
        """
        with self.service.db() as db:
            file_ids = body.get("file_ids")
            if file_ids:
                ids = [int(i) for i in file_ids][:5000]
                placeholders = ",".join("?" * len(ids))
                rows = db.execute(
                    f"SELECT DISTINCT asset_id FROM file "
                    f"WHERE id IN ({placeholders}) AND asset_id IS NOT NULL",
                    ids,
                ).fetchall()
                return [int(r[0]) for r in rows]

            where, args = build_filter(_as_params(body.get("filter") or {}))
            rows = db.execute(
                f"SELECT DISTINCT v.asset_id FROM v_library v "
                f"WHERE {where} AND v.asset_id IS NOT NULL LIMIT 20000",
                args,
            ).fetchall()
            return [int(r[0]) for r in rows]

    def _brief(self, body: dict) -> dict:
        """Summarise the current selection.

        Answered from the `brief` table when the same filter has been asked
        before, unless the caller asks for a refresh. A brief is the one thing
        in this UI that can cost money, so asking the same question twice
        should not be charged twice.
        """
        params = _as_params(body.get("filter") or {})
        query = canonical_query(params)
        want_model = bool(body.get("use_ai"))

        with self.service.db() as db:
            if not body.get("refresh"):
                cached = find_brief(db, query)
                if cached and (not want_model or cached["produced_by"] != "rules"):
                    return {"ok": True, "cached": True, **cached}
            rows = selection_items(db, params)
            label = filter_label(params, db)

        items = [briefing.Item.from_row(r) for r in rows]
        if not items:
            return {"ok": False, "message": "no indexed files match this filter"}

        produced_by, note = "rules", None
        title, text = "", ""
        if want_model:
            provider, reason = _ai_provider()
            if provider is None:
                note = reason
            else:
                try:
                    title, text, produced_by = briefing.write_brief(
                        items, label, provider)
                except Exception as exc:  # noqa: BLE001
                    # A model that is configured but unwell must not cost the
                    # user their answer: the arithmetic brief is still correct
                    # and still useful, and the reason is reported alongside it.
                    note = f"{type(exc).__name__}: {exc}"
                    produced_by = "rules"
        if produced_by == "rules":
            title, text = briefing.compile_brief(items, label)

        brief_id = self.service.writer.save_brief(
            query, label, title, text, len(items), produced_by)
        return {"ok": True, "cached": False, "id": brief_id, "query": query,
                "label": label, "title": title, "body": text,
                "asset_count": len(items), "produced_by": produced_by,
                "note": note}

    # -- the OS-access routes the browser cannot do itself -----------------

    def _reveal(self, file_id: int) -> dict:
        """Open the file's folder in the OS file manager, selecting the file.

        This is the canonical example of the split: the page has no way to do
        this, and the server does it in one line because it is an ordinary
        local process.
        """
        path = self._path_for(file_id)
        if path is None:
            return {"ok": False, "message": "unknown file"}
        try:
            if sys.platform == "win32":
                # Passed as a single command-line string, deliberately.
                # `subprocess.run(["explorer", f"/select,{path}"])` looks more
                # correct but is broken: list2cmdline quotes any argument
                # containing a space, producing
                #   explorer "/select,C:\...\beach day.jpg"
                # and Explorer parses that as a malformed path -- it opens
                # Documents instead of selecting the file, with no error. The
                # quotes have to sit around the path only:
                #   explorer /select,"C:\...\beach day.jpg"
                # No shell is involved (shell=False with a string goes straight
                # to CreateProcess), so this is not a shell-injection path.
                # Explorer also exits 1 on success, hence check=False.
                subprocess.run(f'explorer /select,"{path}"', check=False)
            elif sys.platform == "darwin":
                subprocess.run(["open", "-R", path], check=False)
            else:
                subprocess.run(["xdg-open", os.path.dirname(path)], check=False)
            return {"ok": True, "path": path}
        except OSError as exc:
            return {"ok": False, "message": str(exc)}

    def _path_for(self, file_id: int) -> str | None:
        with self.service.db() as db:
            row = db.execute(
                "SELECT r.path, f.rel_path FROM file f JOIN root r ON r.id = f.root_id "
                "WHERE f.id = ?",
                (file_id,),
            ).fetchone()
        if row is None:
            return None
        return os.path.join(row["path"], row["rel_path"].replace("/", os.sep))

    def _thumb(self, asset_id: int) -> None:
        with self.service.db() as db:
            row = db.execute(
                "SELECT cache_key FROM thumbnail WHERE asset_id = ? AND kind = 'grid'",
                (asset_id,),
            ).fetchone()
        if row is None:
            return self._error(404, "no thumbnail")
        cache_root = self.service.paths.thumbs.resolve()
        dest = (cache_root / row["cache_key"]).resolve()
        if not str(dest).startswith(str(cache_root)) or not dest.is_file():
            return self._error(404, "no thumbnail")
        data = dest.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "image/webp")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)

    def _raw(self, file_id: int) -> None:
        """Stream an original file to the browser.

        Read through `safety.open_ro` -- never a bare `open()`. This route is
        the UI's only contact with a user's library, and the read-only
        guarantee has to hold here exactly as it does in the extractors.
        """
        path = self._path_for(file_id)
        if path is None or not os.path.isfile(path):
            return self._error(404, "file is missing")

        size = safety.stat_ro(path).st_size
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end = 0, size - 1

        # Range support so <video> can seek; without it Chrome plays from the
        # start and the scrubber does nothing.
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split("-")
            if spec[0]:
                start = int(spec[0])
            if len(spec) > 1 and spec[1]:
                end = min(int(spec[1]), size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)

        length = max(0, end - start + 1)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

        remaining = length
        with safety.open_ro(path) as fh:
            fh.seek(start)
            while remaining > 0:
                chunk = fh.read(min(safety.CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _progress_stream(self) -> None:
        """Server-sent events: one aggregate snapshot per second.

        Aggregate, never per file. 100k progress events would lock up the page
        far more reliably than indexing ever locks up the machine.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        with self.service.db() as conn:
            self._pump(conn)

    def _progress_snapshot(self, conn: sqlite3.Connection) -> dict:
        """One aggregate reading of the queue, over a plain request.

        The same payload the stream pushes. The page needs a *pull* path
        because an EventSource whose connection drops does not report a
        failure it can act on -- it returns to CONNECTING and retries
        forever, so `readyState` never reaches CLOSED. Without something to
        poll, a stream that dies quietly leaves the progress bar frozen on
        its last numbers, which looks exactly like indexing that has stalled.
        """
        counts = {
            r["state"]: r["n"] for r in conn.execute("SELECT * FROM v_state_counts")
        }
        return {
            "queued": counts.get("queued", 0),
            "indexed": counts.get("indexed", 0),
            "error": counts.get("error", 0),
            "missing": counts.get("missing", 0),
            "status": self.service.scan_status,
        }

    def _pump(self, conn: sqlite3.Connection) -> None:
        try:
            while True:
                payload = self._progress_snapshot(conn)
                self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
                self.wfile.flush()
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            return  # the tab closed; nothing to clean up

    # -- plumbing ----------------------------------------------------------

    def _check_origin(self) -> bool:
        """Reject cross-origin and rebound-DNS callers.

        A page on the open internet cannot read our responses thanks to the
        same-origin policy, but it *can* issue requests -- and `/api/scan`
        and `/api/reveal` have side effects. Requiring a loopback Host closes
        the DNS-rebinding path that would otherwise let a malicious page drive
        this server.
        """
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost", "[::1]", "::1"):
            self._error(403, "loopback only")
            return False
        origin = self.headers.get("Origin")
        if origin:
            hostname = urlparse(origin).hostname
            if hostname not in ("127.0.0.1", "localhost", "::1"):
                self._error(403, "cross-origin request refused")
                return False
        return True

    def _static(self, name: str) -> None:
        path = (STATIC / name).resolve()
        if not str(path).startswith(str(STATIC.resolve())) or not path.is_file():
            return self._error(404, "not found")
        data = path.read_bytes()
        ctype = mimetypes.guess_type(name)[0] or "text/plain"
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")  # so refresh actually refreshes
        self.end_headers()
        self.wfile.write(data)

    def _json(self, payload, status: int = 200) -> None:
        data = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)


def _as_params(raw: dict) -> dict[str, list[str]]:
    """Normalise a JSON filter object into the list-of-values shape the query
    builder uses, so a POST body and a query string compile identically."""
    out: dict[str, list[str]] = {}
    for key, value in (raw or {}).items():
        if value in (None, "", [], {}):
            continue
        out[str(key)] = (
            [str(v) for v in value] if isinstance(value, (list, tuple))
            else [str(value)]
        )
    return out


def _ai_provider():
    """(provider, reason) for the UI's optional model pass.

    Resolved per request rather than cached, unlike the worker-side probe: a
    demo turns the provider on and off between questions, and a stale
    "AI is off" is indistinguishable from a broken feature.
    """
    from ..ai.base import AIConfig, get_provider

    try:
        provider = get_provider(AIConfig.from_env())
    except ValueError as exc:
        return None, str(exc)
    if provider is None:
        return None, "AI is off -- set ATHENA_AI_PROVIDER to use a model"
    reason = provider.available()
    return (None, reason) if reason else (provider, None)


def serve(
    paths: AppPaths | None = None,
    host: str = "127.0.0.1",
    port: int = 8731,
    *,
    enable_ml: bool = False,
    open_browser: bool = True,
) -> None:
    service = Service(paths or AppPaths.default(), enable_ml=enable_ml)
    httpd = ThreadingHTTPServer((host, port), partial(Handler, service))
    httpd.daemon_threads = True
    url = f"http://{host}:{port}/"
    print(f"Athena UI  ->  {url}")
    print(f"catalogue  ->  {service.paths.db}")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        httpd.shutdown()
        service.close()
