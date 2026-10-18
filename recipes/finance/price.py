#!/usr/bin/env python3
"""Price a footprint through the Nebius billing calculator, per hour, per run and per month.

  recipes/finance/price.py FOOTPRINT [--project ID] [--contract] [--advice --tenant ID]
                           [--currency usd] [--hours-per-month 730] [--json] [--dry-run]

FOOTPRINT is a JSON or YAML file (see recipes/finance/examples/). Each item is a VM group
(platform, preset, count, hours) or a disk / shared filesystem (disk_type or filesystem_type,
size_gib, count, hours). Every figure printed is what the API returned at that moment; when it
returns nothing for a line, the line says so and no number is filled in.

  * List price:       POST /billing/v1/calculator/estimate-batch (one spec per request).
  * Preemptible:      the same request with a preemptible spec; for GPU platforms on dynamic spot
                      pricing this is the current spot price, which can change every 15 minutes
                      (docs: signup-billing/pricing-policy, signup-billing/manage-pricing-policy).
  * Contract price:   --contract asks for OFFER_TYPE_CONTRACT_PRICE; needs
                      resource.billinggroup.get on the billing group (403 otherwise, reported).
  * Capacity advice:  --advice reads GET /capacity/v1/resource-advice for the tenant (viewer in
                      the tenant; docs: compute/virtual-machines/capacity-advisor).

The project fixes the region the calculator prices in; the script reads the project's region
(GET /iam/v2/projects/<id>) and refuses a footprint whose region differs.

Token: $NEBIUS_IAM_TOKEN, else `nebius iam get-access-token` (valid 12 h; docs:
iam/authorization/access-tokens). Requests carry an explicit User-Agent: the API answers 403
to some default client agents, Python's urllib among them.

Read-only toward Nebius: the calculator prices a would-be create request and creates nothing.
Stdlib only (PyYAML is used for YAML when installed; otherwise a small subset parser).
Not a quote: list and spot prices change, and reserved rates come from a commitment addendum.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

API = "https://api.nebius.cloud"
CALCULATOR = "/billing/v1/calculator/estimate-batch"
ADVICE = "/capacity/v1/resource-advice"
USER_AGENT = "nebius-infrastructure-patterns-finance/1.0 (+https://github.com/TylrDn/Nebius-Estate)"
CONTRACT_GRANT = "resource.billinggroup.get on the billing group"
HOURS_PER_MONTH = Decimal(730)  # the pricing unit of volumes is per GiB per 730 h (docs: compute/resources/pricing)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


# ---- footprint ----------------------------------------------------------------------------


def _scalar(text: str):
    t = text.strip()
    if t == "" or t in ("~", "null"):
        return None
    if t[0] in "\"'" and t[-1] == t[0]:
        return t[1:-1]
    if t in ("true", "false"):
        return t == "true"
    if t.startswith("[") and t.endswith("]"):
        return [_scalar(x) for x in t[1:-1].split(",") if x.strip()]
    for kind in (int, float):
        try:
            return kind(t)
        except ValueError:
            pass
    return t


def _strip_comment(line: str) -> str:
    quote = None
    for i, ch in enumerate(line):
        if ch in "\"'":
            quote = None if quote == ch else (quote or ch)
        elif ch == "#" and quote is None and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def parse_yaml_subset(text: str) -> dict:
    """Top-level scalars, one level of nested mapping, and lists of flat mappings. Nothing else."""
    root: dict = {}
    key = None
    item: dict | None = None
    for n, raw in enumerate(text.splitlines(), 1):
        line = _strip_comment(raw).rstrip()
        if not line.strip() or line.strip() == "---":
            continue
        indent = len(line) - len(line.lstrip(" "))
        body = line.strip()
        if indent == 0:
            k, sep, v = body.partition(":")
            if not sep:
                raise ValueError(f"line {n}: expected 'key: value'")
            key, item = k.strip(), None
            root[key] = _scalar(v) if v.strip() else None
            continue
        if key is None:
            raise ValueError(f"line {n}: indented line before any key")
        if body.startswith("- "):
            if root[key] is None:
                root[key] = []
            if not isinstance(root[key], list):
                raise ValueError(f"line {n}: list item under a mapping")
            item = {}
            root[key].append(item)
            body = body[2:].strip()
            if not body:
                continue
        k, sep, v = body.partition(":")
        if not sep:
            raise ValueError(f"line {n}: expected 'key: value'")
        if item is not None and isinstance(root[key], list):
            item[k.strip()] = _scalar(v)
        else:
            if root[key] is None:
                root[key] = {}
            if not isinstance(root[key], dict):
                raise ValueError(f"line {n}: mapping entry under a list")
            root[key][k.strip()] = _scalar(v)
    return root


def load_footprint(path: Path) -> dict:
    text = path.read_text()
    if path.suffix == ".json":
        return json.loads(text)
    try:
        import yaml  # type: ignore[import-not-found]
    except ImportError:
        return parse_yaml_subset(text)
    return yaml.safe_load(text)


def dec(value, field: str, where: str) -> Decimal:
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise SystemExit(f"{where}: {field} must be a number, got {value!r}")
    if d < 0:
        raise SystemExit(f"{where}: {field} must not be negative")
    return d


def validate(fp: dict) -> list[dict]:
    if not isinstance(fp, dict) or not isinstance(fp.get("items"), list) or not fp["items"]:
        raise SystemExit("footprint needs a non-empty 'items' list")
    items = []
    for i, it in enumerate(fp["items"]):
        where = f"items[{i}] ({it.get('name', 'unnamed')})"
        kinds = [k for k in ("platform", "disk_type", "filesystem_type") if it.get(k)]
        if len(kinds) != 1:
            raise SystemExit(f"{where}: set exactly one of platform (+ preset), disk_type or filesystem_type")
        line = {
            "name": str(it.get("name") or kinds[0]),
            "kind": {"platform": "vm", "disk_type": "disk", "filesystem_type": "filesystem"}[kinds[0]],
            "count": dec(it.get("count", 1), "count", where),
            "hours": dec(it.get("hours", fp.get("hours", 1)), "hours", where),
            "region": it.get("region") or fp.get("region"),
        }
        if line["kind"] == "vm":
            if not it.get("preset"):
                raise SystemExit(f"{where}: a VM item needs preset")
            line.update(platform=str(it["platform"]), preset=str(it["preset"]))
            pre = it.get("preemptible", "compare" if line["platform"].startswith("gpu-") else False)
            if pre not in (True, False, "compare"):
                raise SystemExit(f"{where}: preemptible must be true, false or compare")
            line["preemptible"] = pre
        else:
            line.update(type=str(it[kinds[0]]), size_gib=dec(it.get("size_gib"), "size_gib", where))
        if not line["region"]:
            raise SystemExit(f"{where}: no region (set it on the item or at the top of the file)")
        items.append(line)
    return items


# ---- requests -----------------------------------------------------------------------------


def spec_for(line: dict, project: str, preemptible: bool) -> dict:
    """A create request packed as google.protobuf.Any, the shape the calculator prices."""
    meta = {"parentId": project, "name": "estimate"}
    if line["kind"] == "vm":
        spec: dict = {"resources": {"platform": line["platform"], "preset": line["preset"]}, "bootDisk": {"attachMode": "READ_WRITE"}}
        if preemptible:
            spec["preemptible"] = {"onPreemption": "STOP"}
        return {"@type": "type.googleapis.com/nebius.compute.v1.CreateInstanceRequest", "metadata": meta, "spec": spec}
    size = str(int(line["size_gib"].to_integral_value(rounding="ROUND_CEILING")))
    kind = "CreateDiskRequest" if line["kind"] == "disk" else "CreateFilesystemRequest"
    return {"@type": f"type.googleapis.com/nebius.compute.v1.{kind}", "metadata": meta, "spec": {"type": line["type"], "sizeGibibytes": size}}


class Client:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/"), token

    def call(self, method: str, path: str, body: dict | None = None, query: dict | None = None) -> dict:
        url = self.base + path + (("?" + urllib.parse.urlencode(query)) if query else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                msg = json.loads(text).get("message") or text
            except ValueError:
                msg = text
            raise ApiError(e.code, str(msg)[:200]) from None
        except urllib.error.URLError as e:
            raise ApiError(0, str(e.reason)) from None


def pick(obj, *names):
    """REST answers in camelCase; accept snake_case too."""
    for n in names:
        if isinstance(obj, dict) and n in obj:
            return obj[n]
    return None


def hourly_from(resp: dict) -> tuple[Decimal | None, str]:
    costs = pick(resp, "resourceCosts", "resource_costs") or []
    if not costs:
        return None, "no cost returned"
    cost = costs[0]
    unit = pick(cost, "aggregationUnit", "aggregation_unit") or {}
    unit_type, unit_name = pick(unit, "unitType", "unit_type"), pick(unit, "unit")
    total = pick(pick(cost, "general") or {}, "total") or pick(pick(cost, "fixedInstance", "fixed_instance") or {}, "perInstance", "per_instance") or {}
    amount = pick(total, "cost")
    if unit_type != "UNIT_TYPE_TIME_BASED" or unit_name != "hour":
        return None, f"priced per {unit_name or 'usage'}, not per hour"
    try:
        return Decimal(str(amount)), "hour"
    except (InvalidOperation, ValueError):
        return None, "no cost returned"


def estimate(client: Client, spec: dict, currency: str, contract: bool) -> tuple[Decimal | None, str]:
    body = {"currency": currency, "resourceSpecs": [{"spec": spec}]}
    if contract:
        body["offerTypes"] = ["OFFER_TYPE_CONTRACT_PRICE"]
    return hourly_from(client.call("POST", CALCULATOR, body))


def wanted(line: dict, preemptible: bool, contract: bool) -> bool:
    """Which offers a line is priced at: preemptible only for VMs that ask for it; a VM pinned to
    preemptible: true has no on-demand or contract row."""
    if line["kind"] != "vm":
        return not preemptible
    if preemptible:
        return line["preemptible"] in (True, "compare")
    return line["preemptible"] is not True


def get_token() -> str:
    token = os.environ.get("NEBIUS_IAM_TOKEN", "").strip()
    if token:
        return token
    try:
        out = subprocess.run(["nebius", "iam", "get-access-token"], check=True, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        raise SystemExit("nebius CLI not found: install it or set NEBIUS_IAM_TOKEN")
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"nebius iam get-access-token failed: {e.stderr.strip()[:200]}")
    return out.stdout.strip()


def project_region(client: Client, project: str) -> str | None:
    try:
        p = client.call("GET", f"/iam/v2/projects/{project}")
    except ApiError as e:
        print(f"warning: could not read the region of {project} ({e}); prices are for that project's region", file=sys.stderr)
        return None
    return pick(p.get("metadata", {}), "region") or pick(p.get("spec", {}), "region")


def advice(client: Client, tenant: str, items: list[dict]) -> list[dict]:
    wanted = {(i["region"], i["platform"], i["preset"]) for i in items if i["kind"] == "vm"}
    rows, token = [], None
    for _ in range(50):
        q = {"parentId": tenant, "pageSize": 200, **({"pageToken": token} if token else {})}
        page = client.call("GET", ADVICE, query=q)
        for it in page.get("items", []):
            spec, status = it.get("spec", {}), it.get("status", {})
            ci = pick(spec, "computeInstance", "compute_instance") or {}
            key = (spec.get("region"), ci.get("platform"), (ci.get("preset") or {}).get("name"))
            if key not in wanted:
                continue
            row = {"region": key[0], "fabric": spec.get("fabric"), "platform": key[1], "preset": key[2]}
            for label, names in (("on_demand", ("onDemand", "on_demand")), ("preemptible", ("preemptible",)), ("reserved", ("reserved",))):
                a = pick(status, *names)
                row[label] = None if a is None else {
                    "level": str(pick(a, "availabilityLevel", "availability_level") or "").replace("AVAILABILITY_LEVEL_", "") or None,
                    "available": pick(a, "available"),  # absent stays absent: never read as 0
                    "limit": pick(a, "limit"),
                    "data_state": str(pick(a, "dataState", "data_state") or "").replace("DATA_STATE_", "") or None,
                    "effective_at": pick(a, "effectiveAt", "effective_at"),
                }
            rows.append(row)
        token = page.get("nextPageToken") or page.get("next_page_token")
        if not token:
            break
    return rows


# ---- output -------------------------------------------------------------------------------


def money(d: Decimal | None, places: str = "0.01") -> str:
    return "-" if d is None else f"{d.quantize(Decimal(places))}"


# A scenario prices every line at its own offer, falling back where the line cannot take it:
# a preemptible scenario still pays CPU nodes and disks at on-demand, and a line pinned to
# preemptible stays preemptible in every scenario.
SCENARIO_ORDER = {"on-demand": ("on-demand", "preemptible"), "preemptible": ("preemptible", "on-demand"), "contract": ("contract", "preemptible")}


def scenarios(items: list[dict], prices: dict[str, dict[str, Decimal]], offers: list[str], hours_per_month: Decimal) -> dict:
    out = {}
    for offer in offers:
        t = {"hourly": Decimal(0), "per_run": Decimal(0), "per_month": Decimal(0), "unpriced": []}
        for line in items:
            got = next((prices[line["name"]][o] for o in SCENARIO_ORDER[offer] if o in prices[line["name"]]), None)
            if got is None:
                t["unpriced"].append(line["name"])
                continue
            t["hourly"] += got
            t["per_run"] += got * line["hours"]
            t["per_month"] += got * hours_per_month
        out[offer] = t
    return out


def positive_hours(text: str) -> Decimal:
    try:
        d = Decimal(text)
    except InvalidOperation:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}")
    if d <= 0:
        raise argparse.ArgumentTypeError("must be above 0")
    return d


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("footprint", type=Path)
    ap.add_argument("--project", help="project to price in (default: footprint project_id / projects[region], then $NEBIUS_PROJECT_ID)")
    ap.add_argument("--contract", action="store_true", help=f"also ask for contract prices (needs {CONTRACT_GRANT})")
    ap.add_argument("--advice", action="store_true", help="also read the capacity advisor for the footprint's platforms (tenant viewer)")
    ap.add_argument("--tenant", default=os.environ.get("NEBIUS_TENANT_ID"), help="tenant ID for --advice (default $NEBIUS_TENANT_ID)")
    ap.add_argument("--currency", default="usd")
    ap.add_argument("--hours-per-month", type=positive_hours, default=HOURS_PER_MONTH)
    ap.add_argument("--api-base", default=os.environ.get("NEBIUS_API_BASE", API))
    ap.add_argument("--json", action="store_true", help="print the result as JSON")
    ap.add_argument("--dry-run", action="store_true", help="print the requests; call nothing")
    args = ap.parse_args()

    fp = load_footprint(args.footprint)
    items = validate(fp)
    projects = dict(fp.get("projects") or {})

    def project_for(region: str) -> str:
        p = args.project or projects.get(region) or fp.get("project_id") or os.environ.get("NEBIUS_PROJECT_ID")
        if not p or not str(p).startswith("project-"):
            raise SystemExit(f"no project for region {region}: pass --project, set projects.{region} or NEBIUS_PROJECT_ID")
        return str(p)

    offers = [("on-demand", False, False)]
    if any(i["kind"] == "vm" and i["preemptible"] in (True, "compare") for i in items):
        offers.append(("preemptible", True, False))
    if args.contract:
        offers.append(("contract", False, True))

    if args.dry_run:
        for line in items:
            for offer, pre, contract in offers:
                if not wanted(line, pre, contract):
                    continue
                body = {"currency": args.currency, "resourceSpecs": [{"spec": spec_for(line, project_for(line["region"]), pre)}]}
                if contract:
                    body["offerTypes"] = ["OFFER_TYPE_CONTRACT_PRICE"]
                print(f"# {line['name']} [{offer}] POST {args.api_base}{CALCULATOR}")
                print(json.dumps(body, indent=1))
        return 0

    client = Client(args.api_base, get_token())
    asof = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    checked: dict[str, str | None] = {}
    for region in sorted({i["region"] for i in items}):
        project = project_for(region)
        if project not in checked:
            checked[project] = project_region(client, project)
        if checked[project] and checked[project] != region:
            raise SystemExit(f"{project} is in {checked[project]}, the footprint says {region}: the calculator prices in the project's region")

    if len({i["name"] for i in items}) != len(items):
        raise SystemExit("item names must be unique")
    rows, notes = [], []
    prices: dict[str, dict[str, Decimal]] = {i["name"]: {} for i in items}
    contract_refused = False
    for line in items:
        project = project_for(line["region"])
        for offer, pre, contract in offers:
            if not wanted(line, pre, contract) or (contract and contract_refused):
                continue
            try:
                unit, why = estimate(client, spec_for(line, project, pre), args.currency, contract)
            except ApiError as e:
                if contract and e.status == 403:
                    contract_refused = True
                    notes.append(f"contract prices not permitted for this identity (needs {CONTRACT_GRANT}); list prices only")
                    continue
                if e.status in (401, 403) and not contract:
                    raise SystemExit(f"calculator refused the request ({e}); check the token and the project grant")
                unit, why = None, f"not priced ({e})"
            hourly = None if unit is None else unit * line["count"]
            row = {
                "item": line["name"], "region": line["region"], "offer": offer, "count": str(line["count"]), "hours": str(line["hours"]),
                "what": f"{line['platform']} {line['preset']}" if line["kind"] == "vm" else f"{line['kind']} {line['type']} {line['size_gib']} GiB",
                "unit_hourly": None if unit is None else str(unit),
                "hourly": None if hourly is None else str(hourly),
                "per_run": None if hourly is None else str(hourly * line["hours"]),
                "per_month": None if hourly is None else str(hourly * args.hours_per_month),
                "note": None if unit is not None else why,
            }
            rows.append(row)
            if hourly is not None:
                prices[line["name"]][offer] = hourly

    priced_offers = [o for o, _, c in offers if not (c and contract_refused)]
    totals = scenarios(items, prices, priced_offers, args.hours_per_month)

    adv = advice(client, args.tenant, items) if args.advice and args.tenant else []
    if args.advice and not args.tenant:
        notes.append("--advice needs --tenant or NEBIUS_TENANT_ID; capacity advice not read")

    result = {
        "footprint": fp.get("name", args.footprint.name), "as_of": asof, "currency": args.currency.upper(),
        "source": f"{args.api_base}{CALCULATOR}", "hours_per_month": str(args.hours_per_month),
        "rows": rows, "scenarios": {k: {kk: (vv if kk == "unpriced" else str(vv)) for kk, vv in v.items()} for k, v in totals.items()},
        "capacity_advice": adv, "notes": notes,
        "disclaimer": "Prices the API returned at as_of. Not a quote; preemptible is the spot price at that moment and can change every 15 minutes.",
    }
    if args.json:
        print(json.dumps(result, indent=1))
        return 0

    print(f"{result['footprint']}: Nebius billing calculator, {asof}, {result['currency']} (not a quote)")
    print(f"{'item':<18} {'offer':<12} {'what':<38} {'count':>5} {'per hour':>11} {'per run':>12} {'per month':>12}  note")
    for r in rows:
        print(f"{r['item'][:18]:<18} {r['offer']:<12} {r['what'][:38]:<38} {r['count']:>5} "
              f"{money(None if r['hourly'] is None else Decimal(r['hourly']), '0.0001'):>11} "
              f"{money(None if r['per_run'] is None else Decimal(r['per_run'])):>12} "
              f"{money(None if r['per_month'] is None else Decimal(r['per_month'])):>12}  {r['note'] or ''}")
    for offer, t in totals.items():
        missing = f"unpriced: {', '.join(t['unpriced'])}" if t["unpriced"] else ""
        print(f"{'SCENARIO':<18} {offer:<12} {'whole footprint':<38} {'':>5} {money(t['hourly'], '0.0001'):>11} {money(t['per_run']):>12} {money(t['per_month']):>12}  {missing}")
    od, pre, con = (totals.get(k, {}).get("hourly") for k in ("on-demand", "preemptible", "contract"))
    if od and pre is not None and not totals["preemptible"]["unpriced"] and not totals["on-demand"]["unpriced"]:
        print(f"preemptible / on-demand per hour: {money(pre / od * 100, '0.1')} % (spot at this moment; interruptions add rework hours)")
    if od and con is not None and not totals["contract"]["unpriced"] and not totals["on-demand"]["unpriced"]:
        print(f"reserved break-even utilisation: contract / on-demand = {money(con / od * 100, '0.1')} % of the committed hours (commitments are paid used or not)")
    for r in adv:
        cells = []
        for k in ("on_demand", "preemptible", "reserved"):
            a = r[k]
            cells.append(f"{k}=" + ("-" if a is None else f"{a['level'] or '?'} {a['available'] if a['available'] is not None else '?'}/{a['limit'] if a['limit'] is not None else '?'}"))
        print(f"advice {r['region']} {r['fabric']} {r['platform']} {r['preset']}: " + "  ".join(cells))
    for n in notes:
        print(f"note: {n}")
    print("per month = per hour x", args.hours_per_month, "h; per run = per hour x the item's hours. A scenario with unpriced lines is a lower bound.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
