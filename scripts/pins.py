#!/usr/bin/env python3
"""One source of truth for versions: platform/versions.yaml.

  scripts/pins.py check        fail when a workflow, script, manifest or the toolbox drifts from versions.yaml
  scripts/pins.py build-args   print the --build-arg flags `make toolbox` passes to docker build

Rules enforced by `check`:
  1. Every container image referenced in manifests, scripts, workflows and runbooks equals an
     image `value` in versions.yaml (tag *and* digest). Unknown images fail.
  2. The only third-party GitHub Action is actions/checkout, pinned to the commit in versions.yaml.
  3. Upstream refs in scripts (Soperator recipe tag, Training Operator version) match versions.yaml.
  4. The toolbox Dockerfile declares tool versions only as ARGs without defaults (values come from here).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from versions import ROOT, load

SCAN = [
    "workloads/**/*.yaml",
    "tests/**/*.yaml",
    "tests/**/*.sh",
    "recipes/**/*.yaml",
    "recipes/**/*.sh",
    "runbooks/**/*.yaml",
    "scripts/*.sh",
    "scripts/live/*.sh",
    "scripts/live/bin/*",
    ".github/**/*.yml",
    "portal/packages/*/Dockerfile",
]
IMAGE_LINE = re.compile(r"""(?:^FROM\s+|^\s*(?:-\s*)?image:\s*|^\s*image_id:\s*docker:|--image[= ]|\bvalue:\s*)["']?(?P<ref>[\w][\w./-]*:[\w.-]+(?:@sha256:[0-9a-f]{64})?)""")
DEFAULT_IMG = re.compile(r"""\$\{[A-Z_]+:-(?P<refs>[^}]+)\}""")
USES = re.compile(r"^\s*-?\s*uses:\s*(?P<ref>\S+)(?:\s*#\s*(?P<comment>.*))?$")


def images(v: dict[str, dict[str, str]]) -> set[str]:
    """Every pinned image: versions.yaml values carrying a digest."""
    return {f["value"] for f in v.values() if "@sha256:" in f.get("value", "")}


def check() -> list[str]:
    v = load()
    known = images(v)
    repos = {ref.split("@")[0].rsplit(":", 1)[0] for ref in known}
    errors: list[str] = []
    for pattern in SCAN:
        for path in sorted(ROOT.glob(pattern)):
            rel = path.relative_to(ROOT)
            for n, line in enumerate(path.read_text().splitlines(), 1):
                if line.lstrip().startswith("#"):
                    continue
                refs = [m.group("ref") for m in IMAGE_LINE.finditer(line)]
                for d in DEFAULT_IMG.finditer(line):
                    refs += [r for r in d.group("refs").split() if ":" in r]
                for ref in refs:
                    image_context = "image" in line or "IMAGE" in line or " in ${" in line
                    if not image_context and ref.split("@")[0].rsplit(":", 1)[0] not in repos:
                        continue  # a kustomize `value:` that is not an image
                    if ref not in known:
                        errors.append(f"{rel}:{n}: image {ref} is not pinned in platform/versions.yaml (tag + digest)")
                m = USES.match(line)
                if m and not m.group("ref").startswith("./"):
                    want = f"actions/checkout@{v['tooling/actions-checkout']['value']}"
                    if m.group("ref") != want:
                        errors.append(f"{rel}:{n}: action {m.group('ref')} — only {want} is allowed")
                    elif (m.group("comment") or "").strip() != f"v{v['tooling/actions-checkout']['version']}":
                        errors.append(f"{rel}:{n}: action comment must read v{v['tooling/actions-checkout']['version']}")

    tag = v["upstream/soperator"]["solution_library_tag"]
    if f'TAG="${{SOPERATOR_RECIPE_TAG:-{tag}}}"' not in (ROOT / "scripts/fetch-soperator.sh").read_text():
        errors.append(f"scripts/fetch-soperator.sh: default tag must be {tag}")
    ref = v["upstream/nebius-solutions-library"]["ref"]
    if f'COMMIT="${{SOPERATOR_RECIPE_COMMIT:-{ref}}}"' not in (ROOT / "scripts/fetch-soperator.sh").read_text():
        errors.append(f"scripts/fetch-soperator.sh: default commit must be {ref} (upstream.nebius-solutions-library.ref)")
    op = v["workloads/kubeflow-training-operator"]["version"]
    op_ref = v["workloads/kubeflow-training-operator"].get("ref", "")
    installer = (ROOT / "workloads/training/install-training-operator.sh").read_text()
    if f'VERSION="${{TRAINING_OPERATOR_VERSION:-{op}}}"' not in installer:
        errors.append(f"workloads/training/install-training-operator.sh: Training Operator version must be {op}")
    if not re.fullmatch(r"[0-9a-f]{40}", op_ref) or f'COMMIT="${{TRAINING_OPERATOR_COMMIT:-{op_ref}}}"' not in installer:
        errors.append("workloads/training/install-training-operator.sh: Training Operator commit must equal workloads.kubeflow-training-operator.ref (a 40-character sha)")

    dockerfile = ROOT / "tools/toolbox/Dockerfile"
    for n, line in enumerate(dockerfile.read_text().splitlines(), 1):
        if re.match(r"^ARG\s+\w+=", line):
            errors.append(f"tools/toolbox/Dockerfile:{n}: ARG with a default; versions come from `scripts/pins.py build-args`")
    return errors


def build_args() -> str:
    v = load()
    args = [f"--build-arg BASE_IMAGE={v['tooling/toolbox-base']['value']}"]
    for key, fields in v.items():
        if not key.startswith("tooling/") or "sha256" not in fields:
            continue
        name = key.split("/", 1)[1].upper().replace("-", "_")
        args += [f"--build-arg {name}_VERSION={fields['version']}", f"--build-arg {name}_SHA256={fields['sha256']}"]
    return " ".join(args)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "build-args":
        print(build_args())
    elif cmd == "check":
        errs = check()
        for e in errs:
            print(e, file=sys.stderr)
        print(f"pins: {len(errs)} problem(s)" if errs else "pins: every reference matches platform/versions.yaml")
        sys.exit(1 if errs else 0)
    else:
        sys.exit(__doc__)
