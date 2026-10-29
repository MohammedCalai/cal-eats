import { useEffect, useState } from "react";
export function useSidebarLayout() {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width:1536px)").matches);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("cal-eats-sidebar-collapsed") === "true"; } catch { return false; } });
  useEffect(() => { const media = window.matchMedia("(min-width:1536px)"), update = () => setDesktop(media.matches); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  function toggleDesktop() { setCollapsed(value => { const next = !value; try { localStorage.setItem("cal-eats-sidebar-collapsed", String(next)); } catch {} return next; }); }
  return { desktop, collapsed, toggleDesktop };
}
