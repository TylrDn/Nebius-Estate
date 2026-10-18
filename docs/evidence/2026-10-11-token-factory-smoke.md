# Token Factory smoke test (R11) — 2026-10-11

- **Kind:** run of this repository (`recipes/token-factory/smoke.py --yes`), approved by the owner within
  a $1 Token Factory budget.
- **Date / service:** 2026-10-11 ~08:45 UTC, Nebius Token Factory, `https://api.tokenfactory.nebius.com/v1/`,
  model `nvidia/Nemotron-3_5-Lightning` (the script's default: the quickstart's example model is not served).
- **Method:** one chat completion, a fixed tiny prompt, `max_tokens` 8; key from `.env` (`NEBIUS_API_KEY`),
  never printed. `list-models.sh` the same day listed 25 models.
- **Cost:** 31 tokens; a fraction of a cent of the owner's promo credit (Token Factory exposes no usage API;
  the Usage tab of the Token Factory console is the source).

## Results

| Check | Result |
|---|---|
| Authentication and request | HTTP 200 |
| Latency | 947.4 ms for the whole request (not time to first token; one sample, not a percentile) |
| Tokens | prompt 23, completion 8, total 31, `finish_reason` length (capped on purpose) |
| Rate-limit headers | 600 requests and 400,000 tokens per window (`x-ratelimit-limit-*`) |

## What this does and does not show

- Shows: the key, the base URL and the OpenAI-compatible client path of R11 work end to end.
- Does not show: throughput, time to first token, latency percentiles, or the price per token (the API's
  price fields carry no unit; see `docs/upstream-findings.md`).
