import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, json } from "./api.js";
import { shortDate, listItems } from "./model.js";
import { BUSINESS_PRODUCTS, CALAI_WORKSPACE_TOOLS, businessWorkspaceMode, canUseCalaiWorkspaceTools, applyTabletProductAccess, productPresentation, productControlLabel, productName, safeNativeLink, accountDirectoryQuery, connectionConfirmation, deviceStateLabel, terminalSetupDocument, canConnectBusinessProduct, calaiTabletAuthorizationPath, calaiTabletFirstSetupPath, calaiFirstSetupTablets, calaiFirstSetupPayload } from "./unified-business-model.js";
import { requestCalaiFirstTabletSetup, saveCalaiFirstTabletSetup } from "./calai-first-tablet-download.js";
import WeeklyStatements from "./WeeklyStatements.jsx";
import {WorkspaceDialog} from "./CustomerWorkspace.jsx";
import {startOperationalPresence,stopOperationalPresence} from "./surface-presence-client.js";
import {subscribeTerminalStatus, terminalApi, terminalStatus} from "./terminal-client.js";
import {calaiTabletAssignment, openAssignedCalai} from "./calai-tablet-startup.js";
import { EMBEDDED_PARENT_ORIGIN, embeddedCommand, embeddedState } from "./embedded-business-model.js";
import "./UnifiedBusiness.css";

const BusinessContext = createContext(null);
export const useBusinessWorkspace = () => useContext(BusinessContext);
export function useBusinessResource(path, { poll = 0, request = api, scope = null } = {}) {
  const [state, setState] = useState({ path, scope, value: null, loading: Boolean(path), error: "", updatedAt: null });
  const run = useRef(0), pending = useRef(null), current = useRef(path); current.current = path;
  const reload = useCallback(async () => {
    if (!path) return;
    pending.current?.abort(); const controller = new AbortController(), serial = ++run.current; pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setState(old => old.path === path && old.scope === scope
      ? { ...old, loading: old.value === null, error: "" }
      : { path, scope, value: null, loading: true, error: "", updatedAt: null });
    try { const value = await request(path, { signal: controller.signal }); if (current.current === path && serial === run.current) setState({ path, value, loading: false, error: "", updatedAt: new Date().toISOString(), scope }); }
    catch (error) { if (current.current === path && serial === run.current) setState(old => ({ ...old, path, loading: false, value: [401, 403, 404].includes(error.status) ? null : old.value, error: error.name === "AbortError" ? "The request took too long. Try again." : error.message })); }
    finally { clearTimeout(timeout); if (pending.current === controller) pending.current = null; }
  }, [path, request, scope]);
  useEffect(() => { setState({ path, scope, value: null, loading: Boolean(path), error: "", updatedAt: null }); void reload(); const timer = poll ? setInterval(() => { if (!document.hidden && !pending.current) void reload(); }, poll) : null; return () => { run.current++; pending.current?.abort(); pending.current = null; if (timer) clearInterval(timer); }; }, [reload, poll, path, scope]);
  return { ...(state.path === path && state.scope === scope ? state : { path, scope, value: null, loading: Boolean(path), error: "", updatedAt: null }), reload };
}
function Feedback({ error, notice }) { return <>{error && <p className="alert" role="alert">{error}</p>}{notice && <p className="alert success" role="status">{notice}</p>}</>; }
function Resource({ value, loading, error, reload, children }) { return <>{error && <p className="alert" role="alert">{error} <button type="button" className="quiet" onClick={() => void reload()}>Try again</button></p>}{loading && !value ? <p role="status">Loading account information…</p> : value ? children : !error && <p className="empty">No account information is available.</p>}</>; }
export function BusinessWorkspaceProvider({ userId, embedded = false, observeManagedSetup, automaticStartupAllowed, children }) {
  const context = useBusinessResource("/api/business/context", { poll: 30000 });
  const accounts = useBusinessResource("/api/business/accounts");
  const [terminal, setTerminal] = useState(terminalStatus);
  useEffect(() => subscribeTerminalStatus(setTerminal), []);
  useEffect(() => {
    if (context.value?.managedTabletAwaitingConnection === true) void observeManagedSetup?.(context.value.id);
  }, [context.value, observeManagedSetup]);
  useEffect(() => {
    const reload = () => void context.reload();
    window.addEventListener("cal-eats-terminal-session-restored", reload);
    return () => window.removeEventListener("cal-eats-terminal-session-restored", reload);
  }, [context.reload]);
  const pairedWithBusiness = terminal.status === "ready" && terminal.context?.businessId === context.value?.id;
  const tabletScope = pairedWithBusiness && context.value?.principalKind === "human" ? terminal.context.terminalId : null;
  const tabletContext = useBusinessResource(tabletScope ? "/api/business/context" : null, { poll: 15000, request: terminalApi, scope: tabletScope });
  const business = applyTabletProductAccess(context.value, tabletContext.value);
  const signedResource = tabletScope ? tabletContext : context;
  const signedContext = pairedWithBusiness ? signedResource.value : null;
  const signedConfiguration = signedContext?.tabletConfiguration;
  const configurationReadAt = signedResource.updatedAt;
  const location = useLocation();
  const startupPage = location.pathname.replace(/\/+$/, "") === "/owner/dashboard" && !embedded &&
    window.top === window && automaticStartupAllowed?.() === true;
  const startupAssignment = startupPage && !signedResource.error ? calaiTabletAssignment(terminal, signedContext, business?.id) : null;
  const received = useRef(null), sending = useRef(null);
  useEffect(() => {
    const businessId = business?.id, terminalId = terminal.context?.terminalId;
    const revision = signedConfiguration?.revision, tabletId = signedConfiguration?.tabletId;
    if (startupAssignment?.authorised || !businessId || !terminalId || !tabletId || !Number.isSafeInteger(revision) ||
      signedConfiguration.receivedAt || signedConfiguration.status === "received") return;
    const key = `${businessId}:${terminalId}:${tabletId}:${revision}`;
    if (received.current === key || sending.current === key) return;
    sending.current = key;
    void terminalApi(`/api/business/accounts/${encodeURIComponent(businessId)}/surface/heartbeat`,
      json("POST", { state: "configuration_received", configurationTabletId: tabletId, configurationRevision: revision }))
      .then(() => { if (sending.current === key) received.current = key; })
      .catch(() => { /* Try again when the signed context is refreshed. */ })
      .finally(() => { if (sending.current === key) sending.current = null; });
  }, [business?.id, terminal.context?.terminalId, signedConfiguration, configurationReadAt, startupAssignment?.authorised]);
  const [selecting, setSelecting] = useState(false), [selectionError, setSelectionError] = useState("");
  const navigate = useNavigate(), working = useRef(false);
  async function selectAccount(id) {
    if (working.current || !listItems(accounts.value).some(row => row.id === id)) return;
    working.current = true; setSelecting(true); setSelectionError("");
    try { await api(`/api/business/accounts/${encodeURIComponent(id)}/select`, json("POST", {})); await context.reload(); navigate("/owner/dashboard"); }
    catch (error) { setSelectionError(error.message); }
    finally { working.current = false; setSelecting(false); }
  }
  return <BusinessContext.Provider value={{ ...context, business, terminal, mode: businessWorkspaceMode(business, signedConfiguration), accounts: listItems(accounts.value), accountsError: accounts.error, reloadAccounts: accounts.reload, selecting, selectAccount, userId, embedded }}>
    <OperationalSurfacePresence business={business} terminal={terminal}/>
    {embedded && <EmbeddedBusinessBridge key={business?.id||"no-business"}/>}
    <Resource {...context}>
      {selectionError && <p className="alert" role="alert">{selectionError}</p>}
      {startupAssignment ? <CalaiTabletStartup assignment={startupAssignment} allowConnections={business?.canConnectProducts === true}
        automaticStartupAllowed={automaticStartupAllowed}/> : tabletScope && !signedResource.value && signedResource.loading
        ? <main className="auth"><p role="status">Opening business platform…</p></main> : children}
    </Resource>
  </BusinessContext.Provider>;
}

