-- Adds the buyer's preferred contact method (text/email/call) to find_car_leads,
-- captured by the new field on the Find My Car form's final (contact) step.
ALTER TABLE find_car_leads ADD COLUMN preferred_contact_method TEXT NOT NULL DEFAULT '';
