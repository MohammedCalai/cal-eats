import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";

let installationPromise: Promise<string> | null = null;
// Shared by normal phone notifications and ActivityKit. Live Activities do not
// require the separate permission for notification banners/sounds.
export function getInstallationId(): Promise<string> {
  if (!installationPromise) installationPromise = (async () => {
    const key = "cal_eats_push_installation_v1", saved = await SecureStore.getItemAsync(key);
    if (saved && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved)) return saved;
    const value = randomUUID();
    await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
    return value;
  })().catch(error => { installationPromise = null; throw error; });
  return installationPromise;
}
