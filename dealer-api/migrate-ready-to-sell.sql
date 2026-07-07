-- Hosted seller report: "Ready to Sell" CTA, mirrors report_vehicles.ready/ready_at
-- on the Find My Car side.
ALTER TABLE vehicle_valuations ADD COLUMN ready_to_sell INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicle_valuations ADD COLUMN ready_to_sell_at TEXT;
