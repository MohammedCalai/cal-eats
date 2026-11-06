import { useEffect, useRef, useState } from "react";
import { Keyboard, ScrollView } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { createThreadScroll } from "./thread-scroll";

export function useThreadScroll(scope: object, enabled = true) {
  const ref = useRef<ScrollView>(null), currentScope = useRef(scope), visible = useRef(enabled);
  currentScope.current = scope; visible.current = enabled;
  const [following, setFollowing] = useState(true);
  const current = useRef<ReturnType<typeof createThreadScroll> | null>(null);

  useEffect(() => {
    const controller = createThreadScroll({
      requestFrame: requestAnimationFrame, cancelFrame: cancelAnimationFrame,
      scrollToLatest: () => ref.current?.scrollToEnd({ animated: false }),
      onFollowingChange: setFollowing,
      isCurrent: () => currentScope.current === scope && visible.current
    });
    current.current = controller;
    setFollowing(true);
    if (enabled) controller.requestLatest();
    const subscriptions = enabled ? ["keyboardDidShow", "keyboardDidHide", "keyboardWillChangeFrame"].map(event =>
      Keyboard.addListener(event as "keyboardDidShow" | "keyboardDidHide" | "keyboardWillChangeFrame", controller.geometryChanged)) : [];
    return () => { controller.dispose(); if (current.current === controller) current.current = null; subscriptions.forEach(subscription => subscription.remove()); };
  }, [scope, enabled]);

  const geometryChanged = () => current.current?.geometryChanged();
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => current.current?.scroll(event.nativeEvent);
  const beginInteraction = () => current.current?.beginInteraction();
  const endInteraction = (event: NativeSyntheticEvent<NativeScrollEvent>) => { onScroll(event); current.current?.endInteraction(); };
  return {
    ref, requestLatest: () => current.current?.requestLatest(), preserveHistory: () => current.current?.preserveHistory(),
    isFollowing: () => current.current?.isFollowing() ?? true,
    geometryChanged,
    scrollProps: {
      ref, onScroll, scrollEventThrottle: 32,
      onLayout: geometryChanged, onContentSizeChange: geometryChanged,
      onScrollBeginDrag: beginInteraction, onScrollEndDrag: endInteraction,
      onMomentumScrollBegin: beginInteraction, onMomentumScrollEnd: endInteraction,
      // Native anchoring is useful while reading/prepending history, but fights
      // a deliberate scroll-to-latest when opening or sending a message.
      maintainVisibleContentPosition: following ? undefined : { minIndexForVisible: 0 }
    }
  };
}
