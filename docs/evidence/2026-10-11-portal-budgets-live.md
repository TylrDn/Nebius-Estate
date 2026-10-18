# Portal budgets and credits against the live FOCUS export — 2026-10-11

- Kind: run of this repository (working tree on commit 91c99a8, 2026-10-11): the portal's
  Budgets & credits API on the local dev backend (`yarn start`, `:7007`), called with `curl` as the
  development guest identity. No Terraform root ran
- Date / region / platform / presets: 2026-10-11, 17:48:55Z (read before), 17:49:00Z (create),
  17:49:05Z (read back), then delete. Spend covers every listed project (account-wide budget); no
  presets
- Identity: the local guest (`user:development/guest`), which holds `nebius.billing.read` and
  `nebius.billing.budget.write` in the local dev config (`canEdit: true`). No token, tenant, project,
  account or record ID is written here
- Versions: portal backend as in the working tree; FOCUS 1.2 export pulled by the
  `billing-object-storage` connector (export through 2026-10-11T15:37:29Z, 420 October rows in scope);
  live run-rate from the Nebius billing calculator (contract price)
- Method: `GET /api/nebius-estate/budgets` (no budget, credit or spend entry existed; nothing mirrored
  from the console), `POST /budgets/credit`, `POST /budgets/budget`, `GET /budgets`, then
  `DELETE /budgets/budget/<id>` for the temporary budget and a final `GET /budgets`
- Cost: none. The portal stores budgets and credits in its own database; nothing is sent to Nebius or
  Token Factory
- Caveats: one moment, local data. The budget was a temporary check, deleted afterwards; it mirrors no
  console budget, so the console's own figure for it was not compared. The credit's draw-down is not
  exercised: no Token Factory spend has been entered yet. The FOCUS actual moved from about 10.51 USD
  (earlier in the day) to 12.38 USD as later export hours arrived

## Entered

| Record | Fields | Kept |
|---|---|---|
| Credit | provider Token Factory, 25 USD, applied 2026-10-11, no expiry, note "promo code added by the owner 2026-10-11" | yes: the owner's real credit |
| Budget | AI Cloud, monthly, all usage (no conditions), 50 USD, thresholds 50/80/100 % (defaults) | no: temporary, deleted (204) after the read-back |

Both creates answered 201 with the record as stored (`createdBy` the guest).

## Read back (`GET /budgets`, 17:49:05Z)

Budget, window 2026-10-01 → 2026-11-01 (UTC):

| Part | Source label | Amount (USD) |
|---|---|---|
| actual | `focus-export`: BilledCost, 420 rows, tax excluded, as of 15:37:29Z | 12.381206051 |
| estimate | `live-run-rate`: 0.7686444 USD/h (billing calculator, contract price) × 2.2 h since the last exported hour | 1.685893384 |
| total | spend to date | 14.067099435 |

- Spend to date = FOCUS actual + run-rate estimate exactly (12.381206051 + 1.685893384), each part
  labelled with its source; the actual equals the page summary's month-to-date FOCUS figure.
- Burn rate 1.309491 USD/day = 14.067099435 over the 10.742 days since 2026-10-01 00:00Z.
- Forecast at period end 40.594217 USD (81.2 %) = 14.067099435 + 1.309491 × the 20.258 days left;
  not over the amount.
- Status `ok` ("Within every threshold") at 28.1 %: no threshold crossed (50 % = 25 USD), no signal.
  The forecast passes the 80 % threshold but not 100 %, and the status reports spend to date, not the
  forecast: coherent.

Credit: used 0 (`token-factory-entries`, nothing entered), remaining 25 USD, status `ok` ("No expiry
entered"), with the note to enter Token Factory spend from its Usage tab. The page summary lists 25 USD
of Token Factory credit remaining.

After the delete: 0 budgets, 1 credit (25 USD remaining).
