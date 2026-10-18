#!/usr/bin/env python3
"""Catalog of the official Nebius AI Cloud documentation (docs.nebius.com), kept current.

The catalog is how this repository stays tied to the docs it builds on: every key page, its
sections (anchors you can deep-link to), the redirects behind the URLs people paste, a content
hash per page so a weekly run can say exactly what changed upstream, and every place in this
repository that cites a page.

  scripts/nebius-docs.py crawl     fetch the sitemap and every in-scope page as raw Markdown
                                   (the docs serve <url>.md), write docs/reference/nebius-docs.json
                                   and render docs/reference/nebius-docs.md
  scripts/nebius-docs.py render    re-render the Markdown index from the JSON and the TOML
  scripts/nebius-docs.py check     re-crawl into memory and compare with the committed JSON;
                                   also verify every docs.nebius.com link in the repository
                                   (page exists, #anchor exists). Exit 3 on drift, 1 on dead links.

Inputs:  docs/reference/nebius-docs.toml (hand-maintained: key pages, task index, scope)
Outputs: docs/reference/nebius-docs.json, docs/reference/nebius-docs.md (generated; do not edit)
Cache:   .cache/nebius-docs/ (git-ignored raw Markdown, for reading pages offline)

Only metadata (titles, headings, hashes, links) is committed; page text stays in the cache.
Stdlib only. Polite: robots.txt allows crawling; requests are throttled and identified.
"""
from __future__ import annotations

import concurrent.futures as cf
import hashlib
import json
import re
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOML = ROOT / "docs" / "reference" / "nebius-docs.toml"
JSON = ROOT / "docs" / "reference" / "nebius-docs.json"
MD = ROOT / "docs" / "reference" / "nebius-docs.md"
CACHE = ROOT / ".cache" / "nebius-docs"
BASE = "https://docs.nebius.com"
UA = "nebius-infrastructure-patterns-docs-catalog/1.0 (+https://github.com/TylrDn/Nebius-Estate)"
SCAN_GLOBS = ["**/*.md", "**/*.tf", "**/*.yaml", "**/*.yml", "**/*.sh", "**/*.py", "**/*.ts", "**/*.tsx", "**/*.hcl", "Makefile"]
SKIP_DIRS = {"node_modules", ".git", ".cache", "upstream", "dist", "dist-types", ".terraform"}
DOC_URL = re.compile(r"https://docs\.nebius\.com(/[A-Za-z0-9_\-./]*)?(#[A-Za-z0-9_\-]+)?")

_lock = threading.Lock()
_last = [0.0]


def fetch(url: str, method: str = "GET", rate: float = 0.25) -> tuple[int, str, str]:
    """Return (status, final_url, body). Throttled to one request per `rate` seconds overall."""
    with _lock:
        wait = _last[0] + rate - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.monotonic()
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.geturl(), r.read().decode("utf-8", "replace") if method == "GET" else ""
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(2 ** attempt * 2)
                continue
            return e.code, url, ""
        except (urllib.error.URLError, TimeoutError):
            if attempt < 2:
                time.sleep(2)
                continue
            return 0, url, ""
    return 0, url, ""


def probe(url: str) -> dict:
    """{"status": final HTTP status, "redirects_to": final URL when it differs (urllib follows redirects)}."""
    status, final, _ = fetch(url, method="HEAD")
    final = final.rstrip("/")
    return {"status": status, "redirects_to": final if status and final != url.rstrip("/") else None}


def norm(path: str) -> str:
    """Docs link → canonical page path: /x/index and /x.mdx are the page /x."""
    path = path.split("#")[0].rstrip("/").removesuffix(".md").removesuffix(".mdx").removesuffix("/index")
    return path or "/"


def slug(heading: str) -> str:
    """Mintlify/GitHub-style anchor: strip markdown, lowercase, spaces to hyphens, drop punctuation."""
    h = re.sub(r"`([^`]*)`", r"\1", heading)
    h = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", h)
    h = re.sub(r"<[^>]+>", "", h).strip().lower()
    h = re.sub(r"[^\w\- ]", "", h)
    return re.sub(r" ", "-", h)


def parse_page(path: str, text: str) -> dict:
    title = None
    m = re.search(r"^title:\s*[\"']?(.+?)[\"']?\s*$", text, re.M)
    if m:
        title = m.group(1)
    headings, in_code = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
            continue
        hm = None if in_code else re.match(r"^(#{1,3})\s+(.+?)\s*#*\s*$", line)
        if hm:
            if len(hm.group(1)) == 1 and not title:
                title = hm.group(2)
            elif len(hm.group(1)) > 1:
                headings.append({"level": len(hm.group(1)), "text": re.sub(r"`", "", hm.group(2)), "anchor": slug(hm.group(2))})
    links = set()
    for lm in re.finditer(r"\]\((/[A-Za-z0-9_\-./]+|https://docs\.nebius\.com/[A-Za-z0-9_\-./]*)(#[^)\s]*)?\)", text):
        p = norm(lm.group(1).replace(BASE, ""))
        if p != path and not p.endswith(".txt"):
            links.add(p)
    return {
        "path": path,
        "title": title or path,
        "sha256": hashlib.sha256(text.encode()).hexdigest()[:16],
        "headings": headings,
        "links": sorted(links),
    }


