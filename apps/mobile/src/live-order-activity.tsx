import type { LiveOrderFactory } from "./live-activity-controller";
// Matching .tsx suffix ensures Metro selects .ios.tsx before the generic file.
// Android/browser previews
// keep ordinary order screens and notifications, without widgets or new prompts.
export const liveOrderFactory: LiveOrderFactory = { getInstances: () => [], start: () => { throw Error("Live Orders require the installed iPhone app."); } };
export const liveOrderActivitiesSupported = false;
