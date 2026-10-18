#!/usr/bin/env python3
"""Compare pinned versions in platform/versions.yaml with what upstream publishes now.

Checks (network, read-only):
  - nebius/nebius Terraform provider: registry latest vs pinned
  - vllm/vllm-openai: latest vX.Y.Z tag on Docker Hub vs pinned
  - nebius/soperator: highest release tag vs pinned
  - nebius/nebius-solutions-library: highest soperator-v* release tag vs pinned tag
Exit 0 and print a table; exit 3 if anything drifted (CI opens/updates an issue).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSIONS = (ROOT / "platform" / "versions.yaml").read_text()


def pinned(pattern: str) -> str:
    m = re.search(pattern, VERSIONS, re.M)
    return m.group(1) if m else "?"


def get_json(url: str):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "nip-version-check"}), timeout=30) as r:
        return json.load(r)


def semver_key(s: str):
    return [int(x) for x in re.findall(r"\d+", s)]


def docker_hub_tags(repo: str, prefix: str) -> list[str]:
    """Every tag starting with `prefix`, following Docker Hub's `next` links (no page limit)."""
    url = f"https://hub.docker.com/v2/repositories/{repo}/tags?page_size=100&name={prefix}"
    names: list[str] = []
    while url:
        page = get_json(url)
        names.extend(t["name"] for t in page["results"])
        url = page.get("next")
    return names


def ls_remote_tags(repo: str) -> list[str]:
    out = subprocess.run(["git", "ls-remote", "--tags", repo], capture_output=True, text=True, check=True).stdout
    return [line.split("refs/tags/")[1] for line in out.splitlines() if "refs/tags/" in line and not line.endswith("^{}")]


def main() -> int:
    rows = []

    cur = pinned(r'nebius/nebius:\s*\{\s*version:\s*"([^"]+)"')
    latest = max((v["version"] for v in get_json("https://registry.terraform.io/v1/providers/nebius/nebius/versions")["versions"]), key=semver_key)
    rows.append(("terraform provider nebius/nebius", cur, latest))

    cur = pinned(r'vllm:\s*\{\s*version:\s*"([^"]+)"')
    latest = max((t for t in docker_hub_tags("vllm/vllm-openai", "v") if re.fullmatch(r"v\d+\.\d+\.\d+", t)), key=semver_key)
    rows.append(("vllm/vllm-openai", cur, latest))

    cur = pinned(r'soperator:\n\s*version:\s*"([^"]+)"')
    latest = max((t for t in ls_remote_tags("https://github.com/nebius/soperator.git") if re.fullmatch(r"\d+\.\d+\.\d+", t)), key=semver_key)
    rows.append(("nebius/soperator release", cur, latest))

    cur = pinned(r'nebius-solutions-library:\n\s*ref:\s*"[^"]+"\n\s*tag:\s*"([^"]+)"')
    latest = max((t for t in ls_remote_tags("https://github.com/nebius/nebius-solutions-library.git") if re.fullmatch(r"soperator-v\d+\.\d+\.\d+-\d+", t)), key=semver_key)
    rows.append(("nebius-solutions-library release tag", cur, latest))

    drift = [r for r in rows if r[1] != r[2]]
    print("| Component | Pinned | Upstream now | Drift |\n|---|---|---|---|")
    for name, c, l in rows:
        print(f"| {name} | `{c}` | `{l}` | {'yes' if c != l else 'no'} |")
    if drift:
        print(f"\n{len(drift)} component(s) drifted. Re-verify and update platform/versions.yaml, then `make compat-matrix`.")
        return 3
    print("\nAll pins match upstream.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
