-- Sell My Car automation: valuation pipeline (VIN decode, Marketcheck comps,
-- Claude synthesis, photo-confirmed re-valuation). One row per sell_my_car_leads lead.
-- `token` is the unique tokenized link sent in Brevo email #1 for photo upload.
CREATE TABLE vehicle_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES sell_my_car_leads(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,

  -- VIN + decode
  vin TEXT,
  decoded_year INTEGER,
  decoded_make TEXT,
  decoded_model TEXT,
  decoded_trim TEXT,
  decoded_engine TEXT,
  decoded_drivetrain TEXT,
  decoded_body_type TEXT,
  decode_raw TEXT, -- full VIN decode API response, json

  mileage INTEGER,

  -- self-reported condition, captured once at submission
  accident_history TEXT NOT NULL DEFAULT 'none', -- none|minor|moderate|major
  accident_notes TEXT,
  general_condition TEXT, -- excellent|good|fair|poor
  mechanical_status TEXT, -- running well|needs work|not running
  mechanical_notes TEXT,

  -- comps
  marketcheck_comps TEXT, -- json array of comparable active listings
  marketcheck_log TEXT, -- json array, search radius/query log (mirrors report_vehicles.search_log)

  -- valuation (Claude synthesis; self-reported basis initially, re-run after photos)
  final_retail_value INTEGER,
  final_trade_in_value INTEGER,
  final_private_sale_value INTEGER,
  valuation_reasoning TEXT, -- json: { retail, trade_in, private_sale } reasoning strings

  -- photo-confirmed condition scoring, populated after photo upload
  ai_condition_score TEXT, -- json: per-area scores + mismatch flags vs self-reported
  photo_confirmed INTEGER NOT NULL DEFAULT 0,
  photos_uploaded_at TEXT,

  status TEXT NOT NULL DEFAULT 'pending_photos', -- pending_photos|photos_received|valued
  customer_notified_at TEXT, -- set when Brevo email #2 (value range) sends
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vehicle_valuations_lead_id ON vehicle_valuations(lead_id);