function CalaiTabletStartup({ assignment, allowConnections, automaticStartupAllowed }) {
  const [attempt, setAttempt] = useState(0), [failure, setFailure] = useState(null);
  const current = useRef(assignment);
  current.current = assignment;
  useEffect(() => {
    if (!assignment.authorised) return;
    const controller = new AbortController();
    const isCurrent = expected => {
      const device = terminalStatus();
      return automaticStartupAllowed() && current.current.authorised && current.current.key === expected.key &&
        device.status === "ready" && device.paired && device.context?.terminalId === expected.terminalId &&
        device.context.businessId === expected.businessId && /^\/business\/owner\/dashboard\/*$/.test(window.location.pathname);
    };
    void openAssignedCalai({ assignment, request: terminalApi, isCurrent, signal: controller.signal,
      replace: destination => window.location.replace(destination) })
      .catch(() => { if (!controller.signal.aborted) setFailure({ key: assignment.key, attempt }); });
    return () => controller.abort();
  }, [assignment.key, assignment.authorised, automaticStartupAllowed, attempt]);

  const failed = failure?.key === assignment.key && failure?.attempt === attempt;
  return <main className="auth"><section className="auth-card">
    <h1>Calai</h1>
    {!assignment.authorised ? <p>Ask the restaurant owner to check this tablet’s Calai access.</p>
      : failed ? <><p role="alert">The tablet’s Calai setting could not be confirmed.</p>
        <button type="button" className="primary" onClick={() => setAttempt(value => value + 1)}>Try again</button></>
        : <p role="status">Opening Calai…</p>}
    {allowConnections && <Link className="button-link" to="/owner/connections">Accounts &amp; connections</Link>}
  </section></main>;
}
function OperationalSurfacePresence({ business, terminal }) {
  const lastScope = useRef(null);
  const terminalId = terminal.terminalId;
  const allowed = business?.products?.["cal-eats"]?.allowedOnTablet !== false;
  const scope = business && allowed ? { businessId: business.id, restaurantId: business.eatsRestaurantId, terminalId }
    : !business && terminal.reconnectEligible && lastScope.current?.terminalId === terminalId ? lastScope.current : null;
  const businessId = scope?.businessId, restaurantId = scope?.restaurantId;
  useEffect(() => {
    lastScope.current = businessId && restaurantId && terminalId ? { businessId, restaurantId, terminalId } : null;
    if (businessId && restaurantId) startOperationalPresence({ businessId, restaurantId });
    return () => stopOperationalPresence();
  }, [businessId, restaurantId, terminalId]);
  return null;
}
export function EmbeddedSessionBridge({ enabled, user }) {
  const navigate = useNavigate();
  useEffect(() => { if (!enabled) return; const receive = event => { const path = embeddedCommand(event, window.parent); if (path && user?.role === "restaurant") navigate(path); }; window.addEventListener("message", receive); return () => window.removeEventListener("message", receive); }, [enabled, navigate, user?.id, user?.role]);
  useEffect(() => { if (enabled && !user) window.parent.postMessage(embeddedState(null, null, null, false), EMBEDDED_PARENT_ORIGIN); }, [enabled, user?.id]);
  return null;
}
function EmbeddedBusinessBridge() {
  const workspace = useBusinessWorkspace(), business = workspace?.business;
  const dashboard = useBusinessResource(business ? "/api/business/dashboard" : null, { poll: 30000 });
  useEffect(() => { const payload = embeddedState(workspace.error ? null : business, dashboard.error ? null : dashboard.value, null, Boolean(business && !workspace.error)); const send=()=>window.parent.postMessage(payload, EMBEDDED_PARENT_ORIGIN); send();const timer=setInterval(send,30000);return()=>clearInterval(timer); }, [business, workspace.error, dashboard.value, dashboard.error]);
  return null;
}
export function BusinessAccountSwitcher() {
  const workspace = useBusinessWorkspace(); if (!workspace || workspace.accounts.length < 2) return null;
  return <label className="restaurant-switch">Business/location<select value={workspace.business.id} disabled={workspace.selecting} onChange={event => void workspace.selectAccount(event.target.value)}>{workspace.accounts.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>;
}
function ProductMark({ product }) {
  return <span className={`business-account-mark product-${product}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{product === "calai" ? <><path d="M5 3h4l2 5-3 2a14 14 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2Z"/><path d="M15 3a6 6 0 0 1 6 6M15 7a2 2 0 0 1 2 2"/></> : <><path d="M4 7h16l-1 14H5L4 7ZM8 7V5a4 4 0 0 1 8 0v2"/><path d="M9 12h6M9 16h4"/></>}</svg></span>;
}
const ownerApi = (path, options) => api(path, { ...options, humanSession: true });
function CalaiFirstTabletSetup({ business, path }) {
  const { value, error: checkError, loading, reload } = useBusinessResource(path, { request: ownerApi });
  const tablets = calaiFirstSetupTablets(value);
  const [selectedId, setSelectedId] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState({});
  const request = useRef(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);
  const selected = tablets.length === 1 ? tablets[0] : tablets.find(row => row.tabletId === selectedId);
  const currentPayload = calaiFirstSetupPayload(confirmation, selected);
  const managed = selected?.managedSetup?.available === true;
  const setupState = selected?.managedSetup?.state;
  const pending = setupState === "waiting" || setupState === "in_progress";

  async function prepareSetup() {
    if (request.current || !path || checkError || !currentPayload) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setSaving(true);
    setFeedback({});
    try {
      const result = await requestCalaiFirstTabletSetup(path, currentPayload, { signal: controller.signal });
      if (request.current !== controller || controller.signal.aborted) return;
      if (result.managed === true) setFeedback({ notice: `Tablet setup approved for ${confirmation.tabletName}.` });
      else {
        saveCalaiFirstTabletSetup(result);
        setFeedback({ notice: `Private setup file downloaded for ${confirmation.tabletName}. Pairing completes when the tablet connects.` });
      }
    } catch (error) {
      if (request.current !== controller) return;
      setFeedback({ error: error.name === "AbortError"
        ? "The request timed out. Check the current assignment before trying again."
        : error.message });
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        setConfirmation(null);
        await reload();
        if (request.current === controller) {
          request.current = null;
          setSaving(false);
        }
      }
    }
  }

  if (value?.eligible !== true && !checkError && !feedback.error && !feedback.notice) return null;
  return <div className="business-tablet-authorization">
    <h3>First tablet setup</h3>
    <Feedback {...feedback}/>
    {checkError ? <p role="alert">Could not check assigned tablets.</p>
      : value?.eligible === true && (tablets.length ? <>
        {tablets.length > 1 && <label>Assigned tablet
          <select value={selectedId} disabled={saving} onChange={event => {
            setSelectedId(event.target.value);
            setConfirmation(null);
            setFeedback({});
          }}>
            <option value="">Choose a tablet</option>
            {tablets.map(row => <option key={row.tabletId} value={row.tabletId}>{row.tabletName} · {row.serialNumber}</option>)}
          </select>
        </label>}
        {selected && <p><strong>{selected.tabletName}</strong> · Serial {selected.serialNumber}</p>}
        {pending && <p role="status">{setupState === "waiting" ? "Waiting to send setup to this tablet." : "Waiting for this tablet to connect."}</p>}
        {setupState === "attention" && <p role="status">The tablet setup needs attention. Check the assignment before trying again.</p>}
      </> : <p>Ask your administrator to assign a Windows tablet to this location.</p>)}
    <div className="button-row">
      {!checkError && tablets.length > 0 && !pending && <button type="button" className="quiet" disabled={!selected || saving} onClick={() => {
        setFeedback({});
        setConfirmation(selected);
      }}>{managed ? "Approve tablet" : "Download tablet setup"}</button>}
      <button type="button" className="quiet" disabled={loading || saving} onClick={() => { setConfirmation(null); void reload(); }}>Check assignment</button>
    </div>
    {confirmation && currentPayload && !checkError && !pending &&
      <WorkspaceDialog title={managed ? "Approve tablet setup?" : "Download private tablet setup?"} onClose={() => { if (!request.current) setConfirmation(null); }}>
        <p><strong>{confirmation.tabletName}</strong> · Serial {confirmation.serialNumber} · <strong>{business.name}</strong></p>
        <p>{managed ? "Setup will be sent to the assigned Windows tablet after you approve it." : "Keep this one-use file private. Run it on the named Windows tablet as an administrator within ten minutes."}</p>
        <div className="button-row">
          <button type="button" className="quiet" disabled={saving} onClick={() => setConfirmation(null)}>Cancel</button>
          <button type="button" className="primary" disabled={saving} onClick={() => void prepareSetup()}>{saving ? (managed ? "Approving tablet…" : "Preparing setup…") : managed ? "Approve tablet" : "Confirm and download"}</button>
        </div>
      </WorkspaceDialog>}
  </div>;
}

function CalaiOwnerTabletControls({ business, tabletConnection }) {
  const firstSetupPath = calaiTabletFirstSetupPath(business);
  return <>
    <CalaiTabletAuthorization business={business}/>
    {firstSetupPath && <>
      <CalaiFirstTabletSetup key={firstSetupPath} business={business} path={firstSetupPath}/>
      {tabletConnection}
    </>}
  </>;
}

function CalaiTabletAuthorization({ business }) {
  const path = calaiTabletAuthorizationPath(business);
  const { value, error: checkError, reload } = useBusinessResource(path, { request: ownerApi });
  const [confirmation, setConfirmation] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(null);
  useEffect(() => () => {
    const pending = request.current;
    request.current = null;
    pending?.abort();
  }, []);
  const eligible = Boolean(path && value?.eligible === true && typeof value.authorized === "boolean" &&
    typeof value.terminalId === "string" && value.terminalId && typeof value.tabletName === "string" && value.tabletName.trim());

  async function authorise() {
    if (request.current || !eligible || checkError || value.authorized || confirmation?.terminalId !== value.terminalId) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setSaving(true);
    setError("");
    try {
      const result = await ownerApi(path, {
        ...json("POST", { expectedTerminalId: confirmation.terminalId }),
        signal: controller.signal,
      });
      if (request.current !== controller) return;
      if (result?.eligible !== true || result.authorized !== true || result.terminalId !== confirmation.terminalId) {
        throw new Error("The tablet's Calai access could not be confirmed. Check its current access before trying again.");
      }
      setConfirmation(null);
    } catch (caught) {
      if (request.current !== controller) return;
      setConfirmation(null);
      setError(caught.name === "AbortError"
        ? "The request took too long. Check the tablet's current access before trying again."
        : caught.message);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        await reload();
        if (request.current === controller) {
          request.current = null;
          setSaving(false);
        }
      }
    }
  }

  if (!path || !eligible && !error && !checkError) return null;
  return <div className="business-tablet-authorization">
    <Feedback error={error}/>
    {!eligible && checkError && <><p role="alert">Could not check current tablet access.</p><button type="button" className="quiet" onClick={() => void reload()}>Check again</button></>}
    {eligible && <><h3>Calai on your ordering tablet</h3>
      {checkError ? <><p role="alert">Could not check current tablet access.</p><button type="button" className="quiet" onClick={() => void reload()}>Check again</button></>
        : value.authorized ? <p role="status"><strong>{value.tabletName}</strong> is authorised to use your Calai connection when its selected mode includes Calai.</p>
        : <><p>Allow <strong>{value.tabletName}</strong> to use your verified Calai connection without an owner signed in. Your administrator still chooses the tablet’s app mode.</p>
          <button type="button" className="quiet" disabled={saving} onClick={() => {
            setError("");
            setConfirmation({ terminalId: value.terminalId, tabletName: value.tabletName });
          }}>Allow Calai on this tablet</button></>}
    </>}
    {confirmation && eligible && !checkError && !value.authorized && confirmation.terminalId === value.terminalId &&
      <WorkspaceDialog title="Allow Calai on this tablet?" onClose={() => { if (!request.current) setConfirmation(null); }}>
        <p>Allow <strong>{confirmation.tabletName}</strong> at <strong>{business.name}</strong> to open this Calai workspace using your verified account. This keeps its current app mode.</p>
        <div className="button-row">
          <button type="button" className="quiet" disabled={saving} onClick={() => setConfirmation(null)}>Cancel</button>
          <button type="button" className="primary" disabled={saving} onClick={() => void authorise()}>{saving ? "Authorising…" : "Confirm tablet access"}</button>
        </div>
      </WorkspaceDialog>}
  </div>;
}
function OwnerProductCard({ business, product, tabletConnection }) {
  const state = productPresentation(business, product), settings = safeNativeLink(state.nativeLinks?.settings), finance = safeNativeLink(state.nativeLinks?.statements || state.nativeLinks?.billing);
  const reconnect = state.connectionStatus === "reconnect_required", status = state.usable ? "Connected" : !state.allowed ? "Not enabled" : state.status === "unavailable" ? "Temporarily unavailable" : reconnect ? "Sign in required" : state.linked ? "Setup needed" : "Not connected";
  return <section className={`panel business-account-card product-${product}`} aria-label={`${state.name} account`}>
    <header><ProductMark product={product}/><div><h2>{state.name}</h2><p>{business.name}</p></div><span className={`business-account-status${state.usable ? " is-connected" : ""}`}>{status}</span></header>
    <p className="business-account-description">{state.linked ? product === "calai" ? "Your Calai orders, calls and business settings." : "Your restaurant’s orders, menu and earnings." : `Connect your existing ${state.name} account to use it here.`}</p>
    {state.tasks.length > 0 && <div className="business-account-next"><h3>Next steps</h3><ul>{state.tasks.map((task, index) => <li key={task.code || index}>{task.label || String(task)}</li>)}</ul></div>}
    {!state.allowed && !state.usable && <p className="fine">Contact Cal-Eats support if you would like to connect this service.</p>}
    <div className="business-account-actions">
      {canConnectBusinessProduct(business, product) && <Link className={state.linked && !reconnect ? "button-link" : "button-link primary"} to={`/owner/connections?connect=${product}`}>{state.linked ? reconnect ? `Reconnect ${state.name}` : "Verify connection" : `Connect ${state.name}`}</Link>}
      {state.nativeAccountId && settings && <a className="button-link" target="_top" href={settings}>Calai settings</a>}
      {state.nativeAccountId && state.financialAccess && finance && <a className="button-link" target="_top" href={finance}>Calai statements</a>}
      {product === "cal-eats" && state.linked && <Link className="button-link" to="/owner/settings">Restaurant settings</Link>}
      {product === "calai" && !state.nativeAccountId && safeNativeLink(state.nativeLinks?.onboarding) && <a className="button-link" target="_top" href={safeNativeLink(state.nativeLinks.onboarding)}>Register with Calai</a>}
      {canConnectBusinessProduct(business, product) && !state.linked && product === "cal-eats" && <a className="button-link" target="_top" href="/order/?view=register-restaurant">List your restaurant</a>}
    </div>
    {product === "calai" && <CalaiOwnerTabletControls key={business.id} business={business} tabletConnection={tabletConnection}/>}
    {state.nativeAccountId && <details className="business-account-reference"><summary>Account details</summary><dl><div><dt>Business</dt><dd>{business.name}</dd></div><div><dt>Account reference</dt><dd>{state.nativeAccountId}</dd></div></dl></details>}
  </section>;
}
export function ProductCards({ business, admin = false, onSaved, tabletConnection }) {
  const [pending, setPending] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const current = useRef(business.id); current.current = business.id;
  async function changePermission() {
    if (!pending || busy) return; const requestedId = business.id, action = pending; setBusy(true); setError(""); setNotice("");
    try { await api(`/api/admin/business/accounts/${encodeURIComponent(requestedId)}/products/${action.product}`, json("PATCH", { allowed: action.allowed })); if (current.current !== requestedId) return; setPending(null); setNotice(`${productName(action.product)} permission updated. Connection and setup readiness are checked separately.`); await onSaved?.(); }
    catch (caught) { if (current.current === requestedId) setError(caught.message); }
    finally { if (current.current === requestedId) setBusy(false); }
  }
  if (!admin) {
    const products = BUSINESS_PRODUCTS.filter(product => { const state = productPresentation(business, product); return state.linked || state.allowed || Boolean(state.nativeAccountId); });
    return products.length ? <div className="business-product-cards business-owner-products">{products.map(product => <OwnerProductCard key={product} business={business} product={product} tabletConnection={tabletConnection}/>)}</div> : <section className="panel"><h2>No accounts available</h2><p>Contact Cal-Eats support to check the accounts available to your business.</p></section>;
  }
  return <><Feedback error={error} notice={notice}/><div className="business-product-cards">{BUSINESS_PRODUCTS.map(product => {
    const state = productPresentation(business, product), settings = safeNativeLink(state.nativeLinks?.settings), finance = safeNativeLink(state.nativeLinks?.statements || state.nativeLinks?.billing);
    return <section className={`panel business-product-card product-${product}`} key={product} aria-label={`${state.name} account`}><header><span className="business-product-symbol" aria-hidden="true">{product === "calai" ? "☎" : "⌁"}</span><div><p className="eyebrow">{state.name}</p><h2>{state.linked ? "Account connected" : state.nativeAccountId ? "Native account available" : "Account not connected"}</h2></div><span className={`pill ${state.usable ? "subtle" : "attention"}`}>{state.label}</span></header>
      <dl className="business-connection-details"><div><dt>Native account reference</dt><dd className="account-reference">{state.nativeAccountId || "No native account yet"}</dd></div><div><dt>Administrator permission</dt><dd>{state.allowed ? "Allowed" : "Not allowed"}</dd></div><div><dt>Verified connection</dt><dd>{state.linked ? state.connectionStatus === "reconnect_required" ? "Sign-in required" : "Verified account link retained" : "Not connected"}</dd></div><div><dt>Setup readiness</dt><dd>{state.ready ? "Ready" : "Outstanding requirements"}</dd></div><div><dt>{product === "calai" ? "Native Calai status" : "Cal-Eats service"}</dt><dd>{state.nativeStatus || (product === "calai" ? state.nativeAccountId ? "Native service status unavailable" : "No native account yet" : state.label)}{product === "calai" && state.nativeStatus && state.nativeStatusVerifiedAt && <small><br/>Last verified {shortDate(state.nativeStatusVerifiedAt)}</small>}</dd></div></dl>
      {state.tasks.length > 0 && <ul className="business-setup-tasks">{state.tasks.map((task, index) => <li key={task.code || index}>{task.label || String(task)}</li>)}</ul>}
      {product === "calai" && <p className="fine">This permission controls the combined workspace. Native Calai calls, settings and account access remain independent.</p>}
      {admin ? <button className={state.allowed ? "quiet" : "primary"} type="button" disabled={busy} onClick={() => { setError(""); setPending({ product, allowed: !state.allowed }); }}>{productControlLabel(product)}: {state.allowed ? "On" : "Off"}</button> : canConnectBusinessProduct(business, product) && <Link className="button-link" to={`/owner/connections?connect=${product}`}>{state.linked ? `Verify ${state.name} connection` : `Connect ${state.name}`}</Link>}
      <div className="button-row">{state.nativeAccountId&&settings && <a className="button-link" target="_top" href={settings}>Open native Calai settings</a>}{state.nativeAccountId&&state.financialAccess && finance && <a className="button-link" target="_top" href={finance}>Open native Calai statements</a>}{product === "cal-eats" && state.linked && <Link className="button-link" to={admin ? `/admin/restaurants?restaurant=${encodeURIComponent(business.eatsRestaurantId || state.nativeAccountId)}` : "/owner/settings"}>Open Cal-Eats account</Link>}{product==="calai"&&!state.nativeAccountId&&safeNativeLink(state.nativeLinks?.onboarding)&&<a className="button-link" target="_top" href={safeNativeLink(state.nativeLinks.onboarding)}>Open native Calai onboarding</a>}{!admin&&canConnectBusinessProduct(business,product)&&!state.linked&&product==="cal-eats"&&<a className="button-link" target="_top" href="/order/?view=register-restaurant">Register a Cal-Eats business</a>}</div>
    </section>;
  })}</div>{pending && <WorkspaceDialog title={`${pending.allowed?"Allow":"Disable"} ${productName(pending.product)}?`} onClose={()=>{if(!busy)setPending(null);}}><div className="business-confirmation"><p><strong>{business.name}</strong></p><p>{pending.product === "calai" ? "Only this combined-workspace connection changes. Native Calai operation continues normally." : pending.allowed ? "This allows Cal-Eats setup or restores service when the verified account is ready. It does not bypass launch or setup requirements." : "New Cal-Eats orders will be blocked. Accepted orders, support, history and financial records remain available to authorised users."}</p><div className="button-row"><button className="quiet" type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button className="primary" type="button" disabled={busy} onClick={() => void changePermission()}>{busy ? "Saving…" : "Confirm administrator change"}</button></div></div></WorkspaceDialog>}</>;
}
export function BusinessConnections({ tabletConnection }) {
  const workspace = useBusinessWorkspace(), business = workspace?.business, [params] = useSearchParams();
  const requested = params.get("connect"), product = BUSINESS_PRODUCTS.includes(requested) ? requested : null;
  const [proof, setProof] = useState(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [sourceAccounts,setSourceAccounts] = useState([]), [selectedSource,setSelectedSource] = useState("");
  const pending = useRef(false), scope = useRef(`${business?.id}:${product}`); scope.current = `${business?.id}:${product}`;
  useEffect(() => { setProof(null); setConfirmed(false); setError(""); setNotice(""); setSourceAccounts([]); setSelectedSource(""); }, [business?.id, product]);
  if (!business) return null;
  const state = product && productPresentation(business, product), canConnect = Boolean(product && canConnectBusinessProduct(business, product));
  async function verify(event) {
    event.preventDefault(); if (pending.current || !canConnect) return; const form = event.currentTarget, fields = new FormData(form), requestedScope = scope.current;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { const value = await api(`/api/business/accounts/${encodeURIComponent(business.id)}/${product}/prepare-link`, json("POST", { email: String(fields.get("email") || "").trim(), password: String(fields.get("password") || ""), ...(product==="cal-eats"&&selectedSource&&sourceAccounts.some(row=>row.id===selectedSource)?{restaurantId:selectedSource}:{}) })); if (requestedScope === scope.current) { if(value.selectionRequired){setSourceAccounts(Array.isArray(value.sourceAccounts)?value.sourceAccounts:[]);setNotice("Choose the correct restaurant account, then verify its sign-in again.");}else{setProof(value);setConfirmed(false);} } }
    catch (caught) { if (requestedScope === scope.current) setError(caught.message); }
    finally { form.reset(); pending.current = false; if (requestedScope === scope.current) setBusy(false); }
  }
  async function commit() {
    if (pending.current || !canConnect) return; const requestedScope = scope.current;
    pending.current = true; setBusy(true); setError("");
    try { const result=await api(`/api/business/accounts/${encodeURIComponent(business.id)}/${product}/link`, json("POST", connectionConfirmation(product, proof, confirmed))); if (requestedScope !== scope.current) return; setProof(null); if(result?.sessionChanged){window.location.assign(workspace.embedded?"/business/embedded":"/business/owner/connections");return;}setNotice(`${state.name} account connected successfully.`); await workspace.reload(); await workspace.reloadAccounts(); }
    catch (caught) { if (requestedScope === scope.current) { setError(caught.message); if ([401, 403, 409, 410].includes(caught.status)) setProof(null); } }
    finally { pending.current = false; if (requestedScope === scope.current) setBusy(false); }
  }
  return <div className="unified-business business-account-page">
    <header className="page-heading business-account-heading"><p className="eyebrow">{business.name}</p><h1>Accounts & connections</h1><p>Manage the Calai and Cal-Eats accounts for your business.</p></header>
    {!product ? <><ProductCards business={business} tabletConnection={tabletConnection}/><p className="business-account-footnote">Each service keeps its own orders, settings and statements.</p></> : <>
      <Link className="business-account-back" to="/owner/connections">← All connections</Link>
      <section className="panel connection-journey" aria-labelledby="connection-journey-title">
        <header><ProductMark product={product}/><div><p className="eyebrow">{state.name}</p><h2 id="connection-journey-title">{proof ? "Confirm your business" : `Connect ${state.name}`}</h2></div></header>
        <Feedback error={error} notice={notice}/>
        {!canConnect ? <p>This connection is not available for your account. Ask your business owner or Cal-Eats support for help.</p> : proof ? <>
          <div className="connection-account-confirmation"><span>Connect this account</span><h3>{proof.sourceAccount?.name || state.name}</h3><p>to <strong>{business.name}</strong></p><small>Confirm before {shortDate(proof.expiresAt)}</small></div>
          <details className="business-account-reference"><summary>Account reference</summary><p>{proof.sourceAccount?.id}</p></details>
          {proof.mergeRequired && <p className="business-view-only-note">This connects <strong>{proof.mergeRequired.name || "the existing business account"}</strong> with <strong>{business.name}</strong>. Existing orders and financial history stay with their original service.</p>}
          <label className="check connection-confirm-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>I confirm these accounts are for the same restaurant and location{proof.mergeRequired ? ", and approve connecting them" : ""}.</span></label>
          <div className="button-row"><button className="primary" disabled={busy || !confirmed} onClick={() => void commit()}>{busy ? "Connecting…" : `Confirm connection`}</button><button className="quiet" disabled={busy} onClick={() => { setProof(null); setConfirmed(false); }}>Use another account</button></div>
        </> : <form onSubmit={verify}>
          <p>Verify your existing {state.name} owner account. Your password is used for this check and is not saved.</p>
          {sourceAccounts.length > 0 && <label>Restaurant account<select required value={selectedSource} disabled={busy} onChange={event => setSelectedSource(event.target.value)}><option value="">Select the correct restaurant and location</option>{sourceAccounts.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
          <label>Owner email<input name="email" type="email" required disabled={busy} autoComplete="username" placeholder="Email used for this account"/></label>
          <label>Password<input name="password" type="password" required disabled={busy} autoComplete="off"/></label>
          <button className="primary" disabled={busy}>{busy ? "Verifying…" : "Verify account"}</button>
          {state.nativeLinks?.onboarding && safeNativeLink(state.nativeLinks.onboarding) && <p className="fine"><a target="_top" href={safeNativeLink(state.nativeLinks.onboarding)}>Register a Calai account</a></p>}
        </form>}
        {product === "calai" && !proof && !busy && <CalaiOwnerTabletControls key={business.id} business={business} tabletConnection={tabletConnection}/>}
      </section>
    </>}
  </div>;
}
export function NativeCalaiView({ section = "orders" }) {
  const workspace = useBusinessWorkspace(), business = workspace?.business;
  const state = productPresentation(business, "calai");
  const tool = CALAI_WORKSPACE_TOOLS.find(({ id }) => id === section);
  const permitted = workspace?.mode !== "cal-eats" && state.allowedOnTablet !== false;
  const toolsAvailable = permitted && canUseCalaiWorkspaceTools(business, workspace?.mode);
  const showOrders = section === "orders" && toolsAvailable;
  const resource = useBusinessResource(showOrders ? "/api/business/calai/orders" : null, {
    poll: showOrders ? 30000 : 0,
    scope: business?.id,
  });
  if (!tool || !permitted) return <Navigate to="/owner/dashboard" replace/>;
  const nativeUrl = "https://calai.info" + tool.nativePath, rows = listItems(resource.value);

  return <div className="unified-business business-account-page business-native-page">
    <header className="page-heading business-account-heading"><p className="eyebrow">{business?.name || "Calai"}</p><h1>{tool.label}</h1></header>
    {toolsAvailable ? <section className="panel business-native-intro">
      <div><p>{showOrders ? "Open the original Calai order list for full order details." : "Use your existing Calai business sign-in to open this tool."}</p>
        <a className="button-link primary" target="_blank" rel="noopener noreferrer" href={nativeUrl}>Open {tool.label} in Calai</a>
      </div>
    </section> : <section className="panel business-native-intro">
      <div>{business?.principalKind === "terminal" && state.usable
        ? <><h2>Calai needs owner approval</h2><p>Ask the restaurant owner to choose <strong>Allow Calai on this tablet</strong> in Accounts &amp; connections.</p></>
        : <><h2>Check your Calai connection</h2><Link className="button-link" to="/owner/connections">Accounts &amp; connections</Link></>}</div>
    </section>}
    {showOrders && <section className="panel"><Resource {...resource}>{rows.length
      ? <div className="business-native-records">{rows.slice(0, 100).map((row, index) => <article key={row.id || index}><div><strong>{row.reference || row.orderNumber || row.id || "Order " + (index + 1)}</strong><small>{shortDate(row.createdAt || row.created_at)}</small></div><span className="pill">{row.status || "Recorded"}</span></article>)}</div>
      : <p className="empty">No Calai orders yet.</p>}</Resource></section>}
  </div>;
}

export function ProductStatements() {
  const workspace = useBusinessWorkspace(), business = workspace?.business; if (!business) return null;
  const calai = productPresentation(business, "calai"), eats = productPresentation(business, "cal-eats"), nativeStatement = safeNativeLink(calai.nativeLinks?.statements || calai.nativeLinks?.billing);
  const accounts = [calai, eats].filter(account => account.linked && account.allowedOnTablet !== false);
  return <div className="unified-business business-account-page business-statements-page">
    <header className="page-heading business-account-heading"><p className="eyebrow">{business.name}</p><h1>Statements</h1><p>View your statements and manage your weekly email summary.</p></header>
    <div className="business-product-cards business-statement-cards">{accounts.map(account => <section className="panel business-statement-card" key={account.product}>
      <header><ProductMark product={account.product}/><div><p className="eyebrow">{account.name}</p><h2>{account.product === "calai" ? "Usage & billing" : "Earnings & payouts"}</h2></div></header>
      <p>{account.product === "calai" ? "Your Calai subscription, usage and billing history." : "Your Cal-Eats orders, commission and payment statements."}</p>
      {account.financialAccess ? account.product === "calai" ? nativeStatement ? <a className="button-link primary" target="_top" href={nativeStatement}>View Calai statements</a> : <p className="business-statement-note">Use your usual Calai billing page to view statements. A direct statement link is not currently available.</p> : <Link className="button-link primary" to="/owner/earnings">View earnings & statements</Link> : <p className="business-statement-note">Statement access is managed by your business owner. Contact them if you need access.</p>}
      <details className="business-account-reference"><summary>Account details</summary><p>{account.nativeAccountId}</p></details>
    </section>)}</div>
    {!accounts.length && <section className="panel"><h2>No connected accounts</h2><p>Connect your business account to view its statements here.</p><Link className="button-link" to="/owner/connections">Accounts & connections</Link></section>}
    {accounts.includes(eats) && eats.financialAccess && eats.capabilities?.manageTerminal === true && business.eatsRestaurantId && <WeeklyStatements key={business.eatsRestaurantId} restaurantId={business.eatsRestaurantId}/>}
    {accounts.length > 1 && <p className="business-account-footnote">Calai and Cal-Eats statements are kept separately.</p>}
  </div>;
}
export function OrderingTabletSetup({business}){
  const allowed=business?.products?.["cal-eats"]?.linked===true&&business?.products?.["cal-eats"]?.capabilities?.manageTerminal===true;
  const root=business?.id?`/api/business/accounts/${encodeURIComponent(business.id)}/terminals`:null;
  const registry=useBusinessResource(allowed?root:null),[action,setAction]=useState(null),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const scope=useRef(business?.id);scope.current=business?.id;
  useEffect(()=>{setAction(null);setChecked(false);setError("");setNotice("");},[business?.id,allowed]);
  if(!allowed)return null;
  const registered=registry.value?.registered===true;
  function choose(next){setAction(next);setChecked(false);setError("");setNotice("");}
  async function confirm(){
    if(busy||!checked||!action)return;const expected=business.id,operation=action;setBusy(true);setError("");setNotice("");
    try{
      if(operation==="revoke"){
        await api(`${root}/revoke`,{...json("POST",{}),humanSession:true});
        if(scope.current!==expected)return;
        setNotice("Tablet access revoked. Its existing sessions can no longer process or print orders. Register a replacement before taking new orders.");
      }else{
        const setup=await api(`${root}/setup`,{...json("POST",{...(operation==="replace"?{replace:true}:{})}),humanSession:true});
        if(scope.current!==expected)return;
        const document=terminalSetupDocument(setup,{businessId:expected,apiOrigin:window.location.origin});
        const objectUrl=URL.createObjectURL(new Blob([document],{type:"application/json"})),link=window.document.createElement("a");link.href=objectUrl;link.download="CalEats-Tablet-Enrolment.json";link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
        setNotice(`One-use setup downloaded. It expires ${shortDate(setup.expiresAt)}. Keep it private and use it only on this restaurant’s Windows Surface.${operation==="replace"?" The old tablet remains registered until replacement enrolment completes.":""}`);
      }
      setAction(null);setChecked(false);await registry.reload();
    }catch(caught){if(scope.current===expected)setError(caught.message);}finally{if(scope.current===expected)setBusy(false);}
  }
  return <section className="panel business-tablet-enrolment"><header><p className="eyebrow">Owner-controlled device access</p><h2>Registered ordering Surface</h2><p>Only this restaurant’s enrolled Windows tablet can accept, update or print orders. Signing in on a phone or ordinary browser does not register a device.</p></header><Feedback error={error} notice={notice}/><Resource {...registry}><dl className="business-connection-details"><div><dt>Registration</dt><dd>{registered?registry.value.name||"Restaurant Surface":"No tablet registered"}</dd></div><div><dt>Last device contact</dt><dd>{registry.value?.lastContactAt?shortDate(registry.value.lastContactAt):"Not yet reported"}</dd></div></dl><p className="fine">Device registration and recent contact do not prove that the ordering application or physical printer is ready. Current observations are shown below.</p><ol className="business-setup-tasks"><li>Download the Windows installer for the restaurant’s ordering Surface.</li><li>Create the private, one-use enrolment file. Give both files to your Windows setup administrator, who must supply the enrolment file when running the installer within ten minutes.</li><li>Open the business platform on that Surface and check application presence and printer status.</li></ol><div className="button-row"><a className="button-link" href={`${root}/installer`}>Download Windows installer</a><button className="primary" disabled={busy||registry.loading||Boolean(registry.error)} onClick={()=>choose(registered?"replace":"enrol")}>{registered?"Replace registered tablet":"Create tablet enrolment"}</button>{registered&&<button className="quiet danger" disabled={busy||registry.loading} onClick={()=>choose("revoke")}>Revoke tablet access</button>}</div><p className="fine">The installer keeps Calai’s existing service separate. Organisation-managed Windows tablets may need their administrator to allow the reviewed local connection policy.</p></Resource>{action&&<WorkspaceDialog title={action==="revoke"?"Revoke this ordering tablet?":action==="replace"?"Prepare a replacement Surface":"Prepare this restaurant’s Surface"} onClose={()=>{if(!busy)setAction(null);}}><p>{action==="revoke"?"This immediately removes this tablet’s operational access. Orders remain recorded. There is no remote acceptance fallback.":action==="replace"?"The replacement file is short-lived and single-use. The current Surface is revoked only when the replacement successfully enrols; copying the file does not copy its Windows device key.":"This private file authorises one Windows device enrolment for this restaurant and location. It does not grant owner or payout access."}</p><label className="check-label"><input type="checkbox" checked={checked} disabled={busy} onChange={event=>setChecked(event.target.checked)}/><span>{action==="revoke"?"I confirm this tablet should lose its operational access.":`I confirm this setup is for ${business.name} at the correct location.`}</span></label><div className="button-row"><button className="primary" disabled={busy||!checked} onClick={()=>void confirm()}>{busy?"Preparing…":action==="revoke"?"Revoke tablet":"Download one-use enrolment"}</button><button className="quiet" disabled={busy} onClick={()=>setAction(null)}>Cancel</button></div></WorkspaceDialog>}</section>;
}
export function StaffCapabilityControls({restaurantId,person,onSaved,requestRoot}){
  const fields=[["viewFinance","View earnings & payouts"],["viewDevices","View devices"],["manageMenu","Manage menu"],["manageMarketing","Manage marketing"]];
  const [draft,setDraft]=useState(()=>Object.fromEntries(fields.map(([key])=>[key,person.capabilities?.[key]===true]))),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{setDraft(Object.fromEntries(fields.map(([key])=>[key,person.capabilities?.[key]===true])));},[person.id,person.capabilities]);
  async function save(event){event.preventDefault();if(busy)return;setBusy(true);setError("");setNotice("");try{const base=requestRoot||`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/staff`;await api(`${base}/${encodeURIComponent(person.id)}/capabilities`,{...json("PATCH",draft),humanSession:true});setNotice("Staff permissions saved. Order processing remains restricted to the registered Surface.");await onSaved?.();}catch(caught){setError(caught.message);}finally{setBusy(false);}}
  return <form className="staff-capability-controls" onSubmit={save} aria-label={`Permissions for ${person.name}`}><fieldset disabled={busy}><legend>Additional staff permissions</legend><div>{fields.map(([key,label])=><label key={key}><input type="checkbox" checked={draft[key]} onChange={event=>setDraft(old=>({...old,[key]:event.target.checked}))}/>{label}</label>)}</div></fieldset><Feedback error={error} notice={notice}/><button className="quiet" disabled={busy}>{busy?"Saving permissions…":"Save staff permissions"}</button></form>;
}
export function AdminBusinessAccounts() {
  const [params, setParams] = useSearchParams(), selected = params.get("business"), [q, setQ] = useState(""), [product, setProduct] = useState("all"), [page, setPage] = useState(1);
  const [syncBusy,setSyncBusy]=useState(false),[syncError,setSyncError]=useState(""),[syncNotice,setSyncNotice]=useState(""),syncPending=useRef(false);
  const directory = useBusinessResource(`/api/admin/business/accounts?${accountDirectoryQuery({ q, product, page })}`), detail = useBusinessResource(selected ? `/api/admin/business/accounts/${encodeURIComponent(selected)}` : null);
  async function syncCalai(){if(syncPending.current)return;syncPending.current=true;setSyncBusy(true);setSyncError("");setSyncNotice("");try{await api("/api/admin/business/accounts/sync-calai",json("POST",{}));await directory.reload();setSyncNotice("Calai account references synchronised. Native Calai accounts and settings were not changed.");}catch(caught){setSyncError(caught.message);}finally{syncPending.current=false;setSyncBusy(false);}}
  useEffect(() => setPage(1), [q, product]);
  const items = listItems(directory.value), pagination = directory.value?.pagination;
  return <div className="unified-business"><header className="page-heading"><p className="eyebrow">Platform administration</p><h1>Business accounts & products</h1><p>Manage Calai connection permission and Cal-Eats service enablement independently for every restaurant and location.</p><button className="quiet" disabled={syncBusy} onClick={()=>void syncCalai()}>{syncBusy?"Synchronising…":"Sync Calai account references"}</button></header><Feedback error={syncError} notice={syncNotice}/>{selected ? <><button className="quiet" onClick={() => setParams({})}>← All business accounts</button><Resource {...detail}><h2>{detail.value?.name}</h2>{detail.value && <ProductCards key={detail.value.id} business={detail.value} admin onSaved={detail.reload}/>}</Resource></> : <><section className="panel"><div className="business-account-filters"><label>Find a business<input type="search" value={q} maxLength={100} onChange={event => setQ(event.target.value)} placeholder="Business or native account reference"/></label><label>Products<select value={product} onChange={event => setProduct(event.target.value)}><option value="all">All business accounts</option><option value="calai">Calai accounts</option><option value="cal-eats">Cal-Eats accounts</option><option value="both">Connected to both products</option></select></label></div><Resource {...directory}>{items.length ? <div className="business-native-records">{items.map((row, index) => <article key={row.id}><span className="admin-rest-number">{(page - 1) * 25 + index + 1}</span><div><strong>{row.name}</strong><small>{BUSINESS_PRODUCTS.filter(key => productPresentation(row, key).linked).map(productName).join(" · ") || "Connection not completed"}</small></div><button className="primary" onClick={() => setParams({ business: row.id })}>Manage products</button></article>)}</div> : <p className="empty">No matching business accounts.</p>}</Resource>{pagination && <nav className="pagination" aria-label="Business account pages"><button className="quiet" disabled={!pagination.hasPrevious} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {pagination.page || page} · {pagination.total || 0} accounts</span><button className="quiet" disabled={!pagination.hasNext} onClick={() => setPage(value => value + 1)}>Next</button></nav>}</section></>}</div>;
}
export function AdminRestaurantProducts({ restaurantId }) {
  const resource = useBusinessResource(`/api/admin/business/accounts?restaurantId=${encodeURIComponent(restaurantId)}&page=1&pageSize=25`), business = listItems(resource.value).find(row => row.eatsRestaurantId === restaurantId || row.products?.["cal-eats"]?.nativeAccountId === restaurantId || row.products?.["cal-eats"]?.sourceAccountId === restaurantId);
  return <section className="admin-restaurant-products"><h2>Product accounts & permission</h2>{resource.error ? <Feedback error={resource.error}/> : business ? <ProductCards key={business.id} business={business} admin onSaved={resource.reload}/> : <p role="status">{resource.loading ? "Loading product accounts…" : "No linked workspace has been recorded for this restaurant."}</p>}<Link className="button-link" to="/admin/business-accounts">View all product accounts, including Calai-only businesses</Link></section>;
}
export function AdminSurfaceMonitoring() {
  const [page,setPage]=useState(1),[filter,setFilter]=useState("offline");
  const resource = useBusinessResource(`/api/admin/surface-monitoring?page=${page}&pageSize=25${filter?`&state=${filter}`:""}`, { poll: 30000 }), rows = listItems(resource.value);
  return <div className="unified-business"><header className="page-heading"><p className="eyebrow">Platform operations</p><h1>Surface monitoring</h1><p>Current Cal-Eats application presence and printer observations, scoped to each restaurant and location.</p></header><label>Surface status<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(1);}}><option value="offline">Offline businesses</option><option value="">All states</option><option value="online">Online</option><option value="closed">Closed</option><option value="setup_required">Setup required</option><option value="disabled_by_admin">Disabled by admin</option><option value="monitoring_unavailable">Monitoring unavailable</option></select></label>{resource.value?.monitoring?.state&&resource.value.monitoring.state!=="online"&&<p className="alert" role="alert">Central monitoring status: {resource.value.monitoring.state}. Individual restaurant faults cannot be confirmed while monitoring is unavailable.</p>}<Resource {...resource}><div className="business-native-records">{rows.map(row => <article key={`${row.restaurantId}:${row.product || "cal-eats"}`}><div><strong>{row.restaurantName}</strong><span className="pill">{deviceStateLabel(row.state)}</span><p>{row.observedReason}</p><small>Expected opening: {row.expectedOpeningPeriod ? `${shortDate(row.expectedOpeningPeriod.startsAt)} – ${shortDate(row.expectedOpeningPeriod.endsAt)}` : "Currently closed or schedule unavailable"}</small><small>Last application contact: {shortDate(row.lastApplicationContactAt)} · Outage: {Math.floor((row.outageDurationSeconds || 0) / 60)} minutes</small></div><div><strong>{row.printer?.label || "Printer status unavailable"}</strong><Link className="button-link" to={`/admin/restaurants?restaurant=${encodeURIComponent(row.restaurantId)}`}>View restaurant</Link></div></article>)}</div>{!rows.length && <p className="empty">No matching restaurant status is available.</p>}</Resource><BusinessPages pagination={resource.value?.pagination} onPage={setPage}/><p className="fine">Surface presence is separate from Calai voice-service status. A missing heartbeat does not change administrator permission or prove a physical cause.</p><AdminMonitoringSettings/></div>;
}
function AdminMonitoringSettings(){
  const settings=useBusinessResource("/api/admin/surface-monitoring/settings"),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const fields=[["heartbeatSeconds","Application heartbeat (seconds)"],["evaluationSeconds","Backend evaluation (seconds)"],["staleSeconds","Contact becomes stale after (seconds)"],["openingGraceSeconds","Missing sign-in grace at opening (seconds)"],["reauthenticationGraceSeconds","Reauthentication notification grace (seconds)"],["recoverySeconds","Stable recovery before notification (seconds)"],["reminderSeconds","One additional reminder after (seconds)"],["printerStaleSeconds","Printer observation becomes stale after (seconds)"],["printerFaultGraceSeconds","Printer connectivity fault grace (seconds)"]];
  useEffect(()=>{if(settings.value)setDraft(Object.fromEntries(fields.map(([key])=>[key,String(settings.value[key]??"")])));},[settings.value]);
  async function save(event){event.preventDefault();if(busy||!draft)return;setBusy(true);setError("");setNotice("");try{await api("/api/admin/surface-monitoring/settings",json("PATCH",Object.fromEntries(fields.map(([key])=>[key,Number(draft[key])]))));await settings.reload();setNotice("Monitoring timing updated. Known logout or expiry is still shown as offline immediately; the grace only delays notification.");}catch(caught){setError(caught.message);}finally{setBusy(false);}}
  return <section className="panel business-monitoring-controls"><h2>Administrator monitoring defaults</h2><p>Timings apply to Cal-Eats monitoring. They do not change native Calai settings or administrator service enablement.</p><Feedback error={error||settings.error} notice={notice}/>{draft?<form onSubmit={save}><div className="form-grid">{fields.map(([key,label])=><label key={key}>{label}<input type="number" required min={["openingGraceSeconds","reauthenticationGraceSeconds"].includes(key)?0:key==="reminderSeconds"?60:10} max={key==="reminderSeconds"?86400:key==="reauthenticationGraceSeconds"?60:600} step="1" disabled={busy} value={draft[key]} onChange={event=>setDraft(old=>({...old,[key]:event.target.value}))}/></label>)}</div><button className="primary" disabled={busy}>{busy?"Saving…":"Save monitoring timing"}</button></form>:<p role="status">{settings.loading?"Loading monitoring settings…":"Monitoring settings are unavailable."}</p>}</section>;
}

function BusinessPages({pagination,onPage}){if(!pagination)return null;const current=pagination.page||1,totalPages=Math.max(1,pagination.totalPages||1);return <nav className="pagination" aria-label="Result pages"><button className="quiet" disabled={current<=1} onClick={()=>onPage(current-1)}>Previous</button><span>Page {current} of {totalPages} · {pagination.total||0} records</span><button className="quiet" disabled={current>=totalPages} onClick={()=>onPage(current+1)}>Next</button></nav>;}
