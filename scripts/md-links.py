#!/usr/bin/env python3
"""Offline check of every relative link in the repository's Markdown files.

A link that leaves the repository (http(s), mailto, ...) is not checked here: docs.nebius.com links
are checked against the committed catalog (`make docs-links`) and every other URL by lychee
(`make links`, network). Everything else must resolve:

  - the target file or directory exists (relative to the linking file; a leading / is the repo root);
  - a #anchor into a .md file (or into the linking file itself) matches a heading there, slugged the
    way GitHub does it (lowercase, punctuation dropped, spaces to hyphens, duplicates suffixed -1,
    -2, ...), or an explicit <a id="..."> / <a name="..."> anchor.

Skipped: node_modules, .cache, .git, .terraform, terraform/stacks/soperator/upstream, portal/**/dist;
links inside code fences and inline code.

Usage: scripts/md-links.py [file.md ...]   (default: every .md file in the repository)
Exit 1 when any link is broken. Stdlib only.
"""
from __future__ import annotations

import re
import sys
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
SKIP_NAMES = {"node_modules", ".cache", ".git", ".terraform"}
SKIP_PREFIXES = ("terraform/stacks/soperator/upstream/",)

FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
ATX = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$")
SETEXT = re.compile(r"^\s{0,3}(=+|-+)\s*$")
INLINE_CODE = re.compile(r"(`+)(.+?)\1")
# [text](target "title") and ![alt](target); the target may be <wrapped in angle brackets>
INLINE_LINK = re.compile(r"\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)")
REF_DEF = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)")
HTML_ANCHOR = re.compile(r"<a\s[^>]*?\b(?:id|name)\s*=\s*[\"']([^\"']+)[\"']", re.I)
HTML_HREF = re.compile(r"<a\s[^>]*?\bhref\s*=\s*[\"']([^\"']+)[\"']", re.I)
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def skipped(rel: str) -> bool:
    parts = rel.split("/")
    if any(p in SKIP_NAMES for p in parts):
        return True
    if rel.startswith(SKIP_PREFIXES):
        return True
    return parts[0] == "portal" and "dist" in parts


def markdown_files() -> list[Path]:
    return sorted(p for p in ROOT.rglob("*.md") if p.is_file() and not skipped(p.relative_to(ROOT).as_posix()))


def prose_lines(text: str):
    """(line number, line) for every line outside a code fence, with inline code blanked."""
    fence = None
    for n, line in enumerate(text.splitlines(), 1):
        m = FENCE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not line.strip().strip(fence[0]):
                fence = None
            continue
        if m:
            fence = m.group(1)
            continue
        yield n, INLINE_CODE.sub(lambda c: " " * len(c.group(0)), line)


def slug(heading: str) -> str:
    """GitHub's heading anchor: rendered text, lowercase, drop punctuation, spaces to hyphens."""
    h = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", heading)  # links and images keep their text
    h = re.sub(r"!?\[([^\]]*)\]\[[^\]]*\]", r"\1", h)
    # inline HTML and emphasis markers go; inside `code` every character is text
    # (single _ stays: GitHub keeps it)
    parts = re.split(r"(`+[^`]*`+)", h)
    h = "".join(p.strip("`") if p.startswith("`") else re.sub(r"(\*\*|__|\*|~~)", "", re.sub(r"<[^>]+>", "", p)) for p in parts)
    h = h.strip().lower()
    h = re.sub(r"[^\w\- ]", "", h)
    return h.replace(" ", "-")


@lru_cache(maxsize=None)
def anchors(path: Path) -> frozenset[str]:
    """Every anchor GitHub generates for a Markdown file, plus explicit <a id/name> anchors."""
    text = path.read_text(encoding="utf-8", errors="replace")
    seen: dict[str, int] = {}
    out: set[str] = set()

    def add(heading: str) -> None:
        base = slug(heading)
        n = seen.get(base, 0)
        seen[base] = n + 1
        out.add(base if n == 0 else f"{base}-{n}")

    prev = ""
    fence = None
    for line in text.splitlines():
        m = FENCE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not line.strip().strip(fence[0]):
                fence = None
            prev = ""
            continue
        if m:
            fence = m.group(1)
            prev = ""
            continue
        out.update(HTML_ANCHOR.findall(line))
        atx = ATX.match(line)
        if atx:
            add(atx.group(2))
            prev = ""
            continue
        if SETEXT.match(line) and prev.strip() and not re.match(r"^\s{0,3}([-*+>|#]|\d+[.)]\s)", prev):
            add(prev.strip())
            prev = ""
            continue
        prev = line
    return frozenset(out)


def targets(line: str):
    for rx in (INLINE_LINK, REF_DEF, HTML_HREF):
        for m in rx.finditer(line):
            t = m.group(1)
            yield t[1:-1] if t.startswith("<") and t.endswith(">") else t


def shown(path: Path) -> str:
    return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else str(path)


def check(md: Path) -> list[str]:
    rel = shown(md)
    problems = []
    for n, line in prose_lines(md.read_text(encoding="utf-8", errors="replace")):
        for target in targets(line):
            if SCHEME.match(target) or target.startswith("//"):
                continue
            path_part, _, anchor = target.partition("#")
            path_part = unquote(path_part.split("?")[0])
            if path_part:
                dest = (ROOT / path_part.lstrip("/")) if path_part.startswith("/") else (md.parent / path_part)
                dest = dest.resolve()
                if not dest.exists():
                    problems.append(f"{rel}:{n}: {target}: no such file")
                    continue
            else:
                dest = md
            if anchor and dest.is_file() and dest.suffix.lower() == ".md":
                if unquote(anchor) not in anchors(dest) and unquote(anchor).lower() not in anchors(dest):
                    problems.append(f"{rel}:{n}: {target}: no such heading anchor in {shown(dest)}")
    return problems


def main() -> int:
    files = [Path(a).resolve() for a in sys.argv[1:]] or markdown_files()
    problems = [p for f in files for p in check(f)]
    for p in problems:
        print(f"broken link: {p}")
    if problems:
        print(f"{len(problems)} broken relative link(s) in {len(files)} Markdown files")
        return 1
    print(f"Markdown links: every relative link and #anchor in {len(files)} files resolves")
    return 0


if __name__ == "__main__":
    sys.exit(main())
