export const printerManagementMigration34 = {
  version: 34,
  name: "printer_management_details",
  sql: `
ALTER TABLE restaurant_printers ADD COLUMN mac_address TEXT;
ALTER TABLE restaurant_printers ADD COLUMN ip_address TEXT;
CREATE UNIQUE INDEX restaurant_printer_active_mac ON restaurant_printers(restaurant_id,mac_address) WHERE mac_address IS NOT NULL AND revoked_at IS NULL;
`
};
