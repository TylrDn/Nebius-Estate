#!/usr/bin/env python3
"""One go/no-go for a live root before `make plan` (make preflight).

    scripts/preflight.py --stage <stage> --stack <stack> [--profile <name>] [--set name=value]...
                         [--offline | --fixtures <dir>]

Checks, in order, each printed as PASS, WARN, FAIL or SKIP:
  keys             scripts/env-status.sh (--live unless offline): .env private, the portal keys, and the
                   CI key expiries in platform/ci-keys.yaml (warning 14 days ahead, FAIL once expired)
  region-platform  the region and GPU platform are a pair in platform/regions.yaml
  spot-cap         a spot price cap (gpu_spot_pricing_policy_id, R9 spot_price_caps) only on a pair marked
                   spot_price_cap: true (the pricing-policy API refuses the others)
  stage-caps       GPU nodes within max_gpu_nodes and preemptible only where the stage allows it
  ttl              where the stage requires it: nip-run, and nip-ttl-expires in the future and at most
                   7 days ahead (modules/stage-policy); --stack soperator warns instead: the upstream recipe
                   sets no labels, so its safety net is make ttl-teardown STACK=soperator TTL=<UTC>,
                   which make soperator-apply requires to be running (scripts/ttl-armed.sh)
  quota            this plan's demand per quota (demand() below: GPUs by model, preemptible VMs, non-GPU
                   vCPU, VMs, Network SSD disk and filesystem bytes, MK8s and GPU clusters, public
                   addresses, buckets) against the effective limit in the region, min(tenant limit, the
                   target project's real cap), less the usage the allowance reports (status.usage; when
                   absent, compared with the limit). FAIL only when demand exceeds it; every other
                   finding of scripts/quota-plan.py (caps below the tenant, tenant zeros for quotas this
                   plan does not need) and every quota it cannot derive or that the service does not
                   list ("not checked") is a warning. The allowances come from quota-plan.py --json;
                   make quota-check keeps the tenant-wide --strict audit
  capacity         the capacity advice for the GPU shape and offer (on-demand or preemptible):
                   LIMIT_REACHED, or fewer available than the nodes asked for, refuses; no advice, or
                   none for the offer, warns; skipped when the stack asks for 0 GPU nodes

Inputs are resolved as Terraform does for this root: variable defaults, then TF_VAR_* (below the auto
files), then <stage>.auto.tfvars, then the run profile (rendered as make plan PROFILE= does), then --set
(like -var). Region: NEBIUS_REGION, else TF_VAR_region, else the profile's.

--offline makes no cloud call: keys without --live; quota and capacity are skipped and the summary says
so. --fixtures <dir> is offline too, reading <dir>/quota-allowances.json (quota-plan.py --allowances-file)
and <dir>/resource-advice.json (a GET /capacity/v1/resource-advice page). Live, the advice is read with
NEBIUS_TENANT_ID and an IAM token (recipes/finance/price.py's client; a tenant-level read role).
Read-only. Exit 0 GO (warnings allowed), 1 NO-GO, 2 usage.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


profiles = load_module("run_profile", ROOT / "scripts" / "run-profile.py")

# Variable names of the GPU shape per stack; gpu-vm is one VM.
GPU_VARS = {
    "inference": ("gpu_platform", "gpu_preset", "gpu_node_count", "gpu_preemptible", "gpu_spot_pricing_policy_id"),
    "training": ("gpu_platform", "gpu_preset", "gpu_node_count", "gpu_preemptible", "gpu_spot_pricing_policy_id"),
    "gpu-vm": ("platform", "preset", None, "preemptible", "spot_pricing_policy_id"),
}
TTL_MAX = dt.timedelta(days=7)


def value(text: str):
    """A tfvars or TF_VAR_ value: JSON when it parses (numbers, bools, maps, quoted strings), else the string."""
    text = re.sub(r"\s+#.*$", "", text.strip()) if not text.strip().startswith('"') else text.strip()
    if text in ("", "null"):  # "" is a multi-line default (a map): not read here
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def inputs(stage: str, stack: str, root: Path, profile: str | None, sets: list[str], now: dt.datetime) -> dict:
    out: dict = {}
    for name, default in re.findall(r'^variable "([a-z0-9_]+)" \{(?:\n(?!\}).*)*?\n  default\s*=\s*([^\n{]+)', (root / "variables.tf").read_text(), re.M):
        out[name] = value(default)
    for k, v in os.environ.items():
        if k.startswith("TF_VAR_"):
            out[k[7:]] = value(v)
    auto = root / f"{stage}.auto.tfvars"
    if auto.is_file():
        for name, raw in re.findall(r'^([a-z0-9_]+)\s*=\s*("[^"]*"|true|false|-?\d+|null)', auto.read_text(), re.M):
            out[name] = value(raw)
    if profile:
        out.update(profiles.render(stage, stack, profile, None, None, now))
    for s in sets:
        name, _, raw = s.partition("=")
        out[name] = value(raw)
    return out


def regions() -> dict:
    """platform/regions.yaml: region -> {default, platforms: {name: {single_gpu_preset, ib_preset, spot_price_cap}}}."""
    text = (ROOT / "platform" / "regions.yaml").read_text()
    out = {}
    for m in re.finditer(r"^  ([a-z0-9-]+):\n((?:    .*\n)+)", text.split("\nkubernetes_versions")[0], re.M):
        block = m.group(2)
        d = re.search(r"^    default: (\S+)", block, re.M)
        plats = {}
        for name, body in re.findall(r"^      ([a-z0-9-]+):\s*\{(.*)\}", block, re.M):
            g = lambda k: (re.search(rf'{k}: "([^"]+)"', body) or [None, None])[1]  # noqa: E731
            plats[name] = {"single_gpu_preset": g("single_gpu_preset"), "ib_preset": g("ib_preset"), "fabric": g("fabric"),
                           "spot_price_cap": bool(re.search(r"spot_price_cap: true", body))}
        out[m.group(1)] = {"default": d.group(1) if d else None, "platforms": plats}
    return out


class Report:
    def __init__(self):
        self.rows: list[tuple[str, str, str]] = []

    def add(self, status: str, check: str, msg: str) -> None:
        self.rows.append((status, check, msg))
        print(f"  {status:<4} {check}: {msg}")

    def has(self, status: str) -> bool:
        return any(r[0] == status for r in self.rows)


def check_keys(r: Report, offline: bool) -> None:
    cmd = [str(ROOT / "scripts" / "env-status.sh")] + ([] if offline else ["--live"])
    p = subprocess.run(cmd, capture_output=True, text=True)
    bad = [line.strip().lstrip("!").strip() for line in p.stdout.splitlines() if line.startswith("  !")]
    bad += [line.strip() for line in p.stdout.splitlines() if line.startswith("WARNING")]
    if p.returncode != 0:
        r.add("FAIL", "keys", "; ".join(bad) or (p.stderr.strip() or f"env-status exited {p.returncode}"))
    elif bad:
        r.add("WARN", "keys", "; ".join(bad))
    else:
        r.add("PASS", "keys", "env-status: nothing expired or near expiry" + ("" if not offline else " (offline: no live key checks)"))


def gpu_shape(stack: str, v: dict, region: str, table: dict) -> dict | None:
    names = GPU_VARS.get(stack)
    if not names:
        return None
    plat = v.get(names[0]) or (table.get(region) or {}).get("default")
    info = ((table.get(region) or {}).get("platforms") or {}).get(plat) or {}
    # training's nodes are 8-GPU (GPU-cluster) presets; the other stacks default to the 1-GPU preset.
    default = info.get("ib_preset") if stack == "training" else info.get("single_gpu_preset")
    return {"platform": plat, "preset": v.get(names[1]) or default,
            "count": 1 if names[2] is None else int(v.get(names[2]) or 0),
            "preemptible": bool(v.get(names[3])), "spot_policy": v.get(names[4])}


GIB = 1024**3
COUNT, BYTES = "count", "bytes"
REQUEST = "request from Nebius (runbooks/capacity-request.md)"


def first_int(pattern: str, text) -> int | None:
    m = re.match(pattern, str(text or ""))
    return int(m.group(1)) if m else None


def demand(stack: str, v: dict, shape: dict | None, region: str, table: dict) -> tuple[dict, list[str]]:
    """This plan's need per quota name: ({quota: (amount, COUNT|BYTES, why)}, [not derivable]).

    Quota names come from scripts/quota-plan.py STACK_NEEDS and docs/capacity.md "Quotas per stack";
    the arithmetic is the stacks': node boot disks (CPU nodes 128 GiB, GPU gpu_boot_disk_size_gib),
    the 25 GiB Prometheus volume with enable_o11y, the shared filesystem unless an existing one is
    attached, one MK8s cluster, a GPU cluster only for training with GPU nodes, a fabric and
    enable_gpu_cluster. Zero needs are left out (they can never refuse). A stack without a model here
    returns nothing and says so.
    """
    need: dict = {}
    unknown: list[str] = []

    def add(q: str, n: int, kind: str, why: str) -> None:
        if n > 0:
            old = need.get(q)
            need[q] = (n + (old[0] if old else 0), kind, f"{old[2]} + {why}" if old else why)

    def vcpu(preset, what: str, n: int) -> None:
        c = first_int(r"^(\d+)vcpu-", preset)
        if n and c is None:
            unknown.append(f"compute.instance.non-gpu.vcpu ({what} preset {preset}: no vCPU count)")
        elif n:
            add("compute.instance.non-gpu.vcpu", n * c, COUNT, f"{n} {what} x {c}")

    def gpus(nodes: int) -> None:
        if not nodes:
            return
        model = (shape["platform"] or "").split("-")[1] if (shape["platform"] or "").count("-") >= 1 else None
        per = first_int(r"^(\d+)gpu-", shape["preset"])
        if not model or per is None:
            unknown.append(f"GPU quota ({shape['platform']} {shape['preset']}: model or GPUs per node unknown)")
        else:
            add(f"compute.instance.gpu.{model}", nodes * per, COUNT, f"{nodes} node(s) x {per} GPU")
        if shape["preemptible"]:
            add("compute.instance.preemptible.count", nodes, COUNT, f"{nodes} preemptible GPU VM(s)")

    if stack in ("inference", "training"):
        cpu = int(v.get("cpu_node_count") or 0)
        auto = v.get("gpu_autoscaling") if stack == "inference" else None
        nodes = int((auto or {}).get("max") or 0) if isinstance(auto, dict) else int(v.get("gpu_node_count") or 0)
        nodes += 1 if nodes and v.get("gpu_rollout_surge") else 0  # the surge node needs quota (variables.tf)
        vcpu(v.get("cpu_preset"), "CPU node(s)", cpu)
        gpus(nodes)
        add("compute.instance.count", cpu + nodes, COUNT, f"{cpu} CPU + {nodes} GPU node(s)")
        boot = first_int(r"^(\d+)$", v.get("gpu_boot_disk_size_gib"))
        if nodes and boot is None:
            unknown.append("compute.disk.size.network-ssd (gpu_boot_disk_size_gib unknown)")
        else:
            add("compute.disk.size.network-ssd", (cpu * 128 + nodes * (boot or 0) + (25 if v.get("enable_o11y") else 0)) * GIB, BYTES,
                f"{cpu} x 128 + {nodes} x {boot or 0}" + (" + 25 (Prometheus)" if v.get("enable_o11y") else "") + " GiB")
        if v.get("enable_filestore") and not v.get("existing_filesystem_id"):
            add("compute.filesystem.size.network-ssd", int(v.get("filestore_size_gib") or 0) * GIB, BYTES, "filestore_size_gib")
        add("mk8s.cluster.count", 1, COUNT, f"the {stack} cluster")
        if stack == "training" and nodes and v.get("enable_gpu_cluster"):
            info = ((table.get(region) or {}).get("platforms") or {}).get(shape["platform"]) or {}
            if v.get("infiniband_fabric") or info.get("fabric"):
                add("compute.gpucluster.count", 1, COUNT, "the InfiniBand GPU cluster")
    elif stack == "gpu-vm":
        gpus(1)
        add("compute.instance.count", 1, COUNT, "the GPU VM")
        add("compute.disk.size.network-ssd", int(v.get("boot_disk_size_gib") or 0) * GIB, BYTES, "boot_disk_size_gib")
        add("vpc.ipv4-address.public.count", 1 if v.get("public_ip") else 0, COUNT, "public_ip")
    elif stack == "network":
        vms = (1 if v.get("enable_nat") else 0) + (1 if v.get("enable_bastion") else 0)
        vcpu(v.get("vm_preset"), "NAT/bastion VM(s)", vms)
        add("compute.instance.count", vms, COUNT, "NAT and bastion VMs")
        add("compute.disk.size.network-ssd", vms * 50 * GIB, BYTES, f"{vms} x 50 GiB boot disk")
        add("vpc.ipv4-address.public.count", vms, COUNT, "NAT and bastion addresses")
    elif stack == "data":
        fs = bool(v.get("enable_filesystem"))
        if fs:
            add("compute.filesystem.size.network-ssd", int(v.get("filesystem_size_gib") or 0) * GIB, BYTES, "filesystem_size_gib")
        add("storage.bucket.count", 2 + (1 if fs and v.get("filesystem_bucket") else 0), COUNT, "datasets, checkpoints (+ filesystem bucket)")
    else:
        unknown.append(f"{stack} has no demand model in scripts/preflight.py (docs/capacity.md \"Quotas per stack\")")
    return need, unknown


def show(n: int, kind: str) -> str:
    return f"{n / GIB:,.0f} GiB" if kind == BYTES else str(n)


def check_quota(r: Report, report: dict, need: dict, unknown: list[str], region: str, project: str | None) -> None:
    """FAIL a quota only when this plan's demand exceeds what is left of its effective limit."""
    tenant = {(q["name"], q["region"]): q for q in report["tenant"]}
    caps = report["caps"]
    if project not in caps:
        if len(caps) == 1:
            project = next(iter(caps))
        else:
            unknown.append(f"project caps (target project unknown among {len(caps)}: set TF_VAR_parent_id)")
            project = None
    pcaps = {(c["name"], c["region"]): c for c in caps.get(project, []) if c["real"]} if project else {}
    fails, fits = [], []
    for q, (n, kind, why) in sorted(need.items()):
        t = tenant.get((q, region)) or tenant.get((q, ""))
        if t is None:
            unknown.append(f"{q} ({region}: not listed by the quota service)")
            continue
        if kind == BYTES and t["unit"].lower() not in ("byte", "bytes"):
            unknown.append(f"{q} (unit {t['unit'] or 'not reported'}, not bytes)")
            continue
        c = pcaps.get((q, region)) or pcaps.get((q, ""))
        tfree = t["limit"] - t["usage"] if t["usage_reported"] else t["limit"]
        cfree = None if c is None else (c["limit"] - c["usage"] if c["usage_reported"] else c["limit"])
        free = max(0, tfree if cfree is None else min(tfree, cfree))
        limit = t["limit"] if c is None else min(t["limit"], c["limit"])
        src = f"tenant {show(t['limit'], kind)}" if c is None else f"project cap {show(c['limit'], kind)}, tenant {show(t['limit'], kind)}"
        used = [f"{w} {show(x['usage'], kind)} of {show(x['limit'], kind)} in use"
                for w, x in (("tenant", t), ("project", c)) if x and x["usage_reported"] and x["usage"]]
        if used:
            have = f"{show(free, kind)} free ({'; '.join(used)})"
        else:
            have = f"limit {show(limit, kind)} ({src})" + ("" if t["usage_reported"] else ", usage not reported")
        if n > free:
            fix = REQUEST if n > max(0, tfree) else f"align the project cap: scripts/quota-plan.py --plan-align --quota {q}, or lower the plan"
            fails.append(f"{q} {region}: this plan needs {show(n, kind)} ({why}), {have} -> {fix}")
        else:
            fits.append(f"{q} {show(n, kind)} of {show(free, kind)}" + (" (project cap)" if cfree is not None and cfree < tfree else ""))
    failed = {f.split(" ", 1)[0] for f in fails}
    if fails:
        r.add("FAIL", "quota", "; ".join(fails))
    elif need:
        r.add("PASS", "quota", f"this plan fits in {region}: " + "; ".join(fits))
    else:
        r.add("PASS", "quota", f"this plan needs no quota scripts/preflight.py models in {region}")
    other = [f["message"] for f in report["findings"] if f["kind"] != "no-effect" and (f["project"] == project or project is None)
             and f["name"] not in failed]
    other += [z["message"] for z in report["zeros"] if z["listed"] and z["quota"] not in failed]
    if other:
        r.add("WARN", "quota", "quota-plan.py (not needed by this plan, or within its limit): " + "; ".join(other))
    if unknown:
        r.add("WARN", "quota", "not checked: " + "; ".join(unknown))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", required=True)
    ap.add_argument("--stack", required=True)
    ap.add_argument("--profile", help="a committed run profile (platform/profiles/<stack>/<name>.json)")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE", help="an input as -var would set it (what-if)")
    ap.add_argument("--offline", action="store_true", help="no cloud calls; quota and capacity are skipped")
    ap.add_argument("--fixtures", help="offline, with quota-allowances.json and resource-advice.json from this directory")
    a = ap.parse_args()
    offline = a.offline or bool(a.fixtures)
    root = ROOT / "terraform" / "live" / a.stage / a.stack
    # Soperator wraps the upstream recipe: its stage directory holds stage.tfvars, no variables.tf.
    soperator = a.stack == "soperator"
    if not (root / ("stage.tfvars" if soperator else "variables.tf")).is_file():
        print(f"No such live root {root.relative_to(ROOT)}", file=sys.stderr)
        return 2
    now = dt.datetime.fromtimestamp(int(os.environ["NIP_NOW"]), dt.timezone.utc) if os.environ.get("NIP_NOW") \
        else dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    print(f"Preflight {a.stage}/{a.stack}" + (f" profile {a.profile}" if a.profile else "") + (" (offline)" if offline else ""))
    r = Report()

    check_keys(r, offline)
    try:
        v = {} if soperator and not a.profile else inputs(a.stage, a.stack, root, a.profile, a.set, now)
    except SystemExit as e:  # run-profile refusals
        r.add("FAIL", "profile", str(e))
        print(f"Preflight {a.stage}/{a.stack}: NO-GO")
        return 1
    policy = profiles.stage_policy(a.stage)
    table = regions()
    region = os.environ.get("NEBIUS_REGION") or os.environ.get("TF_VAR_region") or (
        profiles.load(a.stack, a.profile).get("region") if a.profile else None)
    shape = gpu_shape(a.stack, v, region or "", table)

    # region-platform
    if not region:
        r.add("FAIL", "region-platform", "no region: export NEBIUS_REGION (scripts/bootstrap-backend.sh sets TF_VAR_region)")
    elif region not in table:
        r.add("FAIL", "region-platform", f"region {region} is not in platform/regions.yaml ({', '.join(table)})")
    elif shape is None:
        r.add("PASS", "region-platform", f"{region}; {a.stack} has no GPU shape")
    elif shape["platform"] not in table[region]["platforms"]:
        r.add("FAIL", "region-platform", f"{shape['platform']} is not offered in {region} (platform/regions.yaml: {', '.join(table[region]['platforms'])})")
    else:
        info = table[region]["platforms"][shape["platform"]]
        known = {info["single_gpu_preset"], info["ib_preset"]} - {None}
        if shape["preset"] in known:
            r.add("PASS", "region-platform", f"{shape['platform']} / {shape['preset']} in {region}")
        else:
            r.add("WARN", "region-platform", f"preset {shape['preset']} is not in platform/regions.yaml for {shape['platform']} ({', '.join(sorted(known))}): unknown whether {region} offers it")

    # spot-cap
    plats = table.get(region or "", {}).get("platforms", {})
    capped = list((v.get("spot_price_caps") or {}).keys()) if a.stack == "governance" else (
        [shape["platform"]] if shape and shape["spot_policy"] else [])
    refused = [p for p in capped if not plats.get(p, {}).get("spot_price_cap")]
    if refused:
        ok = [p for p, i in plats.items() if i["spot_price_cap"]]
        r.add("FAIL", "spot-cap", "; ".join(f"no spot price cap for {p} in {region}" for p in refused)
              + f" (platform/regions.yaml spot_price_cap; accepted here: {', '.join(ok) or 'none'})")
    elif capped:
        r.add("PASS", "spot-cap", "; ".join(f"{p} in {region} accepts a spot price cap" for p in capped))
    else:
        r.add("PASS", "spot-cap", "no spot price cap requested" + (" (preemptible nodes follow the spot price)" if shape and shape["preemptible"] else ""))

    # stage-caps
    if shape:
        cap = policy["max_gpu_nodes"].get(a.stack, 0)
        problems = []
        if shape["count"] > cap:
            problems.append(f"gpu_node_count {shape['count']} exceeds the {a.stage} cap of {cap} for {a.stack} (platform/stages.yaml max_gpu_nodes)")
        if shape["preemptible"] and not policy.get("allow_preemptible_serving"):
            problems.append(f"{a.stage} does not allow preemptible GPU nodes (platform/stages.yaml allow_preemptible_serving)")
        if problems:
            r.add("FAIL", "stage-caps", "; ".join(problems))
        else:
            r.add("PASS", "stage-caps", f"{shape['count']} GPU node(s), cap {cap}" + (", preemptible allowed" if shape["preemptible"] else ""))
    else:
        r.add("PASS", "stage-caps", f"{a.stack} has no GPU nodes")

    # ttl
    labels = v.get("labels") or {}
    if not policy.get("require_ttl_label"):
        r.add("PASS", "ttl", f"{a.stage} needs no TTL")
    elif soperator:
        r.add("WARN", "ttl", f"{a.stage} needs a TTL, but the Soperator recipe sets no labels: "
              f"make ttl-teardown STAGE={a.stage} STACK=soperator TTL=<YYYY-MM-DDTHH:MM:SSZ> CONFIRM=yes "
              f"before make soperator-apply (it refuses until that job is running)")
    elif not labels.get("nip-run") or not labels.get("nip-ttl-expires"):
        r.add("FAIL", "ttl", f"{a.stage} needs nip-run and nip-ttl-expires: use PROFILE=<name>, or set them in TF_VAR_labels (docs/cost.md)")
    else:
        exp = labels["nip-ttl-expires"]
        try:
            at = profiles.utc(exp)
        except ValueError:
            at = None
        if at is None:
            r.add("FAIL", "ttl", f"nip-ttl-expires {exp} is not YYYY-MM-DDTHH:MM:SSZ")
        elif at <= now:
            r.add("FAIL", "ttl", f"nip-ttl-expires {exp} is not in the future")
        elif at - now > TTL_MAX:
            r.add("FAIL", "ttl", f"nip-ttl-expires {exp} is more than 7 days ahead (modules/stage-policy)")
        else:
            r.add("PASS", "ttl", f"nip-run {labels['nip-run']}, expires {exp} (in {(at - now) // dt.timedelta(minutes=1)} min)")

    # quota
    if a.offline and not a.fixtures:
        r.add("SKIP", "quota", "offline (run make preflight without OFFLINE, or make quota-check)")
    else:
        project = v.get("parent_id") or os.environ.get("NEBIUS_PROJECT_ID")
        cmd = [sys.executable, str(ROOT / "scripts" / "quota-plan.py"), "--json"] + (["--region", region] if region else [])
        if a.fixtures:
            cmd += ["--allowances-file", str(Path(a.fixtures) / "quota-allowances.json")]
        elif project:
            cmd += ["--project", project]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0 or not region:
            r.add("FAIL", "quota", "quota-plan.py could not read the allowances: " + (p.stderr.strip() or p.stdout.strip() or "no region")[:300])
        else:
            need, unknown = demand(a.stack, v, shape, region, table)
            check_quota(r, json.loads(p.stdout), need, unknown, region, project)

    # capacity
    if a.offline and not a.fixtures:
        r.add("SKIP", "capacity", "offline")
    elif not shape or not region:
        r.add("PASS", "capacity", "no GPU shape to check")
    elif shape["count"] == 0:
        r.add("SKIP", "capacity", "no GPU nodes requested (gpu count 0)")
    else:
        price = load_module("price", ROOT / "recipes" / "finance" / "price.py")
        want = [{"kind": "vm", "region": region, "platform": shape["platform"], "preset": shape["preset"]}]
        rows = None
        if a.fixtures:
            page = json.loads((Path(a.fixtures) / "resource-advice.json").read_text())

            class FileClient:
                def call(self, *_args, **_kw):
                    return page
            rows = price.advice(FileClient(), "fixture", want)
        elif not os.environ.get("NEBIUS_TENANT_ID"):
            r.add("WARN", "capacity", "NEBIUS_TENANT_ID is not set: capacity advice not read")
        else:
            try:
                rows = price.advice(price.Client(price.API, price.get_token()), os.environ["NEBIUS_TENANT_ID"], want)
            except (price.ApiError, SystemExit) as e:
                r.add("WARN", "capacity", f"capacity advice not readable ({e}; it needs a tenant-level read role)")
        if rows is not None:
            offer = "preemptible" if shape["preemptible"] else "on_demand"
            what = f"{shape['platform']} {shape['preset']} {offer.replace('_', '-')}"

            def fits(row) -> bool:
                adv = row.get(offer) or {}
                return adv.get("level") not in ("LIMIT_REACHED", None) and (adv.get("available") is None or int(adv["available"]) >= shape["count"])
            if not rows:
                r.add("WARN", "capacity", f"no advice for {shape['platform']} {shape['preset']} in {region}: availability unknown")
            elif not any(row.get(offer) for row in rows):
                # The advice exists but carries no figure for this offer: unknown, not unavailable.
                r.add("WARN", "capacity", f"no {offer.replace('_', '-')} advice for {shape['platform']} {shape['preset']} in {region}: availability unknown")
            else:
                best = next((row for row in rows if fits(row)), rows[0])
                adv = best.get(offer) or {}
                cell = f"{adv.get('level') or '?'} {adv.get('available', '?') if adv.get('available') is not None else '?'}/{adv.get('limit') if adv.get('limit') is not None else '?'}"
                if fits(best):
                    r.add("PASS", "capacity", f"{what} {cell}" + (f" (fabric {best['fabric']})" if best.get("fabric") else "") + " (a tenant view at this moment, not a guarantee)")
                else:
                    r.add("FAIL", "capacity", f"{what} in {region}: {cell} for {shape['count']} node(s); pick another offer, platform or region, or wait")

    verdict = "NO-GO" if r.has("FAIL") else "GO"
    skipped = [c for s, c, m in r.rows if s == "SKIP" and m.startswith("offline")]
    note = f" (offline: {' and '.join(skipped)} not checked)" if skipped else ""
    warns = sum(1 for s, _, _ in r.rows if s == "WARN")
    print(f"Preflight {a.stage}/{a.stack}: {verdict}{note}" + (f", {warns} warning(s)" if warns else ""))
    return 1 if verdict == "NO-GO" else 0


if __name__ == "__main__":
    sys.exit(main())
