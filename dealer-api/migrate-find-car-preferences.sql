-- Adds structured make/model/year-range fields to find_car_leads, replacing
-- the old single free-text "considering" field's job of guessing whether the
-- client named one vehicle or a shortlist. `considering` stays, but now only
-- ever means "other makes/models also open to" (a real shortlist, not the
-- primary signal). `undecided` flags a client who said they don't know what
-- they want yet — those skip the automated pickVehicles/Auto.dev pipeline
-- entirely and get routed to a manual consult instead (see generateReportForLead).
ALTER TABLE find_car_leads ADD COLUMN preferred_make TEXT;
ALTER TABLE find_car_leads ADD COLUMN preferred_model TEXT;
ALTER TABLE find_car_leads ADD COLUMN year_min INTEGER;
ALTER TABLE find_car_leads ADD COLUMN year_max INTEGER;
ALTER TABLE find_car_leads ADD COLUMN undecided INTEGER NOT NULL DEFAULT 0;
