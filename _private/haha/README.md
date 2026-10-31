# Wrapt × HAHA Open Platform — what's built and how to turn it on

Phases 1–4 of the build roadmap. Read-only: nothing here can change a machine. `hahaFetch` refuses every method except GET,
plus the batch read `POST /products/batch` (tested). Nothing has been deployed.

**Not yet verified against HAHA.** The docs site (ha-series-api.hahavending.com) and both API hosts were unreachable from the
session that built this. Field names come from the roadmap. Every point that still needs checking is listed under
"Check on first contact" below.

## Files

| File | What it does |
|---|---|
| `netlify/functions/lib/haha.mjs` | Client: token cached in Blobs (refreshed when <2 days remain or on a 401), envelope unwrap, 429/5xx backoff (500 ms → 8 s, jittered, 5 tries), cursor pagination, rate limiter (80/min per API type, 400/min total), integer-cent money, webhook HMAC verify |
| `lib/haha-data.mjs` | Normalises HAHA records into what's stored. Unknown shapes become warnings in `sync/state`, never silent zeros |
| `lib/haha-sync-core.mjs` | The sync: regular / nightly / light / poke / backfill. A failure never overwrites the last good data |
| `lib/haha-alerts.mjs` | Alert rules, throttling (once per condition until it clears), feed, email digest |
| `lib/haha-statement.mjs` | Host statement math + validation of `config/hosts` and `config/settings` |
| `lib/haha-views.mjs` | What the dashboard, Command and JARVIS read |
| `haha-sync.mjs` | Scheduled every 15 min. Kicks `haha-sync-background`; does nothing until `HAHA_APPKEY` is set |
| `haha-sync-background.mjs` | The worker (background function, 15 min limit) |
| `haha-backfill.mjs` | `POST {from, to?}` starts a day-by-day sales backfill; `GET` returns progress |
| `haha-webhook.mjs` | Webhook receiver (see below) |
| `haha-api.mjs` | JSON for the UI. `?view=summary` (add `&format=text` for plain text) is the JARVIS endpoint |
| `machines.html` | The dashboard: Today, Sales (+ order drill-down), Restock (+ Costco list), Statements (print / PDF), Settings |
| `command.html` | New **Machines** button: fleet summary + alerts, link to the full dashboard |
| `tests/` | `npm test`: 38 unit/integration tests against a fake HAHA built from the roadmap's shapes |
| `scripts/haha-probe.mjs` | First contact: saves one page of every read endpoint to `.haha-samples/` and lists missing fields |
| `scripts/haha-webhook-send.mjs` | Signs a sample webhook and POSTs it (`--replay`, `--bad-signature`, `--stale`, `--file`) |

All access needs the existing `DASH_KEY` (`X-Dash-Key` header). `machines.html` reuses the key Command already saved on the
phone. The webhook is the exception: HAHA signs it instead.

## Turn it on

1. **Phase 0 (you):** get the TEST `appkey` / `appsecret` from the HAHA Merchant Portal / support. Confirm the merchant
   timezone is Central.
2. Netlify env vars (Site configuration → Environment variables):
   - `HAHA_ENV=test`, `HAHA_APPKEY`, `HAHA_APPSECRET`
   - `HAHA_WEBHOOK_SECRET`: any long random string; give the same value to HAHA support in Phase 3
   - `HAHA_ALERT_TO`: comma-separated emails for the alert digest. Uses the existing `SMTP_*` / `BRIEF_FROM` settings
3. Locally: `npm ci && npm test`, then put the same vars in `.env` and run
   `node --env-file=.env scripts/haha-probe.mjs`. Read the `!` lines and the files in `.haha-samples/`.
4. `netlify dev` → open `http://localhost:8888/machines.html` → Settings → **Sync now**. Run it a second time: the
   "Shape warnings" box should be empty and nothing should change. Then **Backfill** from the first install date.
5. Settings → Hosts: tick each host's machines and enter rates. Fees: card % and per-sale fee, HAHA monthly fee.
6. Phase 3: give HAHA support `https://wraptvending.com/.netlify/functions/haha-webhook`, the secret, `api_version: v2`
   and the event list. Test locally first with
   `HAHA_WEBHOOK_SECRET=… node scripts/haha-webhook-send.mjs --replay`.
