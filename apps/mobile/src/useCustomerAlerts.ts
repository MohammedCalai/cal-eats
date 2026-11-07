import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createCustomerUnreadPrompt } from "./customer-unread-prompt";

/** Silent attention reminders. The bell acknowledges attention, not message reads. */
export function useCustomerAlerts(userId: string | null, unreadIds: string[]) {
  const model = useRef({ userId, prompt: createCustomerUnreadPrompt() });
  const currentIds = useRef(unreadIds); currentIds.current = unreadIds;
  const [readyFor, setReadyFor] = useState<string | null>(null), [, rerender] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  if (model.current.userId !== userId) model.current = { userId, prompt: createCustomerUnreadPrompt() };
  model.current.prompt.observe(unreadIds);
  const ready = Boolean(userId && readyFor === userId);
  const pending = ready && model.current.prompt.pending();
  useEffect(() => {
    let active = true; setReadyFor(null);
    if (!userId) return;
    void writes.current.catch(() => undefined).then(() => SecureStore.getItemAsync(`cal-eats-customer-alert-ack-${userId}`)).then(saved => {
      if (!active || model.current.userId !== userId) return;
      let ids: string[] = [];
      try { const parsed: unknown = JSON.parse(saved || "[]"); if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string"); } catch { /* Start with the current unread updates. */ }
      model.current.prompt = createCustomerUnreadPrompt([...ids, ...model.current.prompt.acknowledgedIds()]);
      model.current.prompt.observe(currentIds.current);
      setReadyFor(userId);
    }).catch(() => { if (active && model.current.userId === userId) setReadyFor(userId); });
    return () => { active = false; };
  }, [userId]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  function acknowledge() {
    if (!userId || model.current.userId !== userId) return;
    model.current.prompt.observe(currentIds.current);
    const ids = model.current.prompt.acknowledge(); rerender(value => value + 1);
    // Serialize saves so an older acknowledgement cannot replace a newer one.
    writes.current = writes.current.catch(() => undefined).then(() => SecureStore.setItemAsync(`cal-eats-customer-alert-ack-${userId}`, JSON.stringify(ids)));
    void writes.current.catch(() => undefined);
  }
  return { pending, ready, foreground, acknowledge };
}
