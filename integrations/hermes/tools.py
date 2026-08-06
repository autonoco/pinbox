"""Pinbox native tools for Hermes — every call shells out to the ``pinbox`` binary.

GUEST ARTIFACT (AGENTS.md guest rule): this module executes inside Hermes's own
venv, a runtime pinbox does not control. Hermes does NO dependency resolution at
plugin install (research 2026-08-02-agent-plugin-formats §2B), so this file is
Python stdlib only — the pinbox CLI is the one integration surface (CLI-first),
and its ``--json`` envelope is the contract:
``{"ok": true, "data": ...} | {"ok": false, "error": {"code", "message", "hint"}}``.
"""

import json
import subprocess


def _envelope_error(code, message, hint):
    return {"ok": False, "error": {"code": code, "message": message, "hint": hint}}


def _run(argv):
    """Run ``pinbox <argv> --json`` and return the parsed envelope. Never raises:
    a missing binary or non-JSON output degrades to an ``ok: false`` envelope so
    hook and tool callers always see the one contract shape."""
    try:
        proc = subprocess.run(
            ["pinbox", *argv, "--json"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError:
        return _envelope_error(
            "E_HUB_UNREACHABLE",
            "pinbox binary not found on PATH",
            "install pinbox, then run `pinbox init` in the project",
        )
    except subprocess.TimeoutExpired:
        return _envelope_error(
            "E_HUB_UNREACHABLE",
            "pinbox timed out after 30s",
            "run `pinbox doctor`",
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        detail = proc.stderr.strip() or "no JSON on stdout"
        return _envelope_error(
            "E_HUB_UNREACHABLE",
            "pinbox produced no JSON envelope: " + detail,
            "run `pinbox doctor`",
        )


def pin_list(status=None):
    """List pins (full pin objects). ``status`` filters: ``open`` or ``resolved``."""
    argv = ["list"]
    if status:
        argv += ["--status", status]
    return _run(argv)


def pin_reply(pin_id, text):
    """Reply on a pin thread as the agent. Sticky sessions: the reply reaches the
    session the thread started in."""
    return _run(["reply", pin_id, text, "--as", "agent"])


def pin_resolve(pin_id, note=None):
    """Resolve a pin as the agent, optionally with a note saying what changed."""
    argv = ["resolve", pin_id, "--as", "agent"]
    if note:
        argv += ["--note", note]
    return _run(argv)


def open_pins():
    """The open-pin list as plain dicts; [] whenever the CLI is unavailable."""
    envelope = pin_list(status="open")
    if not envelope.get("ok"):
        return []
    data = envelope.get("data")
    return data if isinstance(data, list) else []


def compact_pin_line(pin):
    """One markdown bullet per pin: id, selector, text — the injection stays compact
    because it is re-injected every turn."""
    target = pin.get("target") or {}
    selector = target.get("selector", "")
    text = pin.get("text", "")
    return "- `{}` {}: {}".format(pin.get("id", "?"), selector, text)
