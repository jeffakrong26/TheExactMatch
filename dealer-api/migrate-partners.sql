-- Dealer Partner Network (buyer-lead-referral reps). Prefixed `partner_` throughout
-- to stay clear of the existing, unrelated `dealers` table (the Sell-My-Car
-- trade-in/inventory dealer network with its own invite-based signup and portal
-- tab). A "partner" here is an individual rep, not a dealership account.
--
-- report_vehicles gets one new column (matched_partner_id) so a buyer's
-- "interested" click on an existing Find My Car report vehicle
-- (POST /api/public/reports/:code/vehicles/:position/interest) can tell,
-- possibly days after report generation, whether that specific matched
-- listing came from a registered partner's inventory — that's the trigger
-- point for the whole verification/lead pipeline below. No new buyer-facing
-- "search" surface is introduced; Find My Car remains the only buyer search.

CREATE TABLE partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,          -- login username
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL DEFAULT '',
  phone TEXT,

  dealership_name TEXT NOT NULL,
  dealership_website TEXT,
  autodev_dealer_id TEXT,              -- captured by admin, same lookup-and-confirm
                                        -- pattern as dealers.autodev_dealer_id — Auto.dev
                                        -- has no exact dealerId filter, only a non-unique
                                        -- name filter, so this must be admin-confirmed.
  zip TEXT NOT NULL,
  city TEXT,
  state TEXT,
  market TEXT,                         -- derived from zip via partner_zone_maps; e.g. "Houston"
                                        -- or "Dallas (unmapped)" when no zone map exists yet
  zone TEXT,                           -- derived from zip via partner_zone_maps; NULL if
                                        -- market unmapped (never blocks signup)
  market_unmapped INTEGER NOT NULL DEFAULT 0,

  dealership_type TEXT NOT NULL,       -- franchise_new_used | independent_used | used_superstore
  brands_new TEXT,                     -- JSON array of strings; null/empty for independents
  used_scope TEXT NOT NULL,            -- all_makes | mostly_own_brand
  role TEXT NOT NULL,                  -- salesperson | sales_manager | internet_bdc | gm
  monthly_units INTEGER,

  fee_type TEXT NOT NULL,              -- flat | percent
  fee_amount REAL NOT NULL,            -- dollars if flat, percent (e.g. 2.5) if percent
  fee_percent_basis TEXT,              -- sale_price | front_gross (only when fee_type='percent')

  referral_policy_status TEXT NOT NULL, -- has_policy | no_but_open | not_sure
  referral_policy_notes TEXT,
  referral_contact TEXT,

  lead_contact_method TEXT NOT NULL,   -- email | text | both
  anything_else TEXT,

  overlap_flag INTEGER NOT NULL DEFAULT 0,   -- computed at signup: same market+zone+brand
  overlap_notes TEXT,                        -- as an existing active partner

  status TEXT NOT NULL DEFAULT 'pending',    -- pending | active | rejected | deactivated
  rejected_reason TEXT,                      -- zone_already_covered | brand_already_covered |
                                              -- units_too_low | no_referral_policy |
                                              -- incomplete_unverifiable | other
  rejected_notes TEXT,
  rejected_at TEXT,

  rating REAL NOT NULL DEFAULT 10.0,
  rating_lead_count INTEGER NOT NULL DEFAULT 0,  -- verified-lead count; gates when rating
                                                  -- starts influencing matching (grace window)

  departure_flag INTEGER NOT NULL DEFAULT 0,
  replacement_referral TEXT,

  agreed_terms_at TEXT NOT NULL,
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_partners_status ON partners(status);
CREATE INDEX idx_partners_market_zone ON partners(market, zone);
CREATE INDEX idx_partners_autodev_dealer_id ON partners(autodev_dealer_id);