7. Switch to `HAHA_ENV=prod` with the prod key/secret once TEST looks right. The cached token is per environment.

## Webhooks: deliberately a "poke"

The receiver verifies the signature over the raw body bytes: constant-time compare, timestamp within 5 minutes,
otherwise 401. It drops repeats (`vdiHeader.requestId` + body hash), marks the resource dirty (`mmsSales` → sales,
`mmsPlanograms` → inventory, `mmsMarkets` → markets, `mmsRestocks` → restocks, `mmsProducts` → products) and kicks the
worker to re-pull it over REST. It replies 200 within about a second.

It does **not** parse the payload into sales or stock. The roadmap says the payload shapes differ from the REST
responses, and the payload pages couldn't be read. The latest body of each `vdiType` is saved under
`webhook/sample/{vdiType}`; Settings → Webhooks lists which types are there. With real samples, direct parsing is a small
addition in `haha-webhook.mjs`. The poke model already keeps the dashboard within seconds of a sale.

## Check on first contact (assumptions from the roadmap, not from HAHA's docs)

1. **Sales date filter.** `end_time` is sent as the day *after* the last day wanted, so the pull is complete whether HAHA
   reads it as inclusive or exclusive. Every sale is filed by its own `saleDtm` Central day. (Tested both ways.)
2. **Pagination.** Uses the `cursor` param (= previous `next_cursor`), `page`, `page_size=100`. An endpoint with no
   cursor is walked by page until a short page or `total`.
3. **Refunds.** Assumed to update the same `saleId` (upsert), with `isRefund` on the sale and/or items. Refund amounts
   are ex-tax: refunded items' `itemFinalPrice`, or the sale's `saleTotal` for a whole-sale refund. A fully refunded sale
   nets to $0. If HAHA instead sends a separate negative sale, `saleFigures` in `haha-data.mjs` is the one place to
   change.
4. **Status.** Only `PAID` (plus refunded sales) counts. Other statuses show in the order drill-down as "not counted".
5. **`saleTaxes`.** Expected to be a decimal string. Any other shape raises a warning and counts tax as 0 until mapped.
6. **Planogram capacity.** Looks for `{ productId, capacity }` anywhere in the layout. If none is found, restock uses the
   "≤ N units" rule and the sync warns.
7. **Products:** `productId`, `productName` (falls back to `name`), `price`, `cost`. **Inventory:** `productId`,
   `markets[]{marketId, marketName, stock, racks[]{name, stock}}`.
8. **Restock records:** filtered with `start_time` / `end_time`, keyed by `opLogId` (else `id`). They are filed by the
   month the sync first saw them, and shown as HAHA sends them.
9. **Auth:** a 401 triggers one token refresh. Rate limiting is HTTP 429 or envelope code `-429`.
10. **Webhook signature:** plain hex HMAC of the raw body in `X-Webhook-Signature`; unix seconds in
    `X-Webhook-Timestamp`.
11. **Online status:** taken from `isOnline` in `GET /markets`. `/online-status` is only called by the probe script.

## Where this differs from the roadmap

- `.mjs` functions and `lib/` helpers follow the repo's newer convention, e.g. `ops.js` → the agents' `.mjs` files.
- The 15-minute schedule kicks a background worker, as `agents-daily` does, because a scheduled function only gets
  30 seconds. The backfill also runs in that worker.
- **robots.txt is not given a Disallow** for `machines.html`. The repo's rule (see robots.txt) is noindex via header +
  meta, because a disallowed URL never gets its noindex read and can still be listed. Both the header and the meta are in
  place.
- Blobs keys have no `.json` suffix (`markets/latest`, `sales/2026-10-31`), matching the other stores.
- Alert digest email goes to the new `HAHA_ALERT_TO` env var (open question 4).

## Open questions (enter the answers in Settings, no code change needed)

1. Card processing fee (percent + per-transaction) and HAHA's monthly fee per machine. Until set, statements show
   "not configured" and count $0.
2. Commission rates for the two Tennessee Quick Cash stores. Seeded as hosts with no rate; their statements refuse to
   build until one is entered.
3. Restock threshold: default under 30% of capacity, or ≤ 2 units when capacity is unknown. Both are editable.
4. Alert digest recipients: `HAHA_ALERT_TO`.
