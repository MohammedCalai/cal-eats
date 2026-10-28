import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export function useFinanceResource(path) {
  const [state, setState] = useState({ path: "", value: null, loading: true, error: "" });
  const sequence = useRef(0), request = useRef(null);
  const reload = useCallback(async () => {
    const current = ++sequence.current, controller = new AbortController();
    request.current?.abort(); request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    setState(previous => ({ path, value: previous.path === path ? previous.value : null, loading: true, error: "" }));
    try {
      const value = await api(path, { signal: controller.signal });
      if (current === sequence.current) setState({ path, value, loading: false, error: "" });
    } catch (error) {
      if (current === sequence.current) setState({ path, value: null, loading: false, error: error.name === "AbortError" ? "The request took too long. Please refresh and try again." : error.message });
    } finally { window.clearTimeout(timeout); }
  }, [path]);
  useEffect(() => { void reload(); return () => { sequence.current++; request.current?.abort(); }; }, [reload]);
  return { ...(state.path === path ? state : { value: null, loading: true, error: "" }), reload };
}