def load_config() -> dict:
    return tomllib.loads(TOML.read_text())


def sitemap() -> dict[str, str]:
    status, _, body = fetch(f"{BASE}/sitemap.xml")
    if status != 200:
        sys.exit(f"sitemap.xml: HTTP {status}")
    out = {}
    for m in re.finditer(r"<url>\s*<loc>([^<]+)</loc>(?:\s*<lastmod>([^<]+)</lastmod>)?", body):
        out[m.group(1).replace(BASE, "").rstrip("/") or "/"] = (m.group(2) or "")[:10]
    return out


def crawl(write: bool) -> dict:
    cfg = load_config()
    reference_only = set(cfg["scope"]["reference_only"])
    pages = sitemap()
    sections: dict[str, dict] = {}
    for p in pages:
        sec = p.strip("/").split("/")[0] or "/"
        s = sections.setdefault(sec, {"pages": 0, "reference_only": sec in reference_only})
        s["pages"] += 1
    in_scope = [p for p in pages if p.strip("/").split("/")[0] not in reference_only]
    # Reference sections: catalog only their landing page(s).
    in_scope += [p for p in pages if p.strip("/").count("/") == 0 and p.strip("/") in reference_only]
    out: dict[str, dict] = {}

    def one(p: str):
        status, _, body = fetch(f"{BASE}{p}.md")
        if status != 200:
            return p, {"path": p, "title": p, "error": status}
        if write:
            f = CACHE / f"{p.strip('/') or 'index'}.md"
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(body)
        rec = parse_page(p, body)
        rec["lastmod"] = pages.get(p, "")
        return p, rec

    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for i, (p, rec) in enumerate(ex.map(one, sorted(set(in_scope))), 1):
            out[p] = rec
            if i % 50 == 0:
                print(f"  {i}/{len(set(in_scope))} pages", file=sys.stderr)

    # Key pages as people paste them (trailing slash etc.) and the redirects behind them.
    seeds = []
    for s in cfg["key_pages"]:
        url = s["url"]
        path = url.replace(BASE, "").rstrip("/") or "/"
        seeds.append({**s, "path": path, **probe(url), "in_sitemap": path in pages})
    # Links inside crawled pages that point outside the sitemap: dead or redirected.
    outside = sorted({l for r in out.values() for l in r.get("links", []) if l not in pages})
    redirects = {l: probe(f"{BASE}{l}") for l in outside}
    catalog = {
        "generated": time.strftime("%Y-%m-%d"),
        "source": f"{BASE}/sitemap.xml",
        "sections": dict(sorted(sections.items())),
        "key_pages": seeds,
        "pages": dict(sorted(out.items())),
        "links_outside_sitemap": {k: v for k, v in redirects.items()},
    }
    return catalog


def repo_citations() -> dict[str, list[str]]:
    """{docs path (with #anchor if any): [repo files citing it]}"""
    cites: dict[str, set[str]] = {}
    for g in SCAN_GLOBS:
        for f in ROOT.glob(g):
            if any(part in SKIP_DIRS for part in f.relative_to(ROOT).parts) or f.is_dir():
                continue
            rel = str(f.relative_to(ROOT))
            if rel.startswith("docs/reference/nebius-docs"):
                continue
            try:
                text = f.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            for m in DOC_URL.finditer(text):
                path = norm((m.group(1) or "/").rstrip("."))
                cites.setdefault(path + (m.group(2) or ""), set()).add(rel)
    return {k: sorted(v) for k, v in sorted(cites.items())}


