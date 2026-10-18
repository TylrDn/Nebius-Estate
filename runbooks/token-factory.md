# Token Factory runbook — R11 hosted models

List the models an API key can call, run the one-request smoke test when the account owner agrees,
handle the key, and check a dedicated endpoint. The recipe, with every citation, is
[`recipes/token-factory`](../recipes/token-factory/README.md). Token Factory is a separate product
(own console, keys and billing account); nothing here touches Nebius AI Cloud or Terraform.

Who: anyone holding the Token Factory API key; the account owner for anything that spends credit.
Risk: steps 1–2 are free and read-only; step 3 spends a fraction of a cent; dedicated endpoints bill
per GPU-hour once ready.

Upstream references: https://docs.tokenfactory.nebius.com/quickstart ·
https://docs.tokenfactory.nebius.com/api-reference/introduction ·
https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits ·
https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/overview .

## Key handling

| Step | Command / action | Expect |
|---|---|---|
| Create | Token Factory → **API keys** → **Create API key**; the key is shown once (https://docs.tokenfactory.nebius.com/api-reference/introduction) | the key on screen, once |
| Store | `scripts/store-credentials.sh NEBIUS_API_KEY` (prompts, writes `.env` mode 600, checks `GET /v1/models`) | `.env` holds `NEBIUS_API_KEY`; `make env-status` shows it set, never the value |
| Rotate | [`credential-rotation.md`](credential-rotation.md): new key, store it, then delete the old one in Token Factory | old key refused (401) |
| Leak | delete the key in Token Factory at once, then rotate; Nebius may also revoke a compromised key automatically (same page) | 401 on the old key |

Never paste the key into a command line (`ps` shows arguments), a ticket or client-side code. The
scripts read it from the environment or `.env` and pass it to `curl` on stdin.

## List models (free, read-only)

```bash
recipes/token-factory/list-models.sh             # id and owner
recipes/token-factory/list-models.sh --verbose   # + context length, price fields, per-model RPM/TPM
```

Expect HTTP 200 and a count on stderr (`25 models …` on 2026-10-11). `401`: the key is wrong or
deleted. Take model ids from this list, not from doc examples: three example ids in the docs were
not served on 2026-10-11 ([Evidence](../recipes/token-factory/README.md#evidence)).

## Smoke test (paid, owner decides)

1. `python3 recipes/token-factory/smoke.py --dry-run`: check model, URL and `max_tokens` (≤ 16).
   Nothing is sent.
2. Ask the account owner. The request costs a fraction of a cent (31 tokens on 2026-10-11; the API's
   price fields carry no unit, so no per-token figure is quoted: [smoke evidence](../docs/evidence/2026-10-11-token-factory-smoke.md))
   and is debited from the owner's balance.
3. With the owner's yes: `python3 recipes/token-factory/smoke.py --yes --json > /tmp/tf-smoke.json`.
   Expect `http_status` 200, a short reply, `prompt_tokens`, `completion_tokens` ≤ 16 and
   `latency_ms` (whole request, not time to first token).
4. Record it in `docs/evidence/<date>-token-factory-smoke.md`: date, model requested and returned,
   tokens, latency, rate-limit headers. Never the key or account identifiers.

| Symptom | Cause | Action |
|---|---|---|
| `refusing: …` exit 2 | no `--yes` | intended; see step 2 |
| HTTP 401 | key missing or deleted | re-store the key |
| HTTP 404 / model not found | id not served (deprecated or example-only) | pick an id from `list-models.sh`; [deprecations](https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice) |
| HTTP 429 | rate limit; the script prints `Retry-After` | wait and ramp gradually (https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits) |
| `x-ratelimit-over-limit: yes` | served over the limit at lower priority | early warning; slow down |

## Dedicated endpoints (not scripted)

Creating one bills per GPU-hour, per minute, once a replica is `ready`
(https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/billing-policy), so it
needs a written spend approval like any apply ([`docs/cost.md`](../docs/cost.md)).

| Step | How | Note |
|---|---|---|
| Valid combinations | `GET https://api.tokenfactory.nebius.com/v0/dedicated_endpoints/templates` (read-only) | model × flavor × GPU type × count × region (https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/deploy-api) |
| Existing endpoints | `GET …/v0/dedicated_endpoints` (read-only) | find forgotten, billing endpoints (https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/operating) |
| Create | console, or `POST …/v0/dedicated_endpoints`; keep `min_replicas` 1 and `max_replicas` low for a trial | region cannot change later |
| Serve | data-plane URL of the endpoint's region + `/v1`, `model = <routing_key>` | `404` until routable (https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/control-data-plane) |
| Watch | readiness, not lifecycle, decides traffic; Warning / Partially ready > 3 h → support | https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/lifecycle-and-status |
| Stop | `PATCH …/{endpoint_id}` with `"enabled": false` | releases the GPUs; a restart may wait for capacity (https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/capacity-and-scaling) |
| Delete | `DELETE …/{endpoint_id}` | permanent |

## Evidence

| Date | What | Result |
|---|---|---|
| 2026-10-11 | `list-models.sh` (free) | 25 models listed ([details](../recipes/token-factory/README.md#evidence)) |
| 2026-10-11 | `smoke.py --yes` | HTTP 200, 947 ms, 31 tokens ([evidence](../docs/evidence/2026-10-11-token-factory-smoke.md)) |
