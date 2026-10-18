#!/usr/bin/env python3
"""Render docs/compatibility-matrix.md from platform/versions.yaml.

Keeps the version matrix in one place (P6: no claim without exact versions).
Reads versions.yaml through scripts/versions.py (stdlib only). --check fails instead of writing.
"""
from __future__ import annotations

import sys

from versions import ROOT, VERSIONS as SRC, parse

DST = ROOT / "docs" / "compatibility-matrix.md"


def main() -> None:
    leaves = parse(SRC.read_text())
    rows = []
    for path, f in leaves:
        version = f.get("version") or f.get("value") or f.get("ref") or ""
        rows.append(
            "| `{}` | {} | {} | {} | {} |".format(
                " / ".join(path),
                version,
                f.get("install") or f.get("chart", ""),
                f.get("verified", ""),
                (f.get("note", "") + (" — " if f.get("note") and f.get("source") else "") + (f"[source]({f['source']})" if f.get("source", "").startswith("http") else f.get("source", ""))).strip(),
            )
        )
    out = [
        "# Compatibility matrix",
        "",
        "Generated from [`platform/versions.yaml`](../platform/versions.yaml) by `make compat-matrix`. Do not edit by hand.",
        "",
        "Every row is a value this repo pins and the date it was last checked against its source.",
        "No row is a Nebius support statement; re-verify before quoting to a customer (P6).",
        "",
        "| Component | Version / ref | Install method | Verified | Notes / source |",
        "|---|---|---|---|---|",
        *rows,
        "",
    ]
    text = "\n".join(out)
    if "--check" in sys.argv[1:]:
        if DST.read_text() != text:
            sys.exit(f"{DST.relative_to(ROOT)} is stale: run make compat-matrix")
        print(f"{DST.relative_to(ROOT)} is up to date")
        return
    DST.write_text(text)
    print(f"wrote {DST.relative_to(ROOT)} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
