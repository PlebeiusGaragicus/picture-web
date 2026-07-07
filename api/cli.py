"""comic-canvas CLI — the packaged entrypoint.

Verbs: start (default), open, doctor, version, path, logs, update, uninstall.
"""

from __future__ import annotations

import argparse
import multiprocessing
import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

GITHUB_REPO = "PlebeiusGaragicus/picture-web"
INSTALL_URL = f"https://raw.githubusercontent.com/{GITHUB_REPO}/main/install.sh"


def _bootstrap_sys_path() -> None:
    """Flat api/ imports (`import library`) need this dir on sys.path."""
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))


_bootstrap_sys_path()

import app_config  # noqa: E402
import appmain  # noqa: E402
import paths  # noqa: E402
import preflight  # noqa: E402
from version import APP_VERSION  # noqa: E402


def _fail_preflight(report: preflight.PreflightReport) -> int:
    print("comic-canvas cannot start — required tools are missing:\n", file=sys.stderr)
    print(report.render(), file=sys.stderr)
    print(
        f"\ncomic-canvas drives the pi agent installed on YOUR system (your own models"
        f"\nand credentials). Install/repair it and retry, or bypass this check with"
        f"\n{preflight.SKIP_ENV}=1 (agent features will fail until pi works).",
        file=sys.stderr,
    )
    return 2


def cmd_start(args: argparse.Namespace) -> int:
    report = preflight.preflight()
    if not report.ok and not preflight.skip_pi_check():
        return _fail_preflight(report)

    live = appmain.read_live_instance()
    if live:
        url = appmain.app_url(live["port"], app_config.get_value("authToken"))
        print(f"comic-canvas is already running at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    token = app_config.ensure_auth_token()
    log_path = appmain.configure_file_logging(verbose=args.verbose)
    port = appmain.pick_port(args.port or int(app_config.get_value("port") or 8787))
    url = appmain.app_url(port, token)
    print(f"comic-canvas v{APP_VERSION}")
    print(f"  UI:      {url}")
    print(f"  library: {paths.HOME}")
    print(f"  logs:    {log_path}")
    print("Press Ctrl-C to stop.")
    appmain.run_server(port, token, open_browser=not args.no_browser, verbose=args.verbose)
    return 0


def cmd_open(args: argparse.Namespace) -> int:
    live = appmain.read_live_instance()
    if not live:
        print("comic-canvas is not running. Start it with: comic-canvas", file=sys.stderr)
        return 1
    webbrowser.open(appmain.app_url(live["port"], app_config.get_value("authToken")))
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    report = preflight.preflight()
    print(f"comic-canvas v{APP_VERSION} (library stamp: {app_config.library_version() or 'none'})")
    print(f"home: {paths.HOME}")
    live = appmain.read_live_instance()
    print(f"server: {'running on port ' + str(live['port']) if live else 'not running'}")
    print("checks:")
    print(report.render())
    if any(c.name == "pi" and c.ok for c in report.checks):
        probe = preflight.rpc_handshake_probe()
        mark = "ok" if probe.ok else "FAILED"
        print(f"  [{mark:>7}] {probe.name}: {probe.detail}")
    else:
        probe = None
    hard_fail = not report.ok or (probe is not None and not probe.ok)
    return 2 if hard_fail else 0


def cmd_version(args: argparse.Namespace) -> int:
    print(APP_VERSION)
    return 0


def cmd_path(args: argparse.Namespace) -> int:
    print(paths.HOME)
    return 0


def cmd_logs(args: argparse.Namespace) -> int:
    log_path = paths.logs_dir() / "comic-canvas.log"
    if args.tail:
        if not log_path.is_file():
            print(f"No log file yet at {log_path}", file=sys.stderr)
            return 1
        subprocess.run(["tail", "-n", "100", "-f", str(log_path)])
        return 0
    print(log_path)
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    print("Updating comic-canvas via the installer.")
    print("NOTE: pre-1.0 releases may change on-disk schemas; existing projects")
    print(f"may stop loading. Back up first: cp -r {paths.HOME}/projects <somewhere-safe>")
    script = subprocess.run(["curl", "-fsSL", INSTALL_URL], capture_output=True, text=True)
    if script.returncode != 0:
        print(f"Could not download installer: {script.stderr.strip()}", file=sys.stderr)
        return 1
    return subprocess.run(["bash", "-s", "--"] + (["--yes"] if args.yes else []), input=script.stdout, text=True).returncode


def cmd_uninstall(args: argparse.Namespace) -> int:
    app_dir = paths.HOME / "app"
    launcher = Path.home() / ".local" / "bin" / "comic-canvas"
    print("This removes the comic-canvas application, NOT your projects.")
    if not args.yes:
        answer = input(f"Remove {app_dir} and {launcher}? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return 1
    if launcher.is_symlink() or launcher.is_file():
        launcher.unlink()
    if app_dir.is_dir():
        shutil.rmtree(app_dir)
    print(f"Uninstalled. Your projects remain at {paths.HOME / 'projects'};")
    print(f"remove everything with: rm -rf {paths.HOME}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="comic-canvas", description="AI-assisted comic book builder")
    sub = parser.add_subparsers(dest="command")

    start = sub.add_parser("start", help="start the app and open the browser (default)")
    start.add_argument("--port", type=int, default=None, help="preferred port (default 8787)")
    start.add_argument("--no-browser", action="store_true", help="do not open a browser")
    start.add_argument("--verbose", action="store_true", help="debug logging + access log")
    start.set_defaults(func=cmd_start)

    sub.add_parser("open", help="open the browser to the running app").set_defaults(func=cmd_open)
    sub.add_parser("doctor", help="diagnose pi/node/key/server state").set_defaults(func=cmd_doctor)
    sub.add_parser("version", help="print the app version").set_defaults(func=cmd_version)
    sub.add_parser("path", help="print the comic-canvas home dir").set_defaults(func=cmd_path)

    logs = sub.add_parser("logs", help="print the log path")
    logs.add_argument("--tail", action="store_true", help="tail -f the log")
    logs.set_defaults(func=cmd_logs)

    update = sub.add_parser("update", help="update to the latest release")
    update.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    update.set_defaults(func=cmd_update)

    uninstall = sub.add_parser("uninstall", help="remove the app (keeps your projects)")
    uninstall.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    uninstall.set_defaults(func=cmd_uninstall)

    return parser


KNOWN_COMMANDS = {"start", "open", "doctor", "version", "path", "logs", "update", "uninstall", "-h", "--help"}


def main(argv: list[str] | None = None) -> int:
    multiprocessing.freeze_support()
    parser = build_parser()
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in KNOWN_COMMANDS:
        # Bare `comic-canvas [--flags]` == `comic-canvas start [--flags]`.
        argv = ["start"] + argv
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\nStopped.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
