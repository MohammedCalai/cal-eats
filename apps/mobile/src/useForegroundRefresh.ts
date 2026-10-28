import { useEffect, useRef } from "react";
import { AppState } from "react-native";

export function useForegroundRefresh(refresh: () => Promise<unknown>, enabled = true, milliseconds = 5000) {
  const current = useRef(refresh); current.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, inFlight = false;
    const run = async () => {
      if (stopped || inFlight || AppState.currentState !== "active") return;
      inFlight = true;
      try { await current.current(); } catch { /* The screen retains its data and owns visible errors. */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => void run(), milliseconds);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void run(); });
    return () => { stopped = true; clearInterval(timer); subscription.remove(); };
  }, [enabled, milliseconds]);
}
