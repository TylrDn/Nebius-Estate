#!/usr/bin/env python3
"""Render a committed run profile into the tfvars a live root is planned with (make plan PROFILE=...).

    scripts/run-profile.py --stage <stage> --stack <stack> --profile <name> [--run <nip-run>]
                           [--ttl-hours <1-24>] [--now <YYYY-MM-DDTHH:MM:SSZ>] [--out <file>]
    scripts/run-profile.py --list

A profile is platform/profiles/<stack>/<name>.json: the stages it is for, the region it was proven in,
its default TTL, the evidence runs it reproduces, and `vars`, the root's inputs. The output is those
inputs plus `labels`: TF_VAR_labels (kept, because a -var-file replaces it), then nip-run (--run, else
<profile>-<UTC yyyymmddhhmm>) and, where the stage requires one (platform/stages.yaml
require_ttl_label), nip-ttl-expires = now + TTL in UTC. Values that belong to the operator (an
allowlist, an SSH key) stay in the environment; a profile names them in `requires_env`.

Refused: an unknown profile, a stage the profile is not for, a TTL outside 1-24 h (the pipeline's
range), and a profile region that differs from NEBIUS_REGION / TF_VAR_region. Offline; stdlib only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILES = ROOT / "platform" / "profiles"
UTC_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def stage_block(stage: str) -> str:
    """The text of one stage under `stages:` in platform/stages.yaml (no YAML library in the toolbox)."""
    text = (ROOT / "platform" / "stages.yaml").read_text()
    m = re.search(rf"^  {re.escape(stage)}:\n((?:    .*\n|\s*\n)*)", text, re.M)
    if not m:
        raise SystemExit(f"no stage {stage} in platform/stages.yaml")
    return m.group(1)


def stage_policy(stage: str) -> dict:
    """Scalar policy values (true/false/numbers) and the max_gpu_nodes map of a stage."""
    block, out = stage_block(stage), {}
    for k, v in re.findall(r"^      ([a-z_]+): ([^{#\n]+?)\s*(?:#.*)?$", block, re.M):
        out[k] = {"true": True, "false": False}.get(v, int(v) if v.isdigit() else v)
    m = re.search(r"^      max_gpu_nodes: \{([^}]*)\}", block, re.M)
    out["max_gpu_nodes"] = {k: int(v) for k, v in re.findall(r"([a-z0-9-]+): (\d+)", m.group(1))} if m else {}
    return out


def utc(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, UTC_FORMAT).replace(tzinfo=dt.timezone.utc)


def load(stack: str, name: str) -> dict:
    path = PROFILES / stack / f"{name}.json"
    if not path.is_file():
        have = sorted(p.stem for p in (PROFILES / stack).glob("*.json"))
        raise SystemExit(f"no profile {name} for stack {stack} (have: {', '.join(have) or 'none'}; platform/profiles/{stack}/)")
    return json.loads(path.read_text())


def render(stage: str, stack: str, name: str, run: str | None, ttl_hours: int | None, now: dt.datetime) -> dict:
    p = load(stack, name)
    if stage not in p["stages"]:
        raise SystemExit(f"profile {name} is for stages {', '.join(p['stages'])}, not {stage}")
    for var in ("NEBIUS_REGION", "TF_VAR_region"):
        if os.environ.get(var) and p.get("region") and os.environ[var] != p["region"]:
            raise SystemExit(f"profile {name} needs region {p['region']}, but {var} is {os.environ[var]}: bootstrap a stage bound to {p['region']}")
    ttl = ttl_hours if ttl_hours is not None else p.get("ttl_hours", 3)
    if not 1 <= ttl <= 24:
        raise SystemExit(f"--ttl-hours must be 1-24 (got {ttl})")
    for var in p.get("requires_env", []):
        if not os.environ.get(var):
            print(f"note: profile {name} expects {var} in the environment (the operator's own value)", file=sys.stderr)
    labels = {"nip-owner": "platform"}
    if os.environ.get("TF_VAR_labels"):
        labels.update(json.loads(os.environ["TF_VAR_labels"]))
    labels["nip-run"] = run or f"{name}-{now.strftime('%Y%m%d%H%M')}"
    if stage_policy(stage).get("require_ttl_label"):
        labels["nip-ttl-expires"] = (now + dt.timedelta(hours=ttl)).strftime(UTC_FORMAT)
    return {**p["vars"], "labels": labels}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage")
    ap.add_argument("--stack")
    ap.add_argument("--profile")
    ap.add_argument("--run", help="nip-run label (default <profile>-<UTC yyyymmddhhmm>)")
    ap.add_argument("--ttl-hours", type=int, help="hours until nip-ttl-expires (default: the profile's)")
    ap.add_argument("--now", help="UTC time the TTL counts from (default: now)")
    ap.add_argument("--out", help="write the tfvars JSON here instead of stdout")
    ap.add_argument("--list", action="store_true", help="list the committed profiles")
    a = ap.parse_args()
    if a.list:
        for f in sorted(PROFILES.glob("*/*.json")):
            p = json.loads(f.read_text())
            print(f"{f.parent.name:<12} {f.stem:<20} {','.join(p['stages']):<10} {p.get('region', '-'):<10} {p['description']}")
        return 0
    if not (a.stage and a.stack and a.profile):
        ap.error("--stage, --stack and --profile are required")
    now = utc(a.now) if a.now else dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    out = json.dumps(render(a.stage, a.stack, a.profile, a.run, a.ttl_hours, now), indent=2, sort_keys=True)
    if a.out:
        Path(a.out).write_text(out + "\n")
        labels = json.loads(out)["labels"]
        print(f"Rendered profile {a.profile} -> {a.out}: nip-run={labels['nip-run']}"
              + (f", nip-ttl-expires={labels['nip-ttl-expires']} (UTC)" if "nip-ttl-expires" in labels else ""))
    else:
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
