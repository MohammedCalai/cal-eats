type BackEntry = { priority: number; handle: () => boolean };

export function createAndroidBackStack() {
  const entries: BackEntry[] = [];
  return {
    register(handle: () => boolean, priority = 0) {
      const entry = { handle, priority };
      entries.push(entry);
      return () => { const index = entries.indexOf(entry); if (index >= 0) entries.splice(index, 1); };
    },
    dispatch() {
      for (const entry of [...entries].reverse().sort((a, b) => b.priority - a.priority)) {
        if (entry.handle()) return true;
      }
      return false;
    }
  };
}

export function requestBackNavigation({ blocked, dirty, close, confirmDiscard }: {
  blocked: boolean; dirty: boolean; close: () => void; confirmDiscard: (close: () => void) => void;
}) {
  if (blocked) return true;
  if (dirty) confirmDiscard(close); else close();
  return true;
}
