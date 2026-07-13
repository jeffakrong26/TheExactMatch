# Dealer Partner Network

Buyer-lead-referral reps ("partners") layered on top of the existing Find My Car
pipeline. Naming note: everything here is prefixed `partner_` to stay clear of the
pre-existing, unrelated `dealers` table (the Sell-My-Car trade-in/inventory dealer
network — invite-based signup, its own Dealers tab). A "partner" is an individual
rep; a "dealer" (old sense) is a dealership account in the other pipeline.

## Approval → activation flow

1. A rep applies at `/partners-apply.html` (public, no invite needed). This creates
   a `partners` row with `status = 'pending'` — the application *is* the account
   signup (password already hashed, login just blocked until active).
2. It shows up in the admin dashboard (`Dealerportal.html` → **Partners** tab →
   *Partner Applications*), alongside an overlap flag if another active partner
   already covers the same market + zone (+ brand, for franchise reps).
3. Approve & Activate → `status = 'active'`, welcome email fires with login
   instructions. No separate invite link. Reject requires a structured reason and
   sends a reason-appropriate email; rejected rows stay queryable.
4. Once active, an admin still needs to capture the partner's Auto.dev dealer ID
   (**Find ID** button in the Active Partners table) before their inventory can
   actually surface in matching — Auto.dev has no exact-dealer-ID filter, only a
   non-unique name filter, so this is a manual confirm-by-eyeball step (same
   pattern as the existing `dealers.autodev_dealer_id` capture flow).

## Where to edit zone maps

`dealer-api/partner_zone_maps` (D1 table, `dealer-portal` database) — one row per
ZIP: `zip, market, zone, zone_label, zone_order`. To add a new market, insert rows
for that market's ZIPs; no code change needed. Houston (5 zones) and Austin (3
zones) are seeded in `dealer-api/seed-partners.sql` — the Austin ZIP list is a
first-pass, authored from public ZIP data during this build, same
"refine border cases later, non-blocking" caveat the spec gave Houston's list.
Apply changes with:

```
npx wrangler d1 execute dealer-portal --remote --file=your-zone-update.sql
```

## Where to edit tunable config

`dealer-api/partner_config` (D1 table, key/value, JSON-encoded values) — every
timeout, rating delta, matching tolerance, boost weight, fee window, and email
cadence lives here (see `seed-partners.sql` for the full list with descriptions).
Change a value with:

```sql
UPDATE partner_config SET value = '5' WHERE key = 'verify_reminder_3h_hours';
```

No redeploy required — `getPartnerConfig(env)` reads this table on every relevant
request/sweep. `PARTNER_CONFIG_DEFAULTS` in `src/index.js` is only a fallback for a
key that's somehow missing from the table.

## Auto.dev params/fields note

Confirmed live against the current Auto.dev account (not assumed from docs):
listing search filters use `vehicle.make/model/year`, `retailListing.price/miles/
used/dealer`, plus `zip`/`distance`/`limit` — **not** Marketcheck's old param
names. There is no exact-dealer-ID filter server-side (`retailListing.dealerId`
returns 400 if you try) — dealer attribution only ever works by searching on
`retailListing.dealer` (name, not unique) and then filtering the response by the
admin-confirmed `autodev_dealer_id`. Single-VIN re-pull (used by partner
verification) is `GET https://api.auto.dev/listings/{vin}` → `{data: {...}}`,
confirmed against current docs.auto.dev.

## Integration decisions worth knowing about

- **Matching**: partner-first ranking is layered into the *existing* Find My Car
  report-generation pipeline (`generateReportForLead` → `searchAutodevListings` →
  `partitionByPartnerDealer`), not a parallel system. New-car requests only pull in
  franchise partners carrying that brand; used-car requests pull in any active
  partner. Rating only breaks near-ties within the same ~10-mile distance tier
  (`matching_rating_tiebreak_threshold`, in miles) — it never outranks a
  meaningfully better-fitting car.
- **Trigger point**: a buyer's "interested" click on a Find My Car report vehicle
  (`report_vehicles.matched_partner_id` set at report-generation time) is what
  starts the whole partner-lead pipeline. There's no separate buyer-facing partner
  search — Find My Car already is the buyer's search surface.
- **Admin CRM**: "mirrored to admin CRM" means the existing separate
  `theexactmatch-crm` Worker. A `find_my_car` deal already exists for this buyer
  from their original lead submission; partner-lead status changes are logged as
  touches on that same deal, and its coarse 8-stage `stage` only moves at real
  terminal points (verified → `negotiation`, won → `closed_won`, lost →
  `closed_lost`, fee paid → `referral_fee_collected` — that last stage existed in
  the CRM schema already, unused until now). `HOOK_SETTABLE_FIELDS` in
  `crm/src/index.js` gained `dealer_id`/`dealer_name`/`fee_collected`/
  `fee_collected_at` to support this.
- **Fee due-date sweep**: past-due fees surface in the admin Fees table (sorted
  owed-first, overdue rows flagged) rather than auto-deactivating a partner —
  deactivation stays a manual admin action from the Active Partners table.
- **"Went dark"**: charged once, at most, per lead — the first time a lead sits
  ≥2× the 3-day nudge window past that nudge with zero status movement. Checked
  against `partner_rating_events` to avoid double-charging on later sweeps.
- **Clean-cycle bonus**: awarded at `won_delivered` when the lead was verified
  within 1 hour AND never needed a status nudge.
- **Frequent cron**: a new `*/15 * * * *` trigger drives the verification/nudge
  sweep (`sweepPartnerTimers`); the original daily `0 6 * * *` cron still does the
  unrelated stale-record cleanup. `scheduled()` branches on `event.cron` to tell
  them apart — same Worker, no new deployment target.
- **Rate limiting / anti-spam** on `/partners/apply`: a lightweight D1-backed
  attempts table + honeypot field, since no CAPTCHA/Turnstile or rate-limiting
  pattern existed anywhere in this repo before now.
