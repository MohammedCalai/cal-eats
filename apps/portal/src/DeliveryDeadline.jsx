import React, { useEffect, useState } from "react";
import "./DeliveryDeadline.css";

export function useDeliveryDeadlineClock(enabled) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const update = () => { if (!document.hidden) setNow(Date.now()); };
    update();
    const timer = window.setInterval(update, 5000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); window.removeEventListener("focus", update); };
  }, [enabled]);
  return now;
}

export function DeliveryDeadlineBadge({ warning }) {
  if (!warning) return null;
  const due = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }).format(new Date(warning.dueAt));
  return <span className="delivery-deadline-badge" title={`Expected delivery: ${due}`}><span aria-hidden="true">●</span>{warning.label}</span>;
}
