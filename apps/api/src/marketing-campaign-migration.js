export const marketingCampaignMigration32 = {
  version: 32,
  name: "marketing_campaign_mechanics_and_weekly_budget",
  sql: `
ALTER TABLE offer_campaigns ADD COLUMN campaign_type TEXT;
ALTER TABLE offer_campaigns ADD COLUMN campaign_rules TEXT NOT NULL DEFAULT '{}';
ALTER TABLE offer_campaigns ADD COLUMN weekly_budget_minor INTEGER CHECK(weekly_budget_minor IS NULL OR weekly_budget_minor>0);
ALTER TABLE offer_grants ADD COLUMN reserved_week_start TEXT;
UPDATE offer_grants SET reserved_discount_minor=COALESCE((SELECT c.item_value_minor FROM offer_campaigns c WHERE c.id=offer_grants.campaign_id AND c.offer_type='free_item'),0)
WHERE reserved_discount_minor=0 AND status IN ('reserved','redeemed') AND campaign_id IN (SELECT id FROM offer_campaigns WHERE offer_type='free_item');
CREATE INDEX offer_grants_weekly_budget_idx ON offer_grants(campaign_id,reserved_week_start,status);
`
};
