import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { ApiError, api } from "./api";

// One request at a time per resource, including manual refreshes. A forced
// refresh waits for an older poll and then reads again after a status mutation.
export function useLiveOrders<T>(path: string, token: string, interval = 10_000) {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true), [verified, setVerified] = useState(false), [foreground, setForeground] = useState(AppState.currentState === "active"), [unauthorised, setUnauthorised] = useState(false);
  const active = useRef(AppState.currentState === "active"), generation = useRef(0), mounted = useRef(false), running = useRef<Promise<void> | null>(null);
  const target = `${path}\0${token}`, currentTarget = useRef(target); currentTarget.current = target;
  const refresh = useCallback(async (fresh = false): Promise<void> => {
    const current = generation.current;
    if (fresh && running.current) await running.current;
    if (!mounted.current || current !== generation.current || target !== currentTarget.current) return;
    if (running.current) return running.current;
    if (!active.current || !token) return;
    const work = (async () => {
      setLoading(true);
      try { const result = await api<T>(path, { token }); if (current === generation.current && target === currentTarget.current && active.current) { setValue(result); setError(""); setVerified(true); setUnauthorised(false); } }
      catch (e) { if (current === generation.current && target === currentTarget.current && active.current) { setError((e as Error).message); if (e instanceof ApiError && e.status === 401) { setValue(null); setVerified(false); setUnauthorised(true); } } }
      finally { if (current === generation.current) setLoading(false); }
    })();
    running.current = work;
    try { await work; } finally { if (running.current === work) running.current = null; }
  }, [path, token]);
  useEffect(() => { mounted.current = true; generation.current++; setValue(null); setVerified(false); setError(""); setUnauthorised(false); void refresh(true); return () => { mounted.current = false; generation.current++; }; }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (active.current) void refresh(); }, interval);
    const subscription = AppState.addEventListener("change", state => { active.current = state === "active"; setForeground(active.current); if (!active.current) { generation.current++; setVerified(false); } else void refresh(true); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [refresh, interval]);
  return { value, setValue, error, loading, verified, foreground, unauthorised, refresh };
}
