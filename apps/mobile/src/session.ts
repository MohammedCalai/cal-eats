import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "cal_eats_native_session_v1";

export const sessionStore = {
  get: () => SecureStore.getItemAsync(TOKEN_KEY),
  set: (token: string) => SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  clear: () => SecureStore.deleteItemAsync(TOKEN_KEY)
};
