export const offerDismissalMigration33={
  version:33,
  name:"customer_offer_dismissal",
  sql:`
ALTER TABLE offer_grants ADD COLUMN dismissed_at TEXT;
CREATE INDEX offer_grants_customer_inbox_idx ON offer_grants(customer_id,dismissed_at,created_at DESC,id DESC);
`
};