def render(catalog: dict) -> None:
    cfg = load_config()
    pages = catalog["pages"]
    cites = repo_citations()
    by_page: dict[str, set[str]] = {}
    for k, files in cites.items():
        by_page.setdefault(k.split("#")[0], set()).update(files)

    def link(path: str, anchor: str = "") -> str:
        rec = pages.get(path.split("#")[0])
        title = rec["title"] if rec else path
        return f"[{title}]({BASE}{path}{('#' + anchor) if anchor else ''})"

    L = [
        "# Nebius documentation catalog",
        "",
        f"Generated by `make docs-catalog` (scripts/nebius-docs.py) from [{BASE}/sitemap.xml]({BASE}/sitemap.xml) on {catalog['generated']}. Do not edit by hand:",
        "key pages and the task index live in [`nebius-docs.toml`](nebius-docs.toml). `make docs-check` reports upstream changes and dead links.",
        "",
        "Every page is also available as raw Markdown at `<url>.md` (or send `Accept: text/markdown`). For tools, the docs "
        f"publish [llms.txt]({BASE}/llms.txt) (index) and [llms-full.txt]({BASE}/llms-full.txt) (full text), and a read-only "
        f"docs search MCP server at `{BASE}/mcp` ([setup]({BASE}/docs-ai#docs-model-context-protocol-server)).",
        "",
        "## By task",
        "",
        "| Task | Read | In this repo |",
        "|---|---|---|",
    ]
    for t in cfg.get("tasks", []):
        refs = "<br>".join(link(*r.split("#", 1)) if "#" in r else link(r) for r in t["docs"])
        repo = ", ".join(f"[`{p}`](../../{p})" for p in t.get("repo", []))
        L.append(f"| {t['task']} | {refs} | {repo} |")
    L += ["", "## Key pages", "", "| Page | Sections | Redirect | Cited in this repo |", "|---|---|---|---|"]
    for s in catalog["key_pages"]:
        rec = pages.get(s["path"], {})
        secs = " · ".join(f"[{h['text']}]({BASE}{s['path']}#{h['anchor']})" for h in rec.get("headings", []) if h["level"] == 2)
        redirect = f"→ `{s['redirects_to'].replace(BASE, '')}`" if s.get("redirects_to") else ("" if s.get("status") == 200 else f"HTTP {s.get('status')}")
        used = len(by_page.get(s["path"], ()))
        L.append(f"| {link(s['path'])}<br><sub>{s.get('why', '')}</sub> | {secs or '—'} | {redirect} | {used or ''} |")
    L += ["", "## Sections", "", "| Section | Pages | Catalogued |", "|---|---|---|"]
    for name, s in catalog["sections"].items():
        L.append(f"| `{name}` | {s['pages']} | {'landing page only (generated reference)' if s['reference_only'] else 'every page'} |")
    L += ["", "## All catalogued pages", ""]
    current = None
    for path, rec in pages.items():
        sec = path.strip("/").split("/")[0]
        if sec != current:
            L += ["", f"### {sec}", ""]
            current = sec
        used = by_page.get(path)
        L.append(f"- {link(path)}{' — cited by ' + ', '.join(f'`{u}`' for u in sorted(used)[:4]) + (' …' if len(used) > 4 else '') if used else ''}")
    outside = catalog["links_outside_sitemap"]
    if outside:
        L += ["", "## Links inside the docs that are not in the sitemap", "",
              "Old paths the docs still link to. Cite the target, not the old path.", "",
              "| Linked path | Status | Resolves to |", "|---|---|---|"]
        for k, v in outside.items():
            to = v["redirects_to"].replace(BASE, "") if v["redirects_to"] else ""
            L.append(f"| `{k}` | {v['status'] or 'no response'} | {('`' + to + '`') if to else ('dead upstream' if v['status'] != 200 else 'live, unlisted')} |")
    MD.write_text("\n".join(L) + "\n")


def check_repo_links(catalog: dict) -> list[str]:
    pages = catalog["pages"]
    known = set(pages) | {s["path"] for s in catalog["key_pages"]}
    reference_only = {n for n, s in catalog["sections"].items() if s["reference_only"]}
    problems = []
    for key, files in repo_citations().items():
        path, _, anchor = key.partition("#")
        if path.strip("/").split("/")[0] in reference_only and path not in pages:
            continue  # generated reference pages are not crawled one by one
        if path not in known:
            problems.append(f"{key}: page not in the docs sitemap (cited by {', '.join(files[:3])})")
        elif anchor and anchor not in {h["anchor"] for h in pages.get(path, {}).get("headings", [])}:
            problems.append(f"{key}: no such section anchor (cited by {', '.join(files[:3])})")
    return problems


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "crawl":
        catalog = crawl(write=True)
        JSON.write_text(json.dumps(catalog, indent=1, sort_keys=False) + "\n")
        render(catalog)
        print(f"catalogued {len(catalog['pages'])} pages; wrote {JSON.relative_to(ROOT)} and {MD.relative_to(ROOT)}")
        return 0
    if cmd == "render":
        render(json.loads(JSON.read_text()))
        return 0
    if cmd == "check":
        old = json.loads(JSON.read_text())
        problems = check_repo_links(old)
        for p in problems:
            print(f"dead link: {p}")
        if "--offline" in sys.argv:
            if not problems:
                print(f"docs.nebius.com links: every page and #anchor cited in the repository is in {JSON.relative_to(ROOT)}")
            return 1 if problems else 0
        new = crawl(write=False)
        changed = [p for p in new["pages"] if p in old["pages"] and new["pages"][p].get("sha256") != old["pages"][p].get("sha256")]
        added = sorted(set(new["pages"]) - set(old["pages"]))
        removed = sorted(set(old["pages"]) - set(new["pages"]))
        moved = [s["url"] for s in new["key_pages"] if s.get("redirects_to") != next((o.get("redirects_to") for o in old["key_pages"] if o["url"] == s["url"]), None)]
        moved += [f"{BASE}{k} (link target now {v['status']})" for k, v in new["links_outside_sitemap"].items() if old["links_outside_sitemap"].get(k, {}).get("status") != v["status"]]
        for title, items in (("changed", changed), ("new", added), ("removed", removed), ("key page redirect changed", moved)):
            if items:
                print(f"\n## {title} ({len(items)})")
                print("\n".join(f"- {BASE}{i}" if i.startswith("/") else f"- {i}" for i in items))
        if problems:
            return 1
        return 3 if (changed or added or removed or moved) else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
