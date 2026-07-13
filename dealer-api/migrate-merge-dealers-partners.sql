-- Correction: "dealers" and "partners" are the same real-world entity — the
-- separate `partners`/`partner_sessions` tables were a semantic misreading,
-- not a deliberate second account type. This merges partner data/behavior
-- directly onto the existing `dealers` table and removes the duplicate
-- identity tables. Confirmed empty before running: partners, partner_leads,
-- partner_fees, partner_sessions, partner_rating_events,
-- partner_lifecycle_email_queue (all 0 rows) — nothing to migrate, only
-- structure to fix. dealers has 4 real rows; report_vehicles has 42 real
-- rows — both handled without data loss below.

-- ── Extend dealers with everything partners.sql added ──────────────
ALTER TABLE dealers ADD COLUMN market TEXT;
ALTER TABLE dealers ADD COLUMN zone TEXT;
ALTER TABLE dealers ADD COLUMN market_unmapped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dealers ADD COLUMN dealership_type TEXT;
ALTER TABLE dealers ADD COLUMN brands_new TEXT;
ALTER TABLE dealers ADD COLUMN used_scope TEXT;
ALTER TABLE dealers ADD COLUMN monthly_units INTEGER;
ALTER TABLE dealers ADD COLUMN fee_type TEXT;
ALTER TABLE dealers ADD COLUMN fee_amount REAL;
ALTER TABLE dealers ADD COLUMN fee_percent_basis TEXT;
ALTER TABLE dealers ADD COLUMN referral_policy_status TEXT;
ALTER TABLE dealers ADD COLUMN referral_policy_notes TEXT;
ALTER TABLE dealers ADD COLUMN referral_contact TEXT;
ALTER TABLE dealers ADD COLUMN lead_contact_method TEXT;
ALTER TABLE dealers ADD COLUMN anything_else TEXT;
ALTER TABLE dealers ADD COLUMN overlap_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dealers ADD COLUMN overlap_notes TEXT;
ALTER TABLE dealers ADD COLUMN rejected_reason TEXT;
ALTER TABLE dealers ADD COLUMN rejected_notes TEXT;
ALTER TABLE dealers ADD COLUMN rejected_at TEXT;
ALTER TABLE dealers ADD COLUMN rating REAL NOT NULL DEFAULT 10.0;
ALTER TABLE dealers ADD COLUMN rating_lead_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dealers ADD COLUMN departure_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dealers ADD COLUMN replacement_referral TEXT;
ALTER TABLE dealers ADD COLUMN agreed_terms_at TEXT;
ALTER TABLE dealers ADD COLUMN activated_at TEXT;
ALTER TABLE dealers ADD COLUMN signup_ip TEXT;
-- Existing invite-signed-up dealers were never "pending" — backfill so the
-- new pending/active/rejected/deactivated vocabulary reads correctly for them.
UPDATE dealers SET activated_at = created_at WHERE status = 'active' AND activated_at IS NULL;

-- ── report_vehicles.matched_partner_id: repoint REFERENCES partners(id) ->
-- dealers(id). SQLite can't ALTER a column's REFERENCES clause in place, so
-- this is the standard safe recreate-and-copy (all 42 existing rows
-- preserved; matched_partner_id is NULL on every one of them today since
-- `partners` was always empty, so there's nothing to remap).
CREATE TABLE report_vehicles_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES find_car_reports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  year INTEGER,
  make TEXT,
  model TEXT,
  trim TEXT,
  rationale TEXT,
  price INTEGER,
  mileage INTEGER,
  dealer_name TEXT,
  dealer_city TEXT,
  dealer_state TEXT,
  vdp_url TEXT,
  source TEXT,
  verified TEXT,
  interested INTEGER NOT NULL DEFAULT 0,
  interested_at TEXT,
  engine TEXT, transmission TEXT, drivetrain TEXT, city_mpg INTEGER, highway_mpg INTEGER, exterior_color TEXT, exterior_color_options TEXT,
  safety_rating TEXT, cargo_space TEXT, seating_capacity INTEGER, warranty TEXT, notable_features TEXT, photo_url TEXT, search_log TEXT, photo_urls TEXT,
  ready INTEGER NOT NULL DEFAULT 0, ready_at TEXT, white_glove_requested INTEGER NOT NULL DEFAULT 0, white_glove_requested_at TEXT, white_glove_fee INTEGER,
  photos_missing INTEGER NOT NULL DEFAULT 0,
  matched_partner_id INTEGER REFERENCES dealers(id)
);
INSERT INTO report_vehicles_new SELECT * FROM report_vehicles;
DROP TABLE report_vehicles;
ALTER TABLE report_vehicles_new RENAME TO report_vehicles;

-- ── Drop the duplicate identity tables (children first; all confirmed empty) ──
DROP TABLE partner_lifecycle_email_queue;
DROP TABLE partner_rating_events;
DROP TABLE partner_fees;
DROP TABLE partner_leads;
DROP TABLE partner_sessions;
DROP TABLE partner_password_resets;
DROP TABLE partners;

-- ── Recreate the relationship tables against dealers(id) instead ──────
CREATE TABLE partner_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_vehicle_id INTEGER NOT NULL REFERENCES report_vehicles(id) ON DELETE CASCADE,
  partner_id INTEGER NOT NULL REFERENCES dealers(id),

  buyer_name TEXT,
  buyer_email TEXT,
  buyer_phone TEXT,
  buyer_zip TEXT,

  vehicle_vin TEXT,
  listing_snapshot TEXT,

  market TEXT,
  zone TEXT,

  status TEXT NOT NULL DEFAULT 'interested',
  test_drive_location TEXT,
  lost_reason TEXT,
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

  verification_deadline TEXT,
  verify_reminder_3h_sent_at TEXT,
  verify_reminder_8h_sent_at TEXT,
  verify_admin_escalated_at TEXT,
  verify_timed_out_at TEXT,

  buyer_holding_email_sent_at TEXT,
  buyer_reroute_email_sent_at TEXT,

  status_nudge_24h_sent_at TEXT,
  status_nudge_3d_sent_at TEXT,
  status_nudge_still_shopping_last_sent_at TEXT,

  last_lifecycle_email_sent_at TEXT,

  crm_deal_id INTEGER,

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
  partner_id INTEGER NOT NULL REFERENCES dealers(id),

  fee_type TEXT NOT NULL,
  fee_amount REAL,
  fee_percent REAL,
  fee_percent_basis TEXT,
  dollar_amount REAL,

  status TEXT NOT NULL DEFAULT 'pending',
  owed_at TEXT,
  due_date TEXT,
  paid_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_partner_fees_partner_id ON partner_fees(partner_id);
CREATE INDEX idx_partner_fees_status ON partner_fees(status);
CREATE UNIQUE INDEX idx_partner_fees_partner_lead_id ON partner_fees(partner_lead_id);

CREATE TABLE partner_rating_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  partner_lead_id INTEGER REFERENCES partner_leads(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  delta REAL NOT NULL,
  rating_after REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_partner_rating_events_partner_id ON partner_rating_events(partner_id);

CREATE TABLE partner_lifecycle_email_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_lead_id INTEGER NOT NULL REFERENCES partner_leads(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  white_glove INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  sent_at TEXT
);
CREATE INDEX idx_partner_lifecycle_email_queue_status ON partner_lifecycle_email_queue(status);

-- Renamed from partner_password_resets — this is a general dealer capability
-- now, not partner-specific (dealers never had password reset before).
CREATE TABLE dealer_password_resets (
  token TEXT PRIMARY KEY,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
