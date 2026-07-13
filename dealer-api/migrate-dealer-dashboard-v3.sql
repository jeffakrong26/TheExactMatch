-- Buyer Leads follow-up: Closed Deals tab, payout-request tracking on fees.
-- Paid status itself still flows from the CRM (admin marks paid there); this
-- only tracks whether the dealer has told us they submitted a payout request,
-- or why not yet, so a stalled payout is visible before it goes overdue.
ALTER TABLE partner_fees ADD COLUMN payout_requested_at TEXT;
ALTER TABLE partner_fees ADD COLUMN payout_not_requested_reason TEXT;   -- waiting_paperwork | waiting_title | waiting_on_accounting | other
ALTER TABLE partner_fees ADD COLUMN payout_not_requested_notes TEXT;
