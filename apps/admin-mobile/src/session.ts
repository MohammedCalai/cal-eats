import * as SecureStore from "expo-secure-store";
const KEY = "cal_eats_business_session_v1";
export const sessionStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (token: string) => SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  clear: () => SecureStore.deleteItemAsync(KEY)
};

export const restaurantPreference = {
  async get(userId: string) { try { return await SecureStore.getItemAsync(`cal_eats_restaurant_${userId}`); } catch { return null; } },
  async set(userId: string, restaurantId: string) { try { await SecureStore.setItemAsync(`cal_eats_restaurant_${userId}`, restaurantId); } catch { /* Optional preference; membership is rechecked at sign-in. */ } }
};
