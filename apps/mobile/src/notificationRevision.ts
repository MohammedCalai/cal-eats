// Share read invalidation between the bell poll and every notification panel.
let revision = 0;
export const notificationRevision = () => revision;
export const invalidateNotifications = () => { revision += 1; };
