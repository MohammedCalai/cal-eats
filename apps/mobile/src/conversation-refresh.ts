type ConversationRefreshOptions<T> = {
  load: () => Promise<T>;
  apply: (value: T) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
};

// One controller belongs to one account, search and page. Quiet refreshes keep
// the current rows visible; disposal prevents an older search replacing them.
export function createConversationRefresh<T>({ load, apply, onError, onLoading }: ConversationRefreshOptions<T>) {
  let active = true, inFlight = false;
  return {
    async refresh(quiet = false): Promise<void> {
      if (!active || inFlight) return;
      inFlight = true;
      if (!quiet) onLoading(true);
      try {
        const value = await load();
        if (active) { apply(value); onError(""); }
      } catch (error) {
        if (active && !quiet) onError((error as Error).message);
      } finally {
        inFlight = false;
        if (active && !quiet) onLoading(false);
      }
    },
    dispose() { active = false; }
  };
}
