#!/usr/bin/env python3
"""Turn a tests/load/sweep.sh log into one result JSON, judged against pass bars.

    python3 tests/load/bench.py parse <sweep.log> --target r1|r6|r10|r11 [options]

The same parser serves every target, so R1 (in-cluster Job), R6 (serverless endpoint), R10 (GPU VM)
and R11 (Token Factory) results have one shape (tests/load/README.md, "Result"). A point is
reported for every concurrency the sweep header lists (params.concurrency), with null figures when
the point produced no result block or never started (a sweep that stopped early); a log without
the `=== nip-bench end` marker is incomplete and fails. Nothing is filled in. Stdlib only.

Cold start: the sweep's own first request is NOT cold (04-workload's chat completion, R6's measure
probe and vllm bench serve's own test request may come before it), so it is reported as
`first_sweep_request_ms`. The cold first request comes from the step that sent it
(--first-request-ms, --first-request-source); without one it is null.

Pass bars (per point; the run passes only when every point does). Each is a flag or an
environment variable; the defaults and their sources are in tests/load/README.md:
    --max-ttft-p99-ms   BAR_MAX_TTFT_P99_MS     default none
    --max-tpot-p99-ms   BAR_MAX_TPOT_P99_MS     default none
    --max-e2e-p99-ms    BAR_MAX_E2E_P99_MS      default 10000 (docs/slo.md, applied at p99)
    --min-output-tps    BAR_MIN_OUTPUT_TPS      default none
    --min-success-ratio BAR_MIN_SUCCESS_RATIO   default 1.0 (every request answered)

Cost per 1M output tokens (docs/evidence/costs.md, "Cost per output token"):
    --usd-per-hour      BENCH_USD_PER_HOUR      the node or endpoint rate on the day (no default)
    --utilisation       BENCH_UTILISATION       share of the hour the GPU is this busy (default 1.0)
    --usd-per-1m-output BENCH_USD_PER_1M_OUTPUT per-token price (R11), used as is
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

SCHEMA = "nip-bench/1"
MARKER = re.compile(r"^=== nip-bench (\w+)(.*)$")
KV = re.compile(r"(\w+)=(\S+)")
DEFAULT_E2E_P99_MS = 10000.0
COST_FORMULA = "docs/evidence/costs.md#cost-per-output-token-a-method-not-a-result: usd_per_hour / (output_tokens_per_s x 3600 x utilisation) x 1e6"


def env_float(name: str, default: float | None) -> float | None:
    v = os.environ.get(name, "")
    return float(v) if v.strip() else default


def num(v: str) -> float | int:
    f = float(v)
    return int(f) if f.is_integer() and "." not in v else f


def metric(block: list[str], label: str) -> float | None:
    """Value of a `vllm bench serve` result line such as 'P99 TTFT (ms):   210.55'."""
    pat = re.compile(r"^" + re.escape(label) + r"\s*(?:\([^)]*\))?:\s+([0-9]+(?:\.[0-9]+)?)\s*$")
    for line in block:
        m = pat.match(line.strip())
        if m:
            return num(m.group(1))
    return None


def pct(block: list[str], name: str) -> dict:
    p50 = metric(block, f"P50 {name}")
    if p50 is None:
        p50 = metric(block, f"Median {name}")
    return {"p50": p50, "p99": metric(block, f"P99 {name}")}


def split(lines: list[str]) -> tuple[dict, list[dict]]:
    """Header params and one section per marker (phase, its key=value fields, its lines)."""
    params: dict = {}
    sections: list[dict] = []
    ended = False
    for line in lines:
        m = MARKER.match(line.rstrip("\n"))
        if m:
            kv = dict(KV.findall(m.group(2)))
            if m.group(1) == "params":
                params = kv
            elif m.group(1) == "error":
                for s in reversed(sections):
                    if s["phase"] == kv.get("phase") and s["kv"].get("concurrency") == kv.get("concurrency"):
                        s["error"] = f"rc={kv.get('rc', '?')}"
                        break
            elif m.group(1) == "end":
                ended = True
            else:
                sections.append({"phase": m.group(1), "kv": kv, "lines": [], "error": None})
            continue
        if sections:
            sections[-1]["lines"].append(line.rstrip("\n"))
    params["_ended"] = ended
    return params, sections


def point(sec: dict, bars: dict, cost: dict) -> dict:
    b = sec["lines"]
    c = int(sec["kv"].get("concurrency", 0))
    prompts = int(sec["kv"].get("prompts", 0))
    ok = metric(b, "Successful requests")
    p = {
        "concurrency": c,
        "prompts": prompts,
        "successful_requests": ok,
        "failed_requests": (prompts - ok) if ok is not None else None,
        "requests_per_s": metric(b, "Request throughput"),
        "output_tokens_per_s": metric(b, "Output token throughput"),
        "ttft_ms": pct(b, "TTFT"),
        "tpot_ms": pct(b, "TPOT"),
        "e2e_ms": pct(b, "E2EL"),
    }
    p["cost_per_1m_output_tokens_usd"] = price(p["output_tokens_per_s"], cost)
    fails = []
    if sec.get("missing"):
        fails.append("point not in the log: the sweep stopped before it")
    elif ok is None:
        fails.append(f"no result block{' (' + sec['error'] + ')' if sec['error'] else ''}")
    else:
        ratio = ok / prompts if prompts else 0.0
        if ratio < bars["min_success_ratio"]:
            fails.append(f"success ratio {ratio:.3f} < {bars['min_success_ratio']}")
        for key, field in (("max_ttft_p99_ms", "ttft_ms"), ("max_tpot_p99_ms", "tpot_ms"), ("max_e2e_p99_ms", "e2e_ms")):
            v = p[field]["p99"]
            if bars[key] is not None and (v is None or v > bars[key]):
                fails.append(f"{field}.p99 {v} > {bars[key]}")
        mn = bars["min_output_tokens_per_s"]
        if mn is not None and (p["output_tokens_per_s"] is None or p["output_tokens_per_s"] < mn):
            fails.append(f"output_tokens_per_s {p['output_tokens_per_s']} < {mn}")
    p["pass"] = not fails
    p["failures"] = fails
    return p


def price(otps: float | None, cost: dict) -> float | None:
    if cost["usd_per_1m_output_tokens_list"] is not None:
        return cost["usd_per_1m_output_tokens_list"]
    if cost["usd_per_hour"] is None or not otps:
        return None
    return round(cost["usd_per_hour"] / (otps * 3600 * cost["utilisation"]) * 1e6, 4)


def parse(a: argparse.Namespace) -> dict:
    with open(a.log, encoding="utf-8", errors="replace") as f:
        params, sections = split(f.readlines())
    bars = {
        "max_ttft_p99_ms": a.max_ttft_p99_ms,
        "max_tpot_p99_ms": a.max_tpot_p99_ms,
        "max_e2e_p99_ms": a.max_e2e_p99_ms,
        "min_output_tokens_per_s": a.min_output_tps,
        "min_success_ratio": a.min_success_ratio,
        "source": "tests/load/README.md (Pass bars): e2e p99 from docs/slo.md (p95 <= 10 s, applied at p99); "
                  "every request answered; the others unset until a client or a first baseline sets them",
    }
    for k, v in list(bars.items()):
        if isinstance(v, float) and v.is_integer():
            bars[k] = int(v)
    has_price = a.usd_per_1m_output is not None
    # R11 bills per token: an hourly rate never applies to it, priced or not.
    per_token = has_price or a.target == "r11"
    if has_price or (not per_token and a.usd_per_hour is not None):
        note = None
    elif per_token:
        note = ("no price given: set BENCH_USD_PER_1M_OUTPUT (or --usd-per-1m-output) to the model's listed "
                "output price from recipes/token-factory/list-models.sh --verbose")
    else:
        note = "no rate given: set BENCH_USD_PER_HOUR (or --usd-per-hour) from the console or calculator on the day (docs/cost.md)"
    cost = {
        "model": "per-token" if per_token else "per-hour",
        "usd_per_hour": a.usd_per_hour,
        "utilisation": a.utilisation,
        "usd_per_1m_output_tokens_list": a.usd_per_1m_output,
        "formula": "listed per-token price (R11: list-models.sh --verbose; the API states no unit)" if per_token else COST_FORMULA,
        "note": note,
    }
    ended = params.pop("_ended", False)
    conc = params.get("concurrency")
    expected = [int(c) for c in conc.split(",") if c] if conc else []
    seen = [s for s in sections if s["phase"] == "point"]
    seen_c = {int(s["kv"].get("concurrency", 0)) for s in seen}
    # Every expected point is reported: one that never started is a failing point, not a gap.
    for c in expected:
        if c not in seen_c:
            seen.append({"phase": "point", "kv": {"concurrency": str(c), "prompts": params.get("num_prompts", "0")},
                         "lines": [], "error": None, "missing": True})
    order = {c: i for i, c in enumerate(expected)}
    seen.sort(key=lambda s: order.get(int(s["kv"].get("concurrency", 0)), len(order)))
    points = [point(s, bars, cost) for s in seen]
    # "first" (legacy logs: "cold") is the sweep's first request, after whatever ran before it.
    first_req = next((s for s in sections if s["phase"] in ("first", "cold")), None)
    first_sweep_ms = pct(first_req["lines"], "E2EL")["p50"] if first_req else None
    first = points[0] if points else None
    passing = [p["concurrency"] for p in points if p["pass"]]
    # Capacity at the bar: the highest swept level N such that every swept level <= N passed (null
    # when the lowest level failed). A failure at a low level with passes above it (a tail outlier on
    # a shared endpoint) is read through the next two fields instead.
    max_ok = None
    for p in points:
        if not p["pass"]:
            break
        max_ok = p["concurrency"]
    # The highest level that passed, whatever happened below it; and every level that did not pass.
    highest_ok = max(passing) if passing else None
    failed_levels = [p["concurrency"] for p in points if not p["pass"]]
    status = "pass" if ended and points and len(passing) == len(points) else "fail"
    return {
        "schema": SCHEMA,
        "target": a.target,
        "vantage": a.vantage,
        "status": status,
        "base_url": params.get("base_url"),
        "endpoint": params.get("endpoint"),
        "model": params.get("model"),
        # null: vllm bench serve used the model's own tokenizer; a repo: --tokenizer stood in (counts approximate)
        "tokenizer": params.get("tokenizer"),
        "image": a.image,
        "params": {
            "input_len": int(params["input_len"]) if "input_len" in params else None,
            "output_len": int(params["output_len"]) if "output_len" in params else None,
            "num_prompts": int(params["num_prompts"]) if "num_prompts" in params else None,
            "warmup_prompts": int(params["warmup_prompts"]) if "warmup_prompts" in params else None,
            "concurrency": expected or [p["concurrency"] for p in points],
        },
        "placement": json.loads(a.placement) if a.placement else None,
        "sweep_complete": ended,
        "cold_start": {"server_startup_s": a.server_startup_s, "first_request_ms": a.first_request_ms,
                       "first_request_source": a.first_request_source if a.first_request_ms is not None else None},
        "first_sweep_request_ms": first_sweep_ms,
        "warm": {
            "concurrency": first["concurrency"] if first else None,
            "first_point_e2e_p50_ms": first["e2e_ms"]["p50"] if first else None,
        },
        "bars": bars,
        "cost": cost,
        "points": points,
        "max_passing_concurrency": max_ok,
        "highest_passing_concurrency": highest_ok,
        "failed_levels": failed_levels,
        "method": "tests/load/README.md",
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("parse", help="sweep log -> result JSON on stdout")
    p.add_argument("log")
    p.add_argument("--target", required=True, choices=["r1", "r6", "r10", "r11"])
    p.add_argument("--vantage", default="unknown",
                   help="where the load generator ran: in-cluster | in-region-cluster-job | operator-host | in-vpc")
    p.add_argument("--image", default=None, help="the server image, when known (pinned by digest)")
    p.add_argument("--server-startup-s", type=float, default=None, help="server start to ready, seconds (cold start)")
    p.add_argument("--first-request-ms", type=float, default=None,
                   help="the cold first request (ms), from the step that sent it (R1 04-workload, R6 the measure probe)")
    p.add_argument("--first-request-source", default=None, help="which step --first-request-ms comes from")
    p.add_argument("--placement", default=None, help="JSON object describing where the bench ran (05-load.sh)")
    p.add_argument("--max-ttft-p99-ms", type=float, default=env_float("BAR_MAX_TTFT_P99_MS", None))
    p.add_argument("--max-tpot-p99-ms", type=float, default=env_float("BAR_MAX_TPOT_P99_MS", None))
    p.add_argument("--max-e2e-p99-ms", type=float, default=env_float("BAR_MAX_E2E_P99_MS", DEFAULT_E2E_P99_MS))
    p.add_argument("--min-output-tps", type=float, default=env_float("BAR_MIN_OUTPUT_TPS", None))
    p.add_argument("--min-success-ratio", type=float, default=env_float("BAR_MIN_SUCCESS_RATIO", 1.0))
    p.add_argument("--usd-per-hour", type=float, default=env_float("BENCH_USD_PER_HOUR", None))
    p.add_argument("--utilisation", type=float, default=env_float("BENCH_UTILISATION", 1.0))
    p.add_argument("--usd-per-1m-output", type=float, default=env_float("BENCH_USD_PER_1M_OUTPUT", None))
    a = ap.parse_args(argv)
    for k in ("server_startup_s", "first_request_ms"):
        v = getattr(a, k)
        if v is not None and v.is_integer():
            setattr(a, k, int(v))
    if not 0 < a.utilisation <= 1:
        ap.error("--utilisation must be in (0, 1]")
    print(json.dumps(parse(a), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
