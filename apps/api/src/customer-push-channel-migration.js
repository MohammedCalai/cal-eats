export const customerPushChannelMigration58 = {version:58,name:"customer_push_android_channel",sql:`
ALTER TABLE customer_push_devices ADD COLUMN android_channel_id TEXT
 CHECK(android_channel_id IS NULL OR (platform='android' AND android_channel_id IN ('cal-eats-updates-quiet','cal-eats-updates-quiet-v2')));
`};
