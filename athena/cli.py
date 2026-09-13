"""Command-line driver.

In the shipped product the Tauri shell launches this same engine as a
supervised sidecar and speaks newline-delimited JSON to it over stdin/stdout.
The CLI exists so the engine can be developed, profiled and tested with no UI
in the loop at all -- which is also how the read-only guarantee gets tested in
CI, where there is no GUI to drive.
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
import time
from pathlib import Path

from .config import AppPaths
from .core.scanner import Scanner
from .core.scheduler import Progress, Supervisor
from .db.connection import connect_ro
from .db.writer import Writer


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="athena-engine")
    parser.add_argument("--home", help="override the app data directory")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    scan = sub.add_parser("scan", help="index a directory")
    scan.add_argument("path")
    scan.add_argument("--no-ml", action="store_true", help="skip OCR and model tiers")
    scan.add_argument("--workers", type=int, default=None)
    scan.add_argument("--wait", action="store_true",
                      help="keep processing until the backlog is empty")

    ui = sub.add_parser("ui", help="serve the local web UI")
    ui.add_argument("--port", type=int, default=8731)
    ui.add_argument("--ml", action="store_true", help="enable the OCR/model tier")
    ui.add_argument("--no-browser", action="store_true")

    sub.add_parser("status", help="print catalogue counts")
    sub.add_parser("libraries", help="list indexed libraries")

    forget = sub.add_parser(
        "forget",
        help="remove a library from the catalogue (does NOT delete your files)",
    )
    forget.add_argument("path", help="library path, or its id from `libraries`")
    forget.add_argument("--keep-metadata", action="store_true",
                        help="orphan the extracted metadata instead of purging it, "
                             "so re-adding the folder later is instant")
    forget.add_argument("-y", "--yes", action="store_true", help="skip the prompt")

    query = sub.add_parser("search", help="full-text search over extracted text")
    query.add_argument("terms", nargs="+")
    query.add_argument("--limit", type=int, default=20)

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)-18s %(message)s",
    )

    paths = (AppPaths(Path(args.home)) if args.home else AppPaths.default()).ensure()

    if args.cmd == "scan":
        return _scan(paths, args)
    if args.cmd == "ui":
        from .web.server import serve

        serve(paths, port=args.port, enable_ml=args.ml,
              open_browser=not args.no_browser)
        return 0
    if args.cmd == "status":
        return _status(paths)
    if args.cmd == "libraries":
        return _libraries(paths)
    if args.cmd == "forget":
        return _forget(paths, args)
    if args.cmd == "search":
        return _search(paths, args.terms, args.limit)
    return 1


def _scan(paths: AppPaths, args) -> int:
    target = Path(args.path).resolve()
    if not target.is_dir():
        print(f"not a directory: {target}", file=sys.stderr)
        return 2
    if paths.contains(target):
        print("refusing to index Athena's own data directory", file=sys.stderr)
        return 2

    writer = Writer(str(paths.db)).start()
    cancel = threading.Event()

    def handle_signal(_sig, _frame):
        print("\ncancelling; in-flight work will finish", file=sys.stderr)
        cancel.set()

    signal.signal(signal.SIGINT, handle_signal)

    try:
        root_id = writer.call(lambda cur: _ensure_root(cur, str(target)))

        supervisor = Supervisor(
            writer,
            str(paths.db),
            paths.thumbs,
            cpu_workers=args.workers,
            enable_ml=not args.no_ml,
            on_progress=_print_progress,
        )
        supervisor.start()

        scanner = Scanner(writer, cancel=cancel)
        stats = scanner.scan_root(root_id, str(target))
        print(
            f"\nwalk: {stats.files_seen} files in {stats.elapsed:.1f}s "
            f"({stats.files_seen / max(stats.elapsed, 0.01):.0f}/s), "
            f"{stats.skipped} skipped, {stats.files_missing} missing, "
            f"{stats.files_moved} moved, {len(stats.errors)} walk errors",
            file=sys.stderr,
        )

        if args.wait:
            _drain(paths, cancel)
        supervisor.stop()
        return 0
    finally:
        writer.close()


def _drain(paths: AppPaths, cancel: threading.Event) -> None:
    """Block until the backlog empties. Batch/CI convenience, not a UI path."""
    conn = connect_ro(paths.db)
    try:
        idle_rounds = 0
        while not cancel.is_set():
            queued = conn.execute(
                "SELECT COUNT(*) FROM file WHERE state = 'queued'"
            ).fetchone()[0]
            if queued == 0:
                idle_rounds += 1
                if idle_rounds >= 3:   # confirm across a few writer batches
                    return
            else:
                idle_rounds = 0
            time.sleep(1.0)
    finally:
        conn.close()


def _print_progress(p: Progress) -> None:
    eta = f" eta {p.eta_s:.0f}s" if p.eta_s else ""
    sys.stderr.write(
        f"\rindexed {p.indexed:>7}  queued {p.queued:>7}  "
        f"error {p.errored:>5}  missing {p.missing:>5}  "
        f"{p.rate_per_s:>6.1f}/s{eta}   "
    )
    sys.stderr.flush()


def _ensure_root(cur, path: str) -> int:
    cur.execute(
        "INSERT INTO root (path, label) VALUES (?, ?) ON CONFLICT(path) DO NOTHING",
        (path, Path(path).name),
    )
    return int(cur.execute("SELECT id FROM root WHERE path = ?", (path,)).fetchone()[0])


def _libraries(paths: AppPaths) -> int:
    from .core.library import list_libraries

    conn = connect_ro(paths.db)
    try:
        libs = list_libraries(conn)
    finally:
        conn.close()
    if not libs:
        print("no libraries indexed yet")
        return 0
    for lib in libs:
        state = "" if lib.exists else "   [offline - path not found]"
        print(f"[{lib.id}] {lib.path}{state}")
        print(f"     {lib.indexed} indexed, {lib.missing} missing, "
              f"{lib.errors} errors, {lib.bytes / 1e9:.2f} GB")
    return 0


def _forget(paths: AppPaths, args) -> int:
    from .core.library import forget_library, list_libraries

    conn = connect_ro(paths.db)
    try:
        libs = list_libraries(conn)
    finally:
        conn.close()

    target = args.path.strip()
    match = next(
        (l for l in libs
         if str(l.id) == target
         or Path(l.path) == Path(target).expanduser().resolve()
         or l.path == target),
        None,
    )
    if match is None:
        print(f"no library matching {target!r}; try `athena-engine libraries`",
              file=sys.stderr)
        return 2

    print(f"Forget {match.path}?")
    print(f"  {match.files} catalogue entries will be removed.")
    print("  Your files are NOT deleted. Nothing inside that folder is touched.")
    if not args.yes:
        if input("Type 'forget' to confirm: ").strip().lower() != "forget":
            print("cancelled")
            return 1

    writer = Writer(str(paths.db)).start()
    try:
        result = forget_library(writer, paths, match.id,
                                forget_metadata=not args.keep_metadata)
    finally:
        writer.close()
    print(result.summary if result else "nothing to do")
    return 0


def _status(paths: AppPaths) -> int:
    conn = connect_ro(paths.db)
    try:
        counts = {r["state"]: r["n"] for r in conn.execute("SELECT * FROM v_state_counts")}
        assets = conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0]
        by_type = {
            r["media_type"]: r["n"]
            for r in conn.execute(
                "SELECT media_type, COUNT(*) n FROM asset GROUP BY media_type"
            )
        }
        dupes = conn.execute(
            "SELECT COUNT(*) c, COALESCE(SUM(reclaimable_bytes), 0) b FROM v_duplicate_group"
        ).fetchone()
        mutations = conn.execute(
            "SELECT COUNT(*) FROM integrity_audit WHERE verdict = 'mutated'"
        ).fetchone()[0]
        print(json.dumps({
            "states": counts,
            "assets": assets,
            "by_media_type": by_type,
            "duplicate_groups": dupes["c"],
            "reclaimable_bytes": dupes["b"],
            "source_mutations_detected": mutations,
        }, indent=2))
    finally:
        conn.close()
    return 0


def _search(paths: AppPaths, terms: list[str], limit: int) -> int:
    conn = connect_ro(paths.db)
    try:
        # `snippet()` returns the matching fragment with the hit delimited, so
        # results explain themselves without a second read of the source file.
        rows = conn.execute(
            """
            SELECT f.rel_path, tb.source, tb.ord,
                   snippet(text_fts, 0, '[', ']', ' ... ', 12) AS excerpt,
                   bm25(text_fts) AS score
            FROM text_fts
            JOIN text_block tb ON tb.id = text_fts.rowid
            JOIN file f        ON f.asset_id = tb.asset_id AND f.state = 'indexed'
            WHERE text_fts MATCH ?
            ORDER BY score
            LIMIT ?
            """,
            (" ".join(terms), limit),
        ).fetchall()
        for row in rows:
            location = f"{row['source']}#{row['ord']}" if row["ord"] else row["source"]
            print(f"{row['rel_path']}  ({location})\n    {row['excerpt']}\n")
        if not rows:
            print("no matches")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
