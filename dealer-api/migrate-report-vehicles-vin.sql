-- report_vehicles never stored the matched listing's VIN, even though
-- Auto.dev's mapped listing object always has one — buildVehicleEntry just
-- never carried it through to the INSERT. Needed for: the partner
-- verification single-VIN re-pull, and generally useful for admin/debugging.
-- Existing 42 rows get NULL (no way to recover a VIN not captured at match
-- time); new reports populate it going forward.
ALTER TABLE report_vehicles ADD COLUMN vin TEXT;