CREATE TABLE partner_sessions (
  id TEXT PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tokened password-reset links (day-one requirement, Section 14).
CREATE TABLE partner_password_resets (
  token TEXT PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A buyer's interest in one specific partner-sourced listing. Created the
-- moment publicExpressReportInterest fires on a report_vehicles row whose
-- matched_partner_id is set. Buyer contact fields are snapshotted from the
-- originating find_car_leads row (same denormalize-for-display convention
-- vehicle_valuations/report_vehicles already use for dealer_name/city/state),
-- not a new buyers table.
CREATE TABLE partner_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  report_vehicle_id INTEGER NOT NULL REFERENCES report_vehicles(id) ON DELETE CASCADE,
  partner_id INTEGER NOT NULL REFERENCES partners(id),

  buyer_name TEXT,
  buyer_email TEXT,
  buyer_phone TEXT,
  buyer_zip TEXT,

  vehicle_vin TEXT,
  listing_snapshot TEXT,                -- JSON, frozen at interest-time from report_vehicles

  market TEXT,
  zone TEXT,

  status TEXT NOT NULL DEFAULT 'interested',
  -- interested | pending_verification | verified | video_sent |
  -- test_drive_scheduled | negotiations | still_shopping |
  -- won_delivered | won_delivery_pending | lost

  test_drive_location TEXT,              -- home | dealership
  lost_reason TEXT,                       -- wrong_car | price | other
  lost_reason_notes TEXT,

  interested_at TEXT NOT NULL DEFAULT (datetime('now')),
  pending_verification_at TEXT,
  verified_at TEXT,
  video_sent_at TEXT,
  test_drive_scheduled_at TEXT,
  negotiations_at TEXT,
  still_shopping_at TEXT,
  won_delivered_at TEXT,
  won_delivery_pending_at TEXT,
  lost_at TEXT,

  verification_deadline TEXT,            -- interested_at + config verify_timeout_hours
  verify_reminder_3h_sent_at TEXT,
  verify_reminder_8h_sent_at TEXT,
  verify_admin_escalated_at TEXT,
  verify_timed_out_at TEXT,

  buyer_holding_email_sent_at TEXT,       -- T+5h "still confirming" email
  buyer_reroute_email_sent_at TEXT,       -- T+24h "couldn't confirm, other options" email

  status_nudge_24h_sent_at TEXT,
  status_nudge_3d_sent_at TEXT,
  status_nudge_still_shopping_last_sent_at TEXT,

  last_lifecycle_email_sent_at TEXT,      -- de-dupe: max one lifecycle email / 24-48h

  crm_deal_id INTEGER,                    -- id of the mirrored deal in the separate
                                           -- theexactmatch-crm Worker's D1 (cross-DB,
                                           -- no FK — same convention deals.dealer_id
                                           -- already uses in reverse)

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_partner_leads_partner_id ON partner_leads(partner_id);
CREATE INDEX idx_partner_leads_status ON partner_leads(status);
CREATE INDEX idx_partner_leads_verification_deadline ON partner_leads(verification_deadline);
CREATE UNIQUE INDEX idx_partner_leads_report_vehicle_id ON partner_leads(report_vehicle_id);

CREATE TABLE partner_fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_lead_id INTEGER NOT NULL REFERENCES partner_leads(id) ON DELETE CASCADE,
  partner_id INTEGER NOT NULL REFERENCES partners(id),

  fee_type TEXT NOT NULL,               -- flat | percent (copied from partners at verified time)
  fee_amount REAL,                      -- flat dollar amount, known immediately
  fee_percent REAL,                     -- percent rate, known immediately
  fee_percent_basis TEXT,               -- sale_price | front_gross
  dollar_amount REAL,                   -- fills at reconciliation once sale price is known
                                         -- (immediately, for flat; later, for percent)

  status TEXT NOT NULL DEFAULT 'pending', -- pending | owed | paid | written_off
  owed_at TEXT,
  due_date TEXT,                        -- owed_at + 30 days
  paid_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_partner_fees_partner_id ON partner_fees(partner_id);
CREATE INDEX idx_partner_fees_status ON partner_fees(status);
CREATE UNIQUE INDEX idx_partner_fees_partner_lead_id ON partner_fees(partner_lead_id);

-- Audit trail so the rating stays explainable and its weights stay tunable
-- (Section 11) without losing the history of why a given partner is where
-- they are.
CREATE TABLE partner_rating_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_lead_id INTEGER REFERENCES partner_leads(id) ON DELETE SET NULL,
  type TEXT NOT NULL,       -- verify_0to1h | verify_1to3h | verify_3to8h | verify_8to24h |
                            -- verify_timeout | update_no_nudge | update_after_nudge |
                            -- went_dark | stale_car | clean_cycle
  delta REAL NOT NULL,
  rating_after REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_partner_rating_events_partner_id ON partner_rating_events(partner_id);

-- market -> zone -> zip config. One row per zip (zips don't repeat across
-- markets nationally, so zip alone is a safe primary key). Adding a new
-- market later is purely INSERTs here — no code change.
CREATE TABLE partner_zone_maps (
  zip TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  zone TEXT NOT NULL,           -- short key, e.g. 'zone_1'
  zone_label TEXT NOT NULL,     -- e.g. 'Central/Loop'
  zone_order INTEGER NOT NULL   -- display/priority order within the market
);

CREATE INDEX idx_partner_zone_maps_market ON partner_zone_maps(market);

-- All tunable values from the spec (timeouts, rating deltas, tolerances,
-- boost, fee window, email cadence) live here instead of as literals, so
-- Jeff can retune from the admin UI without a redeploy. `value` is always
-- JSON-encoded (numbers, strings, or small objects) so one column serves
-- every config shape.
CREATE TABLE partner_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Buyer's "interested" click on a Find My Car report vehicle
-- (report_vehicles row) is the trigger for the entire partner lead pipeline.
-- This column records which partner (if any) actually sourced that specific
-- matched listing, set at report-generation time in buildVehicleEntry —
-- independent of the older, unrelated dealers.autodev_dealer_id boost, which
-- has no per-row persistence and stays untouched.
ALTER TABLE report_vehicles ADD COLUMN matched_partner_id INTEGER REFERENCES partners(id);

-- Read-tracking for the admin inbox's new "Partner Applications" tab follows
-- the exact existing admin_seen_items/notification-counts convention (see
-- the 'dealers' section, which reads directly off the dealers table) —
-- section = 'partner_applications', item_id = partners.id. No separate
-- inbox/application table: a pending partners row *is* the application
-- (Section 4: "application = signup").
