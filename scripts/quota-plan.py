#!/usr/bin/env python3
"""Check project quota allowances against the tenant quota (read-only by default).

    scripts/quota-plan.py [--project <id>]... [--region <r>]... [--strict] [--json] [--allowances-file <json>]
    scripts/quota-plan.py --plan-align [--include-no-effect] [--quota <glob>]...
    CONFIRM=yes scripts/quota-plan.py --apply [--include-no-effect] [--quota <glob>]... [--rollback-file <path>]

Reads the tenant's and every listed project's quota allowances with the nebius CLI (`NEBIUS_PROFILE`
honoured; a read-only profile is enough) and reports, per region and project:
  (a) project caps above the tenant limit: no effect, the tenant limit always binds;
  (b) project caps below the tenant limit: they cap the project (intended?);
  (c) project caps of 0 where the tenant limit is above 0: nothing of that kind can be created there;
  (d) tenant limits of 0 for quotas the repository's stacks need in their region (docs/capacity.md,
      "Quotas per stack"): request them from Nebius, with a pre-filled justification line.

Data model (docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md, "Quota semantics"): a tenant
entry without `spec.limit` has a limit of 0 (proto3 JSON omits zeros); a project entry without
`metadata.id` and status is a placeholder that inherits the tenant quota and is never a cap; a project
entry with an id is a real cap (an absent limit there is 0).

--plan-align prints the `quota-allowance update` calls that would set the chosen caps, (b) and (c) by
default, to the tenant limit. --apply performs them (update only, never create or delete); it needs
CONFIRM=yes and writes a rollback JSON (previous limits) before the first update.

Projects: --project, else NEBIUS_PROJECT_IDS (comma-separated), else NEBIUS_PROJECT_ID. Tenant:
NEBIUS_TENANT_ID, else the first project's parent. Regions for (d): --region, else NEBIUS_REGION, else
the first region of platform/regions.yaml. Unset variables are read from the repository's .env
(NIP_DOTENV overrides the path), for the id and region variables only.
--allowances-file reads the allowances from a JSON file instead of the CLI (offline; scripts/preflight.py
--fixtures): {"tenant_id": ..., "allowances": {<tenant or project id>: [quota-allowance items]}}. Its
projects are every id but the tenant's; .env is not read. --plan-align and --apply refuse it.
--json prints the same report as one JSON object instead of text, for scripts/preflight.py: the parsed
tenant and project allowances (limit, usage, `usage_reported` when `status.usage` is present, unit), the
findings (b)-(c) and no-effect caps, and the tenant zeros (d), each with the report's line as `message`.
--plan-align and --apply refuse it.
Exit: 0 report printed (with --strict: 3 when (b), (c) or (d) were found); 2 a call failed or refused.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUEST_WHERE = "console → Administration → Limits → Change quota"
DOTENV_KEYS = ("NEBIUS_PROJECT_IDS", "NEBIUS_PROJECT_ID", "NEBIUS_TENANT_ID", "NEBIUS_REGION")
GIB = 1024**3
FIXTURE: dict | None = None  # --allowances-file

# What the stacks need from a region's tenant quota, from docs/capacity.md "Quotas per stack" (largest
# single-stage figure per quota) and the stack defaults. `{gpu}` is the region's default GPU platform
# quota (platform/regions.yaml `default`, e.g. gpu-h100-sxm -> compute.instance.gpu.h100).
STACK_NEEDS: list[tuple[str, str, str]] = [
    ("compute.instance.non-gpu.vcpu", "52 vCPU", "R1 inference and R3 training CPU nodes (16-24 vCPU per stage), R4 Soperator lab (52), R7 NAT and bastion (4-8)"),
    ("compute.instance.count", "6 VMs", "R4 Soperator lab (6 VMs), R7 network (2), R1/R10 GPU VMs"),
    ("{gpu}", "2 GPUs", "R1 inference GPU nodes on the region's default platform (prod: 2)"),
    ("compute.instance.preemptible.count", "1 VM", "R1 sandbox preemptible GPU node"),
    ("compute.disk.size.network-ssd", "1,433 GiB", "R1 inference prod boot disks and Prometheus volume; R4 lab 1,280 GiB"),
    ("compute.disk.size.network-ssd-io-m3", "280 GiB", "R4 Soperator controller spool (IO_M3)"),
    ("compute.filesystem.size.network-ssd", "448 GiB", "R4 lab jail, /data and spool; R1/R3/R8 shared filesystems"),
    ("mk8s.cluster.count", "3 clusters", "inference + training + Soperator in one stage"),
    ("compute.gpucluster.count", "1 GPU cluster", "R3 training with GPU nodes (InfiniBand)"),
    ("vpc.ipv4-address.public.count", "2 addresses", "R7 NAT and bastion; R4 login load balancer"),
    ("registry.count", "1 registry", "R12 ml-services"),
    ("storage.bucket.count", "2 buckets", "R8 data"),
]


def load_dotenv() -> None:
    path = Path(os.environ.get("NIP_DOTENV") or ROOT / ".env")
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        m = re.match(r"\s*(?:export\s+)?([A-Z_]+)=(.*)$", line)
        if m and m.group(1) in DOTENV_KEYS and not os.environ.get(m.group(1)):
            value = m.group(2).strip()
            value = value[1:-1] if value[:1] in "'\"" and value[-1:] == value[:1] else re.sub(r"\s+#.*$", "", value)
            os.environ[m.group(1)] = value


def nebius(*args: str) -> dict:
    cmd = ["nebius"]
    if os.environ.get("NIP_NEBIUS_CONFIG"):
        cmd += ["--config", os.environ["NIP_NEBIUS_CONFIG"]]
    if os.environ.get("NEBIUS_PROFILE"):
        cmd += ["--profile", os.environ["NEBIUS_PROFILE"]]
    cmd += [*args, "--format", "json"]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"nebius {' '.join(args)} failed: {(p.stderr or p.stdout).strip()[:300]}")
    return json.loads(p.stdout or "{}")


def list_allowances(parent: str) -> list[dict]:
    if FIXTURE is not None:
        if parent not in FIXTURE["allowances"]:
            raise RuntimeError(f"{parent} is not in the allowances file")
        return FIXTURE["allowances"][parent]
    return nebius("quotas", "quota-allowance", "list", "--parent-id", parent, "--all").get("items") or []


def get(d: dict | None, *keys: str):
    for k in keys:
        if d and d.get(k) not in (None, ""):
            return d[k]
    return None


def num(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def parse(item: dict, scope: str) -> dict:
    md, spec, st = item.get("metadata") or {}, item.get("spec") or {}, item.get("status") or {}
    real = bool(get(md, "id")) or bool(get(st, "state"))
    raw = num(get(spec, "limit"))
    return {
        "id": get(md, "id"), "name": get(md, "name") or "?", "region": get(spec, "region") or "",
        "scope": scope, "real": real if scope == "project" else True,
        # Tenant: an omitted limit is 0. Project: a real cap without a limit is 0; a placeholder has none.
        "limit": raw if raw is not None else (0 if scope == "tenant" or real else None),
        "usage": num(get(st, "usage")) or 0, "usage_reported": num(get(st, "usage")) is not None, "unit": get(st, "unit") or "", "description": get(st, "description") or "",
        "resource_version": get(md, "resource_version", "resourceVersion"),
    }


def amount(v: int | None, unit: str) -> str:
    if v is None:
        return "-"
    if unit.lower() in ("byte", "bytes") and v >= GIB:
        return f"{v / GIB / 1024:,.1f} TiB" if v >= 1024 * GIB else f"{v / GIB:,.0f} GiB"
    return str(v)


def classify(cap: dict, tenant: dict | None) -> str | None:
    if not cap["real"] or tenant is None:
        return None
    if cap["limit"] > tenant["limit"]:
        return "no-effect"
    if cap["limit"] == 0 and tenant["limit"] > 0:
        return "zero"
    if cap["limit"] < tenant["limit"]:
        return "below"
    return None


def finding_line(kind: str, cap: dict, tenant: dict) -> str:
    return f"{cap['name']}: project cap {amount(cap['limit'], cap['unit'])}, tenant {amount(tenant['limit'], tenant['unit'])} -> {VERDICT[kind]}"


def zero_line(region: str, quota: str) -> str:
    return f"{quota} {region}: tenant limit 0 -> request from Nebius ({REQUEST_WHERE})"


VERDICT = {
    "no-effect": "no effect (the tenant limit binds)",
    "below": "caps this project; intended?",
    "zero": "blocks this project (cap 0); intended?",
}


def default_regions() -> list[str]:
    if os.environ.get("NEBIUS_REGION"):
        return [os.environ["NEBIUS_REGION"]]
    m = re.search(r"^regions:\n  ([a-z0-9-]+):", (ROOT / "platform" / "regions.yaml").read_text(), re.M)
    return [m.group(1)] if m else ["eu-north1"]


def gpu_quota(region: str) -> str | None:
    text = (ROOT / "platform" / "regions.yaml").read_text()
    m = re.search(rf"^  {re.escape(region)}:\n(?:    .*\n)*?    default: ([a-z0-9-]+)", text, re.M)
    model = m.group(1).split("-")[1] if m and m.group(1).count("-") >= 1 else None
    return f"compute.instance.gpu.{model}" if model else None


def project_name(pid: str, cache: dict) -> str:
    if FIXTURE is not None:
        return pid
    if pid not in cache:
        try:
            md = nebius("iam", "project", "get", "--id", pid).get("metadata") or {}
            cache[pid] = md
        except RuntimeError:
            cache[pid] = {}
    return cache[pid].get("name") or pid


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", action="append", help="project id (repeatable); default NEBIUS_PROJECT_IDS")
    ap.add_argument("--region", action="append", help="region whose tenant zeros the stacks need are checked (repeatable)")
    ap.add_argument("--plan-align", action="store_true", help="print the updates that set the chosen caps to the tenant limit")
    ap.add_argument("--apply", action="store_true", help="perform the plan (CONFIRM=yes required; update only, never delete)")
    ap.add_argument("--include-no-effect", action="store_true", help="also align caps above the tenant limit")
    ap.add_argument("--quota", action="append", help="only quotas matching this glob (repeatable), e.g. 'vpc.*'")
    ap.add_argument("--rollback-file", help="where --apply writes the previous limits (default quota-rollback-<UTC>.json)")
    ap.add_argument("--strict", action="store_true", help="exit 3 when (b), (c) or (d) were found")
    ap.add_argument("--json", action="store_true", help="print the report as JSON (scripts/preflight.py)")
    ap.add_argument("--allowances-file", help="offline: read the allowances from this JSON file instead of the CLI")
    a = ap.parse_args()
    global FIXTURE
    if a.json and (a.plan_align or a.apply):
        print("refused: --json is the report only, not --plan-align or --apply", file=sys.stderr)
        return 2
    if a.allowances_file:
        if a.plan_align or a.apply:
            print("refused: --plan-align and --apply act on live allowances, not --allowances-file", file=sys.stderr)
            return 2
        FIXTURE = json.loads(Path(a.allowances_file).read_text())
        if not os.environ.get("NEBIUS_TENANT_ID"):
            os.environ["NEBIUS_TENANT_ID"] = FIXTURE.get("tenant_id") or ""
        if not a.project:
            a.project = [p for p in FIXTURE["allowances"] if p != os.environ["NEBIUS_TENANT_ID"]]

    if a.apply and os.environ.get("CONFIRM") != "yes":
        print("refused: --apply changes project quota allowances; set CONFIRM=yes after reviewing --plan-align", file=sys.stderr)
        return 2
    if FIXTURE is None:
        load_dotenv()
    projects = a.project or [p.strip() for p in (os.environ.get("NEBIUS_PROJECT_IDS") or os.environ.get("NEBIUS_PROJECT_ID") or "").split(",") if p.strip()]
    if not projects:
        print("no projects: set NEBIUS_PROJECT_IDS (or pass --project)", file=sys.stderr)
        return 2
    names: dict[str, dict] = {}
    try:
        tenant_id = os.environ.get("NEBIUS_TENANT_ID") or ""
        if not tenant_id:
            project_name(projects[0], names)
            tenant_id = get(names[projects[0]], "parent_id", "parentId") or ""
        if not tenant_id:
            print("no tenant: set NEBIUS_TENANT_ID (the first project's parent could not be read)", file=sys.stderr)
            return 2
        tenant = {(q["name"], q["region"]): q for q in (parse(i, "tenant") for i in list_allowances(tenant_id))}
        caps = {p: [parse(i, "project") for i in list_allowances(p)] for p in projects}
    except RuntimeError as e:
        print(f"could not read quota allowances: {e}", file=sys.stderr)
        return 2

    def chosen(name: str) -> bool:
        return not a.quota or any(fnmatch.fnmatch(name, g) for g in a.quota)

    findings = []  # (kind, project, cap, tenant)
    for p, rows in caps.items():
        for c in rows:
            kind = classify(c, tenant.get((c["name"], c["region"])))
            if kind:
                findings.append((kind, p, c, tenant[(c["name"], c["region"])]))
    regions = a.region or default_regions()
    zeros = []  # (region, quota, need, who, listed)
    for r in regions:
        for quota, need, who in STACK_NEEDS:
            q = gpu_quota(r) if quota == "{gpu}" else quota
            if not q:
                continue
            t = tenant.get((q, r))
            if t is None or t["limit"] == 0:
                zeros.append((r, q, need, who, t is not None))

    counts = {k: sum(1 for f in findings if f[0] == k) for k in VERDICT}
    strict_rc = 3 if a.strict and (counts["below"] or counts["zero"] or any(z[4] for z in zeros)) else 0
    if a.json:
        def row(q: dict) -> dict:
            return {k: q[k] for k in ("name", "region", "limit", "usage", "usage_reported", "unit", "real", "id")}
        print(json.dumps({
            "tenant_id": tenant_id, "projects": projects, "regions": regions,
            "tenant": [row(q) for q in tenant.values()],
            "caps": {p: [row(c) for c in rows] for p, rows in caps.items()},
            "findings": [{"kind": k, "project": p, "name": c["name"], "region": c["region"], "message": finding_line(k, c, t)} for k, p, c, t in findings],
            "zeros": [{"region": r, "quota": q, "need": need, "listed": listed, "message": zero_line(r, q) if listed else f"{q} {r}: not listed by the quota service (not checked)"}
                      for r, q, need, _, listed in zeros],
        }, indent=2))
        return strict_rc

    if a.plan_align or a.apply:
        kinds = {"below", "zero"} | ({"no-effect"} if a.include_no_effect else set())
        plan = [(p, c, t) for k, p, c, t in findings if k in kinds and chosen(c["name"]) and c["id"]]
        if not plan:
            print("Nothing to align: no chosen project cap differs from its tenant limit.")
            return 0
        print(f"Plan: {len(plan)} update(s) setting project caps to the tenant limit (no create, no delete)")
        for p, c, t in plan:
            print(f"  {project_name(p, names)}  {c['region']}  {c['name']}: {amount(c['limit'], c['unit'])} -> {amount(t['limit'], t['unit'])}")
            print(f"    nebius quotas quota-allowance update --id {c['id']} --limit {t['limit']} --patch")
        if not a.apply:
            print("\nRead-only: nothing changed. Apply with CONFIRM=yes scripts/quota-plan.py --apply (same selection flags).")
            return 0
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        rollback = Path(a.rollback_file or f"quota-rollback-{stamp}.json")
        rollback.write_text(json.dumps({
            "written_at": stamp, "tenant": tenant_id,
            "updates": [{"id": c["id"], "project": p, "name": c["name"], "region": c["region"], "previous_limit": c["limit"], "new_limit": t["limit"], "resource_version": c["resource_version"]} for p, c, t in plan],
        }, indent=2) + "\n")
        print(f"\nRollback written: {rollback} (restore with: quota-allowance update --id <id> --limit <previous_limit> --patch)")
        for p, c, t in plan:
            try:
                nebius("quotas", "quota-allowance", "update", "--id", c["id"], "--limit", str(t["limit"]), "--patch")
            except RuntimeError as e:
                print(f"FAILED {c['name']} ({c['region']}): {e}. Earlier updates stand; the rollback file lists them.", file=sys.stderr)
                return 2
            print(f"  updated {c['name']} ({c['region']}) -> {t['limit']}")
        return 0

    print(f"Quota allowance check: tenant and {len(projects)} project(s), profile {os.environ.get('NEBIUS_PROFILE') or 'default'} (read-only)\n")
    by_region: dict[str, list] = {}
    for f in findings:
        by_region.setdefault(f[2]["region"] or "(not regional)", []).append(f)
    if not findings:
        print("Project caps: every real project cap equals its tenant limit (placeholders use the tenant quota).")
    for r in sorted(by_region):
        print(f"== {r}")
        for p in projects:
            rows = [f for f in by_region[r] if f[1] == p]
            if not rows:
                continue
            print(f"  {project_name(p, names)}")
            for kind, _, c, t in sorted(rows, key=lambda f: (["zero", "below", "no-effect"].index(f[0]), f[2]["name"])):
                print(f"    {finding_line(kind, c, t)}")
    print(f"\nSummary: {counts['no-effect']} no effect, {counts['below']} below the tenant limit, {counts['zero']} at 0;"
          f" {sum(len([c for c in rows if not c['real']]) for rows in caps.values())} placeholder(s) use the tenant quota.")
    print(f"\nTenant limits of 0 the stacks need ({', '.join(regions)}; docs/capacity.md \"Quotas per stack\"):")
    if not any(z[4] for z in zeros):
        print("  none")
    for r, q, need, who, _ in [z for z in zeros if z[4]]:
        print(f"  {q}  {r}: tenant limit 0 -> request from Nebius ({REQUEST_WHERE})")
        print(f"    Justification: {q} in {r} for the platform stacks: need {need} ({who}); current tenant limit 0.")
    unlisted = [f"{q} ({r})" for r, q, _, _, listed in zeros if not listed]
    if unlisted:
        print(f"  Not listed by the quota service (not checked; the name may differ there): {', '.join(unlisted)}")
    if counts["below"] or counts["zero"]:
        print("\nAlign a cap to the tenant limit: scripts/quota-plan.py --plan-align (runbooks/capacity-request.md).")
    return strict_rc


if __name__ == "__main__":
    sys.exit(main())
