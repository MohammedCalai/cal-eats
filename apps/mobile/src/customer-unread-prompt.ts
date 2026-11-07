/** A dismissal acknowledges attention, without changing server-side read state. */
export function createCustomerUnreadPrompt(savedIds: string[] = []) {
  const acknowledged = new Set(savedIds.filter(id => typeof id === "string"));
  let unreadIds: string[] = [];
  return {
    observe(ids: string[]) { unreadIds = [...new Set(ids)]; },
    pending() { return unreadIds.some(id => !acknowledged.has(id)); },
    acknowledgedIds() { return [...acknowledged].slice(-2000); },
    acknowledge() {
      unreadIds.forEach(id => acknowledged.add(id));
      return [...acknowledged].slice(-2000);
    }
  };
}

export function customerUnreadPromptVisible(pending: boolean, foreground: boolean, blocked: boolean) {
  return pending && foreground && !blocked;
}
