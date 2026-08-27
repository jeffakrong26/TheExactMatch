-- "Currently Sourcing Buyers For" preview block (Sell My Car page) needs an
-- explicit, seller-given opt-in before any vehicle can be featured — the
-- same bar as a testimonial. feature_consent is set only by the seller
-- themselves (the form checkbox), never by admin. sourcing_status defaults
-- to 'draft' even when feature_consent = 1: admin has to actively promote a
-- submission before it's public, consent alone doesn't auto-publish it.
-- display_area is a short admin-written label ("Austin area") rather than
-- anything derived from the seller's zip, so a narrow zip can't become
-- identifying by accident.
ALTER TABLE sell_my_car_leads ADD COLUMN feature_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sell_my_car_leads ADD COLUMN sourcing_status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE sell_my_car_leads ADD COLUMN display_area TEXT;

-- Optional 3-6 "quick photos" a seller can attach at signup (final step of
-- the form) — separate from the structured valuation_photos slot system,
-- which still runs later via the post-submission /sell/upload/:token flow.
-- photo_token is generated for every lead (not just ones that use this) so
-- the photo-serving route never has to key off the lead's sequential id.
ALTER TABLE sell_my_car_leads ADD COLUMN quick_photos TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sell_my_car_leads ADD COLUMN photo_token TEXT;
