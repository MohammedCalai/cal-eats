export type ThreadPage = "latest" | "earlier";

type Options<T> = {
  load: (page: ThreadPage) => Promise<T>;
  apply: (value: T, page: ThreadPage) => void | Promise<void>;
  onError: (error: unknown) => void;
  onLoading?: (loading: boolean) => void;
  isCurrent: () => boolean;
};
type Request = { page: ThreadPage; promise: Promise<void>; done: () => void };

export async function completeThreadSend<T>(options: {
  send: () => Promise<T>;
  text: string;
  isCurrent: () => boolean;
  updateDraft: (update: (draft: string) => string) => void;
  onSent: (value: T) => void | Promise<void>;
}): Promise<void> {
  const value = await options.send();
  if (!options.isCurrent()) return;
  options.updateDraft(draft => options.isCurrent() && draft.trim() === options.text ? "" : draft);
  await options.onSent(value);
}

// A controller belongs to one authenticated thread. A send queues a fresh read
// behind any poll, and invalidates snapshots taken before the successful POST.
export function createThreadRefresh<T>(options: Options<T>) {
  let active = true, running: Request | null = null, revision = 0, showingLoading = false;
  const queue: Request[] = [];
  const current = () => active && options.isCurrent();

  async function drain() {
    if (running) return;
    while (current() && queue.length) {
      const request = queue.shift()!;
      running = request;
      const startedAt = revision;
      try {
        const value = await options.load(request.page);
        if (current() && startedAt === revision) await options.apply(value, request.page);
      } catch (error) {
        if (current() && startedAt === revision) options.onError(error);
      } finally {
        running = null;
        request.done();
      }
    }
    if (current() && showingLoading) options.onLoading?.(false);
    showingLoading = false;
  }

  return {
    refresh(page: ThreadPage = "latest", quiet = false): Promise<void> {
      if (!current()) return Promise.resolve();
      if (!quiet && !showingLoading) { showingLoading = true; options.onLoading?.(true); }
      // Repeated older-page taps must not silently fetch multiple pages. Latest
      // reads deliberately queue behind an in-flight read, including after send.
      const pending = queue.find(request => request.page === page)
        ?? (page === "earlier" && running?.page === page ? running : null);
      if (pending) return pending.promise;
      let done!: () => void;
      const promise = new Promise<void>(resolve => { done = resolve; });
      queue.push({ page, promise, done });
      void drain();
      return promise;
    },
    invalidate() { revision++; },
    isActive: current,
    dispose() {
      active = false;
      for (const request of queue.splice(0)) request.done();
    }
  };
}

export type ThreadCursor = { before: string; beforeId: string };
type MessageRow = { id: string; createdAt: string };

// Keep the visible rows when a server's latest page slides forward. Automatic
// history is trimmed only while following the bottom; its rebased cursor keeps
// every trimmed message available through Earlier messages.
export function createThreadWindow<T extends MessageRow>(latestLimit = 200) {
  let items: T[] = [], nextCursor: ThreadCursor | null | undefined;
  function merge(incoming: T[], preserveHistory: boolean) {
    items = [...new Map([...items, ...incoming].map(item => [item.id, item])).values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (!preserveHistory && items.length > latestLimit) {
      items = items.slice(-latestLimit);
      nextCursor = { before: items[0]!.createdAt, beforeId: items[0]!.id };
    }
    return { items, nextCursor };
  }
  return {
    cursor: () => nextCursor,
    receive(incoming: T[], cursor: ThreadCursor | null, page: ThreadPage, preserveHistory: boolean) {
      if (page === "earlier" || nextCursor === undefined) nextCursor = cursor;
      return merge(incoming, preserveHistory);
    },
    append(item: T) { return merge([item], false); }
  };
}
