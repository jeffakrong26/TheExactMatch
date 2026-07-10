-- Sell My Car valuation rework: hard title/accident discounts computed in
-- code (not left to an unconstrained LLM guess), a fourth customer-facing
-- value (Cash/Quick Sell), a low-confidence flag for admin review, and a
-- manual-adjustment audit trail.

-- Snapshot of title status at valuation time (mirrors accident_history/
-- general_condition/mechanical_status, which already snapshot this way).
ALTER TABLE vehicle_valuations ADD COLUMN title_status TEXT;

-- Cash/Quick Sell — separate from Trade-In (existing final_trade_in_value)
-- since dealers price a no-obligation cash buy slightly differently than a
-- trade-in-toward-another-purchase.
ALTER TABLE vehicle_valuations ADD COLUMN final_cash_value INTEGER;

-- Records exactly what the code-computed discount pipeline did, so
-- real-case calibration (comparing our numbers against actual Carvana/
-- CarMax instant offers) has something concrete to look at later.
ALTER TABLE vehicle_valuations ADD COLUMN valuation_breakdown TEXT;

-- Set true whenever title_status is anything but clean, or accident_history
-- is major — tells admin to eyeball this one before approving.
ALTER TABLE vehicle_valuations ADD COLUMN low_confidence INTEGER NOT NULL DEFAULT 0;

-- Audit trail distinguishing AI-original valuations from admin-corrected
-- ones.
ALTER TABLE vehicle_valuations ADD COLUMN manually_adjusted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicle_valuations ADD COLUMN manually_adjusted_at TEXT;
ALTER TABLE vehicle_valuations ADD COLUMN manually_adjusted_by TEXT;
