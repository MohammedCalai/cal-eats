import { useEffect, useRef } from "react";
import { Alert, BackHandler, Platform } from "react-native";
import { createAndroidBackStack, requestBackNavigation } from "./android-back-policy";

const screenBack = createAndroidBackStack();
export const dispatchAndroidScreenBack = () => screenBack.dispatch();

/** The root handler can dispatch this stack before its tab fallback. */
export function useAndroidBack(close: () => void, { enabled = true, blocked = false, dirty = false, priority = 10 } = {}) {
  const latest = useRef({ close, enabled, blocked, dirty });
  latest.current = { close, enabled, blocked, dirty };
  const confirming = useRef(false);
  function requestBack() {
    const current = latest.current;
    if (!current.enabled) return false;
    return requestBackNavigation({ ...current, confirmDiscard: proceed => {
      if (confirming.current) return;
      confirming.current = true;
      const reset = () => { confirming.current = false; };
      Alert.alert("Discard unsaved changes?", "Your unsent message or changes will be lost.", [
        { text: "Keep editing", style: "cancel", onPress: reset },
        { text: "Discard", style: "destructive", onPress: () => { reset(); if (!latest.current.blocked) proceed(); } }
      ], { cancelable: true, onDismiss: reset });
    } });
  }
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const unregister = screenBack.register(requestBack, priority);
    const listener = BackHandler.addEventListener("hardwareBackPress", dispatchAndroidScreenBack);
    return () => { unregister(); listener.remove(); };
  }, [priority]);
  return requestBack;
}
