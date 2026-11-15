import * as SecureStore from "expo-secure-store";
const KEY = "cal_eats_business_session_v1";
let writes=Promise.resolve();
const serial=(operation:()=>Promise<void>)=>{const work=writes.then(operation,operation);writes=work.catch(()=>undefined);return work;};
export const sessionStore = {
  get: async () => {await writes;return SecureStore.getItemAsync(KEY);},
  set: (token: string,isCurrent=()=>true) => serial(async()=>{if(!isCurrent())return;await SecureStore.setItemAsync(KEY,token,{keychainAccessible:SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY});if(!isCurrent())await SecureStore.deleteItemAsync(KEY);}),
  clear: () => serial(()=>SecureStore.deleteItemAsync(KEY))
};

export const restaurantPreference = {
  async get(userId: string) { try { return await SecureStore.getItemAsync(`cal_eats_restaurant_${userId}`); } catch { return null; } },
  async set(userId: string, restaurantId: string) { try { await SecureStore.setItemAsync(`cal_eats_restaurant_${userId}`, restaurantId); } catch { /* Optional preference; membership is rechecked at sign-in. */ } }
};
