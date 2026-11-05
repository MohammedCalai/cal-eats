export const businessMessageAttentionMigration41 = {
  version: 41,
  name: "business_message_arrival_sequence",
  sql: `
CREATE TABLE business_message_arrivals (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT NOT NULL UNIQUE REFERENCES user_notifications(id) ON DELETE CASCADE
);
INSERT INTO business_message_arrivals(notification_id)
  SELECT n.id FROM user_notifications n JOIN users u ON u.id=n.user_id
  WHERE u.role='restaurant' AND n.type IN ('order_message','customer_message')
  ORDER BY n.rowid;
CREATE TRIGGER business_message_arrival_insert AFTER INSERT ON user_notifications
  WHEN NEW.type IN ('order_message','customer_message')
    AND EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND role='restaurant')
  BEGIN
    INSERT INTO business_message_arrivals(notification_id) VALUES(NEW.id);
  END;
`
};
