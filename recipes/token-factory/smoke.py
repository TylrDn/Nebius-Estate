#!/usr/bin/env python3
"""R11 Token Factory smoke test: ONE chat completion with a tiny prompt, then latency and token usage.

It spends a fraction of a cent of the account owner's Token Factory credit, so it refuses to send
anything without --yes. --dry-run prints the exact request (key redacted) and sends nothing; it
needs neither the key nor the network, which is how `make ci` checks this script.

    python3 recipes/token-factory/smoke.py --dry-run
    python3 recipes/token-factory/smoke.py --yes [--model <id>] [--max-tokens 8] [--json]

The API is OpenAI-compatible: POST <base>/chat/completions with "Authorization: Bearer
$NEBIUS_API_KEY" (https://docs.tokenfactory.nebius.com/api-reference/introduction). The key comes
from the environment or, when unset, from NEBIUS_API_KEY in the repository's .env; it is never
printed. NIP_TF_BASE_URL overrides the base URL (default https://api.tokenfactory.nebius.com/v1/,
https://docs.tokenfactory.nebius.com/quickstart). Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1/"
# The quickstart's model (deepseek-ai/DeepSeek-R1-0528) was not in GET /v1/models on 2026-10-11
# (README "Evidence"). nvidia/Nemotron-3_5-Lightning is named in the docs as a recommended
# replacement (https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice), was listed on
# that date, and had the lowest listed prompt and completion price. Check with list-models.sh.
DEFAULT_MODEL = "nvidia/Nemotron-3_5-Lightning"
DEFAULT_PROMPT = "Reply with the single word: ok"
MAX_TOKENS_CAP = 16  # hard cap: this is a smoke test, not a benchmark
USER_AGENT = "nip-token-factory-smoke/1"
RATE_HEADERS = (
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-over-limit",
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"model id from list-models.sh (default {DEFAULT_MODEL})")
    p.add_argument("--prompt", default=DEFAULT_PROMPT, help="user message (keep it tiny)")
    p.add_argument("--max-tokens", type=int, default=8, help=f"completion token cap, 1-{MAX_TOKENS_CAP} (default 8)")
    p.add_argument("--base-url", default=os.environ.get("NIP_TF_BASE_URL", DEFAULT_BASE_URL), help="OpenAI-compatible base URL")
    p.add_argument("--timeout", type=float, default=60.0, help="seconds before the request is abandoned")
    p.add_argument("--json", action="store_true", help="print one JSON summary instead of text")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="print the request and send nothing (no key, no network)")
    mode.add_argument("--yes", action="store_true", help="really send it: spends a fraction of a cent of the owner's credit")
    a = p.parse_args(argv)
    if not 1 <= a.max_tokens <= MAX_TOKENS_CAP:
        p.error(f"--max-tokens must be 1-{MAX_TOKENS_CAP}")
    if len(a.prompt) > 200:
        p.error("--prompt is limited to 200 characters: this is a smoke test")
    if not a.base_url.startswith("https://"):
        p.error("--base-url must be https://")
    return a


def endpoint(base_url: str) -> str:
    return base_url.rstrip("/") + "/chat/completions"


def body(a: argparse.Namespace) -> dict:
    return {
        "model": a.model,
        "messages": [{"role": "user", "content": a.prompt}],
        "max_tokens": a.max_tokens,
        "temperature": 0,
        "stream": False,
    }


def api_key() -> str:
    """NEBIUS_API_KEY from the environment, else that one line of .env (nothing else is read)."""
    key = os.environ.get("NEBIUS_API_KEY", "").strip()
    env_file = REPO_ROOT / ".env"
    if not key and env_file.is_file():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):].lstrip()
            if line.startswith("NEBIUS_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
    return key


def redact(text: str, key: str) -> str:
    return text.replace(key, "<redacted>") if key else text


def main(argv: list[str]) -> int:
    a = parse_args(argv)
    url, payload = endpoint(a.base_url), body(a)
    headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT}

    if a.dry_run:
        shown = dict(headers, Authorization="Bearer <NEBIUS_API_KEY redacted>")
        print(json.dumps({"dry_run": True, "method": "POST", "url": url, "headers": shown, "body": payload}, indent=2))
        print("dry run: nothing sent", file=sys.stderr)
        return 0

    if not a.yes:
        print(
            "refusing: this sends one chat completion and spends a fraction of a cent of the account "
            "owner's Token Factory credit. Re-run with --yes once the owner has agreed, or use --dry-run.",
            file=sys.stderr,
        )
        return 2

    key = api_key()
    if not key:
        print("NEBIUS_API_KEY is not set (environment or .env; docs/credentials.md)", file=sys.stderr)
        return 2

    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers=dict(headers, Authorization=f"Bearer {key}"))
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=a.timeout) as resp:
            raw = resp.read()
            status, resp_headers = resp.status, resp.headers
    except urllib.error.HTTPError as e:
        detail = e.read()[:500].decode(errors="replace")
        print(f"HTTP {e.code} from {url}: {redact(detail, key)}", file=sys.stderr)
        if e.code == 429:
            print(f"rate limited; Retry-After: {e.headers.get('Retry-After')}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"request to {url} failed: {redact(str(e), key)}", file=sys.stderr)
        return 1
    latency_ms = round((time.perf_counter() - t0) * 1000, 1)

    data = json.loads(raw)
    usage = data.get("usage") or {}
    choice = (data.get("choices") or [{}])[0]
    content = ((choice.get("message") or {}).get("content") or "").strip()
    summary = {
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "url": url,
        "http_status": status,
        "model_requested": a.model,
        "model_returned": data.get("model"),
        "latency_ms": latency_ms,
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "total_tokens": usage.get("total_tokens"),
        "finish_reason": choice.get("finish_reason"),
        "reply": content[:80],
        "rate_limit_headers": {h: resp_headers.get(h) for h in RATE_HEADERS if resp_headers.get(h) is not None},
    }
    if a.json:
        print(redact(json.dumps(summary, indent=2), key))
    else:
        print(redact(
            f"{summary['http_status']} {summary['model_returned']} in {latency_ms} ms (whole request, not time to first token)\n"
            f"tokens: prompt {summary['prompt_tokens']}, completion {summary['completion_tokens']}, total {summary['total_tokens']}"
            f" (finish_reason {summary['finish_reason']})\n"
            f"reply: {summary['reply']!r}\n"
            f"rate limits: {summary['rate_limit_headers'] or 'no x-ratelimit-* headers returned'}",
            key,
        ))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
