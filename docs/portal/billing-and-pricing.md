# Nebius Estate — billing and pricing

Five kinds of number, never mixed:

| Figure | Source | Page |
|---|---|---|
| **Reported cost** | Nebius FOCUS exports, pulled from the export bucket or imported by hand (BilledCost, EffectiveCost, ListCost or ContractedCost, one at a time) | Costs |
| **Nebius list price (live)** | The Nebius billing calculator, asked at the time shown | Overview, Provisioning, Commercial Scenarios |
| **Public list-rate estimate** | A rate book of kind `public-list` | Commercial Scenarios |
| **Negotiated-rate scenario** | A rate book of kind `negotiated` (confidential) | Commercial Scenarios |
| **Customer-facing draft price** | Expected estimate × (1 + margin) | Commercial Scenarios |
| **Spend against a budget or credit** | FOCUS rows (actual), the live run-rate since the last exported hour (estimate), Token Factory spend entered by you; each part labelled with its freshness | Budgets & credits |

Every estimate carries the label **"Draft estimate — not a provider offer or capacity guarantee."**

## Live list prices

The billing calculator (`POST /billing/v1/calculator/estimate-batch`) prices a would-be create
request; it creates nothing and is the only POST the portal makes to the Nebius API. The portal
asks it for:
- the **live run-rate** of the running inventory in scope (VMs by platform and preset, disks and
  filesystems by type and size, Managed PostgreSQL clusters by their template: platform, preset, disk
  and hosts), project by project. A running Managed MLflow cluster is listed as not priced: the
  calculator answers HTTP 500 for an MLflow create request (2026-10-11), so its price is on the MLflow
  pricing page, not in the total. Only what the latest inventory sync read is priced: a resource last
  read before it (its list's read failed, or it is on a list that sync skipped) is listed as not
  priced, "last seen <time>, not in the latest inventory sync", never added to the total (live
  2026-10-12: a deleted PostgreSQL cluster stayed priced at 0.149 USD/h from an old read). The
  rate-book run-rate tile applies the same rule;
- a **provisioning preview**'s footprint (VMs, boot disks, shared filesystem, extra disks) in a
  listed project of the requested region;
- a **scenario**'s expected footprint.

A footprint's estimate states the capacity type it priced, in its header ("Capacity: preemptible GPU nodes,
on-demand system nodes") and at the end of each VM line (`· preemptible` or `· on-demand`): preemptible applies to
GPU node groups only, and a reserved request is priced at the on-demand price (a reservation's own price is not read).

Each answer names its source and time ("Nebius billing calculator (list price)", as of …), its SKU
lines, and what it could not price (usage-based Object Storage, public IPs, a spec the calculator
rejects) — never a guess. Prices are cached per spec and project (`nebius.pricing.cacheMinutes`,
default 30). Contract prices (`OFFER_TYPE_CONTRACT_PRICE`) are tried first when
`nebius.pricing.tryContractPrice` is on (default); they need `resource.billinggroup.get` on the
billing group, and without it the list price is used and the estimate
says so. A contract figure is labelled **contract price**; the calculator is also asked for the list
price of the same lines, and the label reads **contract price (= list)** on every page when the two are equal, or the list figure
when they differ (verified live 2026-10-11: equal on that account). Disk and filesystem
prices use their documented create requests; VMs were verified live, and so was a Managed PostgreSQL
template (2026-10-11: `cpu-e2` `2vcpu-8gb` with 96 GiB priced at 0.149 USD/h, twice that with 2 hosts).

User rate books stay for what the calculator cannot say: negotiated rates and what-if scenarios.

## FOCUS ingestion

- **Format:** Nebius exports are FOCUS 1.2 CSV with hourly detail (docs.nebius.com/signup-billing/usage/export).
  Required columns: `BilledCost`, `BillingCurrency`, `ChargePeriodStart`, `ChargePeriodEnd`,
  `ChargeCategory`. Unknown columns are reported, not rejected. The export writes the literal `NULL`
  for an empty value in any column; it is read as empty (a `NULL` cost is "no value", never 0).
- **Nebius extension columns** (live export, 2026-10-11): `x_TenantId`, `x_TenantName`, `x_ProjectId`,
  `x_ProjectName`, `x_ContainerId`, `x_ContainerName`, `x_TrialId`, `x_ContractPriceId`,
  `x_UsageBasedDiscountIds` are parsed and stored on each row. A row whose `x_TrialId` is set is
  **drawn from trial or promo credit**: Costs shows the count and amount, and AI Cloud credits draw
  those rows (every value was `NULL` in the October 2026 file).
- **Rows stored before the extension columns were parsed** are fixed by the migration
  `20261011021100_focus_extension_columns`: it re-derives the project from a container that is a
  project, clears stored `NULL` text, and queues every export-bucket file that reported the columns as
  unknown for one re-import on the next sync (supersession makes it count once). It is idempotent.
  Manually uploaded files are not kept: import them again to get `x_TrialId`.
- **Rows are kept as they are.** Credits, adjustments, corrections and taxes stay signed rows; nothing
  is netted. A missing value in the chosen metric is counted as "rows without this metric", never zeroed.
- **No double counting:**
  - exact duplicate rows in a file are dropped;
  - re-importing an hour supersedes the earlier rows of the same billing account, attributed
    project (`x_ProjectId`, else `x_ContainerId`: the same id scope checks and reports use) and
    `ChargePeriodStart`, so repeated or overlapping exports count once, and a one-project file never
    touches other projects' rows (`billingSlot` in `nebius-domain/src/billing.ts`);
  - a row whose `x_ProjectId` and `x_ContainerId` are both set and differ is rejected with the reason
    ("x_ProjectId … and x_ContainerId … disagree"), shown in the import summary;
  - a project-scoped importer can only import rows whose attributed project and container are both
    in its scope (403 otherwise), so it can only supersede its own projects' rows;
  - superseded rows are **deleted** in the import's transaction: only active rows are stored, so
    re-exports do not grow the table. Each import keeps its summary (rows accepted, superseded and
    rejected, the imports it replaced), who imported it and when, and the projects it carried, so the
    import list still follows the caller's scope. The migration
    `20261011030000_billing_slot_by_project` deletes rows superseded before this, re-derives every
    stored row's slot from its attributed project, and where an older row (slotted by `x_ContainerId`)
    and a newer import now share a slot, keeps the newer import's rows, as a re-import would.
- **Reports select in SQL.** Each report reads only the active rows of the caller's projects, period,
  region and service from indexed columns, then aggregates them; nothing loads the whole ledger.
- **Currencies are never added together.** Totals are per currency; no exchange-rate policy exists.
- **Attribution:** project comes from `x_ProjectId` and `x_ProjectName`, then `x_ContainerId` and
  `x_ContainerName` when the row has no project; scope and the project filter use the same value. Since 2026-09-21 the
  `Tags` column carries the cost allocation labels of Compute billable resources (a
  `map<string,string>` whose text encoding is not documented: `parseTags` accepts a JSON object or
  `k=v` / `k:v` pairs separated by `,` or `;`, and ignores anything else). Stage and run breakdowns use
  the row's own tag first and fall back to joining `ResourceId` to the inventory's `nip-*` labels
  (rows without tags, e.g. non-Compute); each group and the report note say which source was used.
  Rows that cannot be attributed are shown as **(unattributed)**.
- **Health:** the reporting period, export lag (whole hours since the last exported hour) and the
  export's coverage are shown with every report; see [Export completeness](#export-completeness).
  A range that holds no rows says "No billed rows in this range" and keeps the health strip; "No
  billing data imported" is shown only when there is no row for the selection at all. A malformed
  `?from=` / `?to=` in a link is named in a "not applied" notice.
- **Budgets** are advisory and live on one page, [Budgets & credits](#budgets-and-credits); Costs and
  Overview link there. The **deprecated** `nebiusEstate.budgets` config (`id`, optional `project`,
  `amount`, `currency`, `period` YYYY-MM, `source`) still loads, and its entries show read-only on
  Budgets & credits ("from config", BilledCost of that month excl. tax and credit rows (`countsAsSpend`), scoped like every budget); they are not
  imported into the database. Budgets notify, quotas stop (`docs/cost.md`).
- **Reports:** a date range is `[from, to)` in UTC; an inverted range is refused (400) and caught on
  the field. The daily chart and the reporting period follow the range; export lag describes the
  export as a whole. Breakdown rows are rounded for display so they add up to the rounded total (the
  total itself is exact), with each row's share in percent. An import with no rows is explained as
  "header only: no usage in this period"; rejected rows list their reasons.
- **Idle cost** is not computed. Utilisation-based allocation is not invoice reconciliation, and
  attribution here cannot support that claim.

### Export completeness

The portal does **not** count "missing hours". A FOCUS periodic export holds rows only for hours with
usage: an hour in which nothing billable ran has no row, so a missing hour slot is not evidence of a
gap (an earlier version counted every such hour, and stepped from an unaligned first start such as
15:48:47, so it reported almost every hour of an export as missing). The Completeness tile says what is
known instead, as one figure ("12 of 91 h with usage"):

- **Hours the export spans:** from the first usage hour (the first usage row's start, floored to the hour) to
  `exportedThrough` (the last exported moment), a partial last hour counted.
- **Hours with usage:** distinct hour slots, floored, that hold at least one usage row (charge
  periods of one hour or less; month-long rows such as tax are not usage).
- **Days without usage rows:** whole UTC days strictly between the first and last usage day with no
  usage row. They are named, not flagged as gaps: the export alone cannot tell an idle day from a day
  that was not exported. Telling them apart needs evidence the portal does not keep (the account's
  running resources at that time), so the portal makes no claim either way.

Coverage, like the export lag, describes the export as a whole for the project/region selection; it
does not follow the date range. Every "how long ago" in the portal (export lag, "N h ago", connector
freshness) counts whole elapsed units (`lagHours` / `agoText` in `nebius-domain`), so one timestamp reads
the same on Overview, Costs, Budgets and Integrations.

Files arrive two ways: the [billing export pull](#billing-export-pull) reads them from the export
bucket, or a person imports a CSV on the Costs page. Both go through the same import, and each import
is audited.

## Billing export pull

Optional connector **Billing export pull (Object Storage)**. Nebius writes the periodic FOCUS export
(Billing → Export → Periodic export, set up by an admin in the console) to a bucket; the portal lists
that bucket and imports new files.

| Variable | Meaning |
|---|---|
| `NEBIUS_BILLING_EXPORT_BUCKET` | the export bucket |
| `NEBIUS_BILLING_EXPORT_REGION` | its region (e.g. `eu-north1`) |
| `NEBIUS_BILLING_EXPORT_PREFIX` | optional key prefix |
| `NEBIUS_BILLING_EXPORT_ACCESS_KEY_ID`, `NEBIUS_BILLING_EXPORT_SECRET_ACCESS_KEY` | an access key of a service account with read access to the bucket only |

The config holds the variable names (`nebiusEstate.billing.export`); without all four required values
the connector is `not-configured` and never called.

- **Requests.** S3-compatible, signed with AWS Signature V4 (node `crypto`, no SDK): service `s3`,
  region = the bucket region, host `storage.<region>.nebius.cloud`, path-style `/<bucket>`,
  `x-amz-content-sha256: UNSIGNED-PAYLOAD`. `ListObjectsV2` with continuation tokens (≤ 100 pages),
  then `GetObject` per new file. GET only; the endpoint is derived from the region and is the only
  origin allowed.
- **What is imported.** Keys ending `.csv`, `.csv.gz` or `.gz`; `.gz` files are gunzipped. Each file
  is normalised and imported like a manual upload (`importedBy: system:billing-export`), so
  supersession per billing account × project × hour applies and a re-exported hour counts once.
- **Dedupe.** Key, ETag and size are recorded (`nebius_billing_export_objects`); an unchanged file is
  skipped, a changed one (new ETag or size) is imported again.
- **Bounds.** At most 50 files per sync (the rest follow on the next); each file and its gunzipped
  content are capped at `billing.maxImportBytes`; list pages at 20 MB.
- **Failures.** One file that fails (too large, bad gzip, not FOCUS) is recorded with its error and
  does not stop the others; it is retried when it changes. A refused or missing bucket (403/404) is
  the capability state `permission-denied` / `not-found` on `billing.export.objects`.
- **Empty bucket.** The capability says "No export files yet: enable Billing → Export → Periodic export
  to <bucket>".
- Credentials are read at call time and never logged; errors are redacted.

## Budgets and credits

Nebius AI Cloud has **no API for budgets, the balance or promo credits**, and Token Factory has no
usage or balance API (`/v1/usage`, `/v1/billing` answer 404; checked 2026-10-11). The owner enters
them on **Finance → Budgets & credits**; they are stored in the portal database (never in git),
labelled "entered by you", with the user who saved them and the tenant. Nothing is seeded.

- **Budget** (mirrors Billing → Budgets in the console): name; period Daily, Monthly, Quarterly or
  Yearly, starting 00:00 UTC on calendar boundaries; scope all usage, or conditions on region, project,
  service (FOCUS `ServiceName`) and product (`SkuId` or `ChargeDescription`), all of which must match;
  amount and currency (a new budget starts in the currency the provider's spend is in); thresholds in
  percent or absolute. A Token Factory budget has no conditions. The project condition is picked from
  the projects you can see. Every drawer checks its fields before anything is sent and says what is
  wrong in plain words on the field (`formIssues`, the routes' own schemas).
- **Credit**: provider (AI Cloud or Token Factory), amount, currency (starts in the provider's spend
  currency and follows the provider, as for a budget), applied date, optional expiry (valid through
  the end of that day, UTC), note.
- **Token Factory spend**: dated amounts copied from its Usage tab, one entry per day: a second entry for a day
  already entered is refused (409, naming the entry) and the drawer saves it as a replace instead. The database holds
  the rule too (a unique provider-and-day key per tenant, migration 20261013010000), so two saves at the same moment
  cannot both be stored; days entered twice before that migration keep both rows.

While a budget is typed, the drawer shows its scope's spend in the current period against the amount
(`POST /budgets/preview`, `nebius.billing.read`, the caller's scope, nothing stored). Each budget row says how fresh
its figure is ("billing through …" or "entered through …") and links to Costs with its period and the project and
region Costs can filter, naming the conditions it cannot (`budgetCostsLink`).

Spend, labelled per part with its freshness:

| Part | Source | Freshness |
|---|---|---|
| actual | FOCUS `BilledCost` of the period and scope, excl. tax and credit rows (`countsAsSpend`; console budgets exclude VAT, a credit row is not spend); other currencies counted out and said so | end of the newest exported hour |
| estimate | live run-rate of the running Compute in scope, and of managed PostgreSQL when the budget has no service condition (billing calculator) × hours since the newest exported hour; not added for a service or product condition other than Compute | calculator time |
| entered | Token Factory spend entries in the period | newest entry date |

Burn rate is spend so far over the time since the first observed spend in the period. Two forecasts to the period
end are shown: **at this period's average burn** (spend to date plus that rate; withheld with under a day of spend)
and **if nothing new runs** (spend to date plus the live run-rate of what runs now, or spend to date when nothing
runs). A line that cannot be made says why: no billing rows, spend in another currency, no run-rate (with its
reason), or a Token Factory budget (no run-rate). **Used**, the status and the threshold and over alerts
count the actual (export rows and entered spend) only, so an entered budget and a config budget for the
same project and month show the same percent. The actual plus the estimate is a separate **Projected**
line under Used ("Projected over the amount with the live estimate") with its own alert. Status: ok, at
threshold (a threshold crossed by the actual), over, or no data (with the reason). A budget whose currency no
spend in its scope is in has no data, not 0 %: amounts are never converted, and the note names the
currency to use. The Overview's Budgets tile shows the same state and reason (`budgetGlance`), for
entered and config budgets alike: a no-data row has a grey reason and no meter. Credits: earlier credits of a
provider draw first; AI Cloud credits draw the rows marked `x_TrialId` when the export marks any (else
all spend since the credit was applied); Token Factory credits draw the entered spend. Each shows
remaining, burn rate, the date it runs out and whether that is before it expires; status ok (green only with an
expiry; "no expiry entered" is grey), expiring in N days (≤ 14), running out (the burn of at least a day uses it up
within 14 days; amber), expired, used up, not started, or **unverified** when no spend is known since it applied
(no Token Factory spend entered in its validity; no AI Cloud export rows, or none since it applied, when the export
ends before the credit's applied date): then "≤ amount left", grey, with the
reason, on Budgets, the Credit remaining tile and the Overview. A whole-account summary shows this
month's spend by source, led by what was spent (export rows and entered spend); the run-rate estimate
is a separate "projected to now" line, never in the headline. It shows the credit remaining per
provider, and counts budgets entered here and from the configuration apart ("0 entered by you (1 from
config)").

**Budget alerts.** `budgetSignals({ budgets, credits }, now)` in `nebius-domain/src/budgets.ts` (pure)
returns threshold crossings by the actual (`budget-threshold`, `budget-over`), projected warnings
(`budget-projected`: the highest threshold only the actual plus the live estimate reaches; warning when it
is the amount, info below it), forecast warnings (`budget-forecast`: the
period-end forecast at the burn rate so far reaches a threshold spend has not crossed yet; one per budget, for the
highest such threshold, once there is a day of burn history) credit-expiry warnings
(`credit-expiring`, ≤ 14 days) and credits running out (`credit-exhausting`, ≤ 14 days at the current burn; critical
within 3) with stable ids, evidence and a guided fix (`runbook`:
`runbooks/finance.md#budget-or-credit-signal`, `docs`: docs.nebius.com). The backend's
`BudgetService.signals(now)` evaluates them over the whole account for the alert engine;
`GET /budgets/signals` serves the caller's own (the same scope as `GET /budgets`). Every budget, credit or
spend-entry write re-evaluates the budget alerts before it answers (`AlertEngine.reevaluateBudgets`): a deleted
budget's alerts resolve at once with "Resolved: budget deleted.", a crossing fires without waiting for a sync.

Beside "export through", Costs, Budgets and the Overview show the export pull's next run and, when at least three
export files arrived at a regular interval (15 min to 6 h), the next file's expected time from their bucket
LastModified times (`exportCadence`), labelled an estimate; Nebius writes the periodic export about hourly
([docs](https://docs.nebius.com/signup-billing/usage/export#periodic-export)).

Routes: `GET /budgets` (needs `nebius.billing.read`), `GET /budgets/signals`, `POST /budgets/preview`, and `POST /budgets/{budget|credit|spend}`,
`PUT`/`DELETE /budgets/{budget|credit|spend}/:id` (need `nebius.billing.budget.write`, audited; JSON ≤ 64 KB).

**Project scope.** A caller limited to some projects sees only budgets whose project conditions are all
in its scope, and writes only such budgets (403 naming the projects otherwise; another project's budget
answers 404). Budgets without a project condition (account-wide), credits and Token Factory spend
entries carry no project: only callers with access to every project see or write them. The alert
engine is not scoped: it evaluates every budget and credit.

## AI services

**Operate → AI services** reads, through the backend only, once per sync (cached for one interval; "Sync
now" on Integrations re-runs a connector):

| Connector | Calls | Shows |
|---|---|---|
| `token-factory` (`nebiusEstate.ai.tokenFactory.apiKeyEnv`, e.g. `NEBIUS_API_KEY`) | `GET https://api.tokenfactory.nebius.com/v1/models` | key configured / valid, the model list (id, owner, type, created), last check; "usage and balance: console only" with a link to the Token Factory console |
| `huggingface` (`nebiusEstate.ai.huggingface.tokenEnv`, e.g. `HF_TOKEN`) | `GET /api/whoami-v2`; per model the workloads use, `GET /api/models/<repo>` and a `HEAD` of `<repo>/resolve/main/config.json` with the token | token valid, account and token type; per model: gated (manual / auto / open) and accessible (a redirect means readable, 401/403 no access, with what to do) |

Models come from `workloads/inference/overlays/*/kustomization.yaml`, `recipes/serverless/*.sh` and
`platform/versions.yaml` (read through the allowlisted repository reader). Weights are never
downloaded. Runs are recorded in the HealthStore like every connector. Without the configuration block
or the variable, a connector is `not-configured`, says what to set, and is never called. The page also
lists Serverless AI endpoints and jobs from the inventory. Key and token stay in the backend
environment and never reach the browser.

## Rate books

A rate book is a schema-validated JSON document (`rateBookSchema` in
`portal/packages/nebius-domain/src/pricing.ts`) imported on **Commercial Scenarios → Rate books** by a
holder of `nebius.commercial.rate.write`. It is stored in the portal database, never in git.

```json
{
  "id": "acme-negotiated-2026q4",
  "name": "Negotiated rates Q4 2026",
  "kind": "negotiated",
  "classification": "confidential",
  "currency": "USD",
  "entries": [
    {
      "id": "eu-north1-h100-od", "provider": "nebius", "region": "eu-north1", "service": "compute",
      "platform": "gpu-h100-sxm", "component": "gpu", "unit": { "quantity": "gpu", "per": "hour" },
      "capacityType": "on-demand", "currency": "USD", "price": "<decimal string>",
      "effectiveFrom": "2026-10-01", "effectiveTo": "2026-12-31",
      "source": "contract §4.2", "retrievedAt": "2026-10-01T09:00:00Z",
      "classification": "confidential", "bundles": ["vcpu", "ram"], "priceSemantics": "fixed"
    }
  ],
  "discountRules": [
    { "id": "gpu-commit", "description": "…", "percent": "10", "appliesTo": { "components": ["gpu"] }, "source": "…" }
  ]
}
```

| Rule | Meaning |
|---|---|
| `price` | Decimal **string**; exponents and separators are rejected. All arithmetic is fixed-point (12 digits, half-even) |
| `unit.per` | `second`, `hour` or `month730`. Everything is normalised to per-hour before use (`month730` = per GiB per 730 h, as Nebius prices volumes) |
| `bundles` | Components included in this rate. The Compute pricing page lists B300, B200, H200 and H100 per GPU-hour and L40S as separate GPU, vCPU and RAM lines (`.cache/nebius-docs/compute/resources/pricing.md`); it does not say that the GPU-hour rate includes vCPU and RAM. That bundling was observed for one H100 1-GPU preset on 2026-10-11 (calculator total = the $4.50 GPU-hour price, [evidence](../evidence/2026-10-11-portal-live-read-only.md#pricing)); not documented for other presets. Mark a component `bundled` only when your source says so. Bundled components are listed as `bundled`, never charged twice |
| `capacityType` | `on-demand`, `preemptible`, `reserved` or `any`. The most specific match wins (preset › platform › any) |
| `priceSemantics: variable` | Spot prices that can change during use. Estimates flag them |
| `effectiveFrom/To` | Rates outside the pricing date are `expired-rate` and excluded |
| Missing rate | `missing-rate`, excluded and listed. Never priced at zero |
| Currency mismatch | `currency-mismatch`, excluded |
| Discounts | Apply only to lines matching every selector given (components, platforms, capacity types); at least one selector is required. Overlapping rules on one line are refused |
| Commitments | Committed units × committed price are charged as floor; the covered units are not charged again |

Besides a JSON import, a rate book can be **built from current list prices** (pick regions and, optionally,
platforms of `platform/regions.yaml`; the billing calculator prices their presets, on-demand and preemptible, and
the disk and filesystem types in a listed project of each region: a GPU VM becomes a per-GPU rate bundling the
preset's vCPU and RAM, a CPU VM a per-vCPU rate, storage a per-GiB-hour rate; `POST /ratebooks/from-list-prices`)
or **imported from a CSV** on the downloadable template (`GET /ratebooks/template.csv`; every wrong row and field is
named and nothing is built while any is wrong). Both are previewed, with what was left out, and stored only on Save.

The run-rate tile and the provisioning estimate use one rate book: `nebiusEstate.commercial.defaultRateBook`
when set, else the **portal default** set on the Rate books tab (stored in the database), else the only active book,
else the first active book by id, which the Rate books tab and the Overview tile flag as a guess. A book can be
**archived** (kept for the scenarios that price with it, never a default, not offered for a new scenario) and
restored. Delete, archive and the default need `nebius.commercial.rate.write` and are audited (`ratebook-delete`,
`ratebook-archive`, `ratebook-restore`, `ratebook-default`, `ratebook-default-unset`); the portal refuses to delete
a book while a scenario prices with it, and to delete or archive the configured or portal default.

## Scenarios

Nothing is pre-loaded. Scenarios are created with **Save as copy** on the page once one exists, or with
`POST /api/nebius-estate/scenarios` (body: `scenarioSchema` in `nebius-domain/src/pricing.ts`); both
need `nebius.commercial.scenario.write`.

Inputs:
- recipe, region, currency, rate book and capacity type
- pricing date
- active, warm-up and teardown hours
- monthly-hours assumption
- min, expected and max footprints (node groups × count, storage)
- discount rules, commitments, optional margin and quote validity

Outputs:
- hourly, run-period and monthly figures
- floor (system nodes, storage, commitments) versus workload-dependent (GPU and worker nodes)
- a line-item breakdown with status
- coverage: missing, expired or mismatched rates, and variable prices. A total is shown only when every GPU, vCPU
  and RAM line is priced, and names the storage or IP lines it leaves out; otherwise the headline reads
  "Incomplete: N lines unpriced" and no selling price is made (`estimateHeadline`, on each footprint as `headline`)
- runtime sensitivity (× 0.5, 1, 1.5, 2)
- assumptions, a draft selling price, and exports as JSON, CSV or print. The JSON quote (`quote.json`,
  `quoteDocument`) carries each footprint's `headline`; an incomplete footprint has its totals (`hourly`, floor,
  workload, `runPeriod`, `monthly`, commitments) and its sensitivity figures set to `null`, with `totalsWithheld`
  holding the headline text. Its lines stay, priced or not. The CSV lists lines only, each with its status

Estimates and quotes are dated by the backend clock. The
provisioning estimate is built by `scenarioFromProvisioning`: the requested footprint as expected and
maximum, its floor (system nodes and storage) as minimum, a 730-hour month and the rate book's
currency.

The portal starts with no rate book and never invents a price. Without one, a scenario is priced with the built-in
**Nebius list price (live calculator)** source (`nebius-list-price`): a rate book built for each estimate from the
scenario's presets and the storage specs at the calculator's list price in its region (a reservation's own price is
not read, so the New scenario form does not offer "reserved" with this source). It is labelled "built-in Nebius list
price (live calculator)", never as a user rate book, and the draft quote does not compare it with the live price (it
is the live price). A rate book is optional while the calculator answers, and the pages say so alike: the Integrations
setup step is done, the Overview's rate-book run-rate reads "Not set (optional)" (no Fix link; "Every rate book is
archived" when books exist but all are archived), and a Provisioning estimate is priced at the list price for the
request's presets in its region, its coverage naming every price the calculator did not give. Only with neither a book
nor the calculator is the rate-book run-rate Unavailable and the provisioning estimate refused. The test rate book
(`portal/e2e-stub/ratebook.json`) uses invented XTS prices, with an expired SSD rate and no reserved
B300 rate so that both states are tested.
