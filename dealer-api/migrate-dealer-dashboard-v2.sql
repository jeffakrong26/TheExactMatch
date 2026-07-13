-- Dealer Portal redesign: Buyer Leads (verify/active/fees tabs), Seller Leads
-- (offer-or-message interest + dealer-visible flags), and Submit to Highlights
-- (manual entry + mark-as-sold on the dealer's own submissions).

-- Buyer Leads: a free-text note the dealer can leave on a lead while
-- verifying availability or working an active deal (separate from the
-- structured lost_reason_notes, which only exists on the terminal 'lost' path).
ALTER TABLE partner_leads ADD COLUMN notes TEXT;

-- Seller Leads: "I'm Interested" now captures either an offer amount or a
-- free-text message, plus an optional dealer flag back to Jeff (needs more
-- photos, estimate looks too high, etc.) — and can be re-submitted later to
-- adjust the offer/notes from the "Interested" tab.
ALTER TABLE lead_interest ADD COLUMN offer_amount REAL;
ALTER TABLE lead_interest ADD COLUMN message TEXT;
ALTER TABLE lead_interest ADD COLUMN flag_reason TEXT;   -- more_pics | estimate_too_high | need_info | other
ALTER TABLE lead_interest ADD COLUMN flag_notes TEXT;
-- SQLite/D1 rejects ADD COLUMN with a non-constant default (datetime('now')),
-- so this stays nullable; expressInterest sets it explicitly on every write.
ALTER TABLE lead_interest ADD COLUMN updated_at TEXT;

-- Submit to Highlights: track how a submission came in (link fetch vs. manual
-- entry, which requires the dealer to attach photos themselves) and let a
-- dealer mark their own submission sold without admin involvement.
ALTER TABLE inventory_submissions ADD COLUMN submission_method TEXT NOT NULL DEFAULT 'link';
ALTER TABLE inventory_submissions ADD COLUMN sold_at TEXT;
