# Portal AI-service and tenant-level reads, read-only — 2026-10-11

- Kind: run of this repository (uncommitted working tree, 2026-10-11): the calls the portal's
  `huggingface`, `token-factory` and `nebius-inventory` connectors make, repeated by hand with `curl`.
  No Terraform root ran
- Date / region / platform / presets: 2026-10-11, 09:50:59Z (Hugging Face, Token Factory) and
  09:51:13Z (Nebius tenant reads). Region-independent (tenant-level and external APIs); no presets
- Identity: `HF_TOKEN` and `NEBIUS_API_KEY` from `.env`; for the Nebius calls, the portal's read-only
  service account (JWT exchanged at `sts.nebius.com`, as in
  [portal live evidence](2026-10-11-portal-live-read-only.md#method)). Its tenant-level roles were not
  re-read in this run. No token, tenant, project or account ID is written here
- Versions: Hugging Face Hub API, Token Factory API and Nebius public REST API as served on the day;
  request header `User-Agent: nebius-estate/0.1.0` on the Nebius calls
- Method: one GET (or HEAD) per row below, `curl -sS -w '%{http_code}'`; only the status code, item
  counts and the `gated` flag were read from the bodies
- Cost: none (reads only; no model weights downloaded, no completion requested)
- Caveats: one moment, one token, one account. It shows that the calls answer and with what shape, not
  that the portal's connector code handled these responses (that is `yarn verify:live`). The gated
  probe used one model outside the workload list; the workload models themselves are not gated

## Hugging Face (`HF_TOKEN`)

| Call | Result |
|---|---|
| `GET https://huggingface.co/api/whoami-v2` (Bearer) | 200; `type` user, `auth.accessToken.role` `fineGrained` |
| `GET /api/models/Qwen/Qwen2.5-1.5B-Instruct` | 200; `gated` false, `private` false |
| `GET /api/models/Qwen/Qwen2.5-7B-Instruct` | 200; `gated` false, `private` false |
| `HEAD /Qwen/Qwen2.5-1.5B-Instruct/resolve/main/config.json` | 307 (redirect: readable) |
| `HEAD /Qwen/Qwen2.5-7B-Instruct/resolve/main/config.json` | 307 (redirect: readable) |
| `GET /api/models/meta-llama/Llama-3.1-8B-Instruct` | 200; `gated` `manual` |
| `HEAD /meta-llama/Llama-3.1-8B-Instruct/resolve/main/config.json` | **403**: gated, this token has no access |

The two Qwen ids are the only Hugging Face ids in `workloads/inference/overlays`, `recipes/serverless`
and `platform/versions.yaml` on the day.

## Token Factory (`NEBIUS_API_KEY`)

| Call | Result |
|---|---|
| `GET https://api.tokenfactory.nebius.com/v1/models` | 200; 25 models in `data` (same count as the [pricing run](2026-10-11-solutions-pricing.md#token-factory-model-listing-091258z)) |

## Nebius tenant-level reads (portal service account)

| Call | Result |
|---|---|
| `GET https://api.nebius.cloud/capacity/v1/capacity-block-groups?parentId=<tenant>` | 200; empty body (`{}`, proto3 omits an empty `items`): 0 capacity block groups, no `nextPageToken` |
| `GET https://api.nebius.cloud/iam/v2/projects?parentId=<tenant>` | 200; 9 items, no `nextPageToken` |

With project-only permits both calls answered 403 earlier the same day
([portal live evidence](2026-10-11-portal-live-read-only.md#tenant-level-reads-refused-as-expected));
this identity now holds a tenant-level read grant. The capacity advisor and contract prices are not
re-checked here; they ran in the [pricing run](2026-10-11-solutions-pricing.md).

## What this does not show

- Which tenant role is the minimum for each tenant read (the grant was not re-read or varied).
- A populated capacity block group list (the tenant holds none).
- Access to a gated model with a token that has been granted it.
- Token Factory usage, balance or throughput.
