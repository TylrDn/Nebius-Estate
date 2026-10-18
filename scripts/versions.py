"""Reader for platform/versions.yaml (a flat subset of YAML), shared by the repo scripts.

Stdlib only, so every script runs on a bare python3. Entries are inline maps,
e.g. `kubectl: { version: "1.35.9", sha256: "…" }`, or block maps of scalars.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSIONS = ROOT / "platform" / "versions.yaml"

_INLINE = re.compile(r"^(?P<indent>\s*)(?P<key>[^:#]+):\s*\{(?P<body>.*)\}\s*$")
_KEY = re.compile(r"^(?P<indent>\s*)(?P<key>[^:#]+):\s*(?P<val>.*?)\s*$")
_FIELD = re.compile(r'([\w/-]+):\s*"((?:[^"\\]|\\.)*)"')


def parse(text: str) -> list[tuple[list[str], dict[str, str]]]:
    """Return (path, fields) for every leaf, e.g. (["tooling", "kubectl"], {"version": "1.35.9", ...})."""
    stack: list[tuple[int, str]] = []
    leaves: list[tuple[list[str], dict[str, str]]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        inline = _INLINE.match(raw)
        m = inline or _KEY.match(raw)
        if not m:
            continue
        indent = len(m.group("indent"))
        while stack and stack[-1][0] >= indent:
            stack.pop()
        key = m.group("key").strip()
        if inline:
            leaves.append(([s[1] for s in stack] + [key], dict(_FIELD.findall(m.group("body")))))
        elif m.group("val") == "":
            stack.append((indent, key))
        else:  # plain scalar under a block map (e.g. upstream.x.ref)
            path = [s[1] for s in stack]
            val = m.group("val").strip().strip('"')
            for leaf in leaves:
                if leaf[0] == path:
                    leaf[1][key] = val
                    break
            else:
                leaves.append((path, {key: val}))
    return leaves


def load() -> dict[str, dict[str, str]]:
    """All leaves keyed by their slash path, e.g. "tooling/kubectl"."""
    return {"/".join(path): fields for path, fields in parse(VERSIONS.read_text())}
