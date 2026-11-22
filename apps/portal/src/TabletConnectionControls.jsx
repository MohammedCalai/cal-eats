import React, { useEffect, useRef, useState } from "react";
import { subscribeTerminalStatus, terminalStatus } from "./terminal-client.js";

export default function TabletConnectionControls({ enabled, suspended, embedded, onConnect, onRecheck }) {
  const [connection, setConnection] = useState(terminalStatus), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const working = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; const unsubscribe = subscribeTerminalStatus(setConnection); return () => { alive.current = false; unsubscribe(); }; }, []);
  if (!enabled || connection.status === "ready") return null;
  const denied = connection.status === "permission_denied", connecting = busy || connection.status === "connecting";
  const site = embedded ? "calai.info, the site containing this workspace" : "eats.calai.info";
  const explanation = suspended ? "Sign in to your business account before reconnecting this tablet."
    : denied ? `Your browser has blocked this site's connection to the tablet. Open the address-bar site permissions for ${site}, allow Loopback network or Local network access if shown, then check again.`
    : connection.status === "unpaired" ? "This tablet is not enrolled. Your administrator must complete its protected setup; signing in here does not register a device."
    : connection.status === "revoked" ? "This tablet's ordering access is revoked. Ask your administrator to review its registration."
    : ["connection_unavailable", "offline"].includes(connection.status) ? "The tablet connection could not be reached. Check that its ordering connection is running and browser access is allowed, then retry."
    : "Connect this Windows tablet to its protected ordering session. Your browser may ask to allow a connection to this device. Your business account stays separate.";
  function connect(event) {
    if (!event.isTrusted || working.current || suspended) return;
    working.current = true; setBusy(true); setError("");
    // Calling, rather than awaiting another task before calling, preserves the
    // child document's trusted gesture for the first permission-triggering fetch.
    let work;
    try { work = denied ? onRecheck() : onConnect(); }
    catch (caught) { work = Promise.reject(caught); }
    void Promise.resolve(work).catch(caught => { if (alive.current) setError(caught.message); }).finally(() => { working.current = false; if (alive.current) setBusy(false); });
  }
  return <section className="panel tablet-connection-controls" aria-label="Restaurant tablet connection"><h2>Restaurant tablet connection</h2><p>{explanation}</p>{connecting && <p role="status">Checking the protected tablet connection…</p>}{error && <p className="alert" role="alert">{error}</p>}{!suspended && <button className="primary" type="button" disabled={connecting} onClick={connect}>{connecting ? "Connecting…" : denied ? "Check permission again" : ["connection_unavailable", "offline", "revoked", "unpaired"].includes(connection.status) ? "Reconnect tablet" : "Connect tablet"}</button>}<p className="fine">Browser permission alone does not enrol a tablet or allow order processing. The registered device must still verify its identity.</p></section>;
}
