const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function emailVerificationBannerHtml(user,status) {
  if(user?.role!=="customer"||status?.verificationRequired!==true||status.emailVerified!==false||status.canOrder!==false)return "";
  return '<button type="button" class="customer-email-banner-button" data-action="email-verification-options" aria-label="Verify your email to order. Open email verification options."><span class="customer-email-banner-symbol" aria-hidden="true">✉</span><span>Verify your email to order</span><span class="customer-email-banner-arrow" aria-hidden="true">→</span></button>';
}

export function emailVerificationStatus(value) {
  if (!value || typeof value.email !== "string" || !["emailVerified", "verificationRequired", "canOrder"].every(key => typeof value[key] === "boolean") || value.canOrder !== (value.emailVerified || !value.verificationRequired) || !["email", "local_simulation", "unavailable"].includes(value.delivery) || value.resendAvailableAt != null && (typeof value.resendAvailableAt !== "string" || !Number.isFinite(Date.parse(value.resendAvailableAt)))) throw Error("We couldn’t check your email confirmation. Please try again.");
  return value;
}

export function emailVerificationHtml(value, { now = Date.now(), busy = false, feedback = "", error = "", welcome = false } = {}) {
  const status = value ? emailVerificationStatus(value) : null;
  const remaining = status?.resendAvailableAt ? Math.max(0, Math.ceil((Date.parse(status.resendAvailableAt) - now) / 1000)) : 0;
  if (status?.emailVerified) return `<div class="email-verification-panel email-verification-complete"><strong>Email confirmed</strong><p>${escape(status.email)} is ready for order updates.</p><p role="status">${escape(feedback || "You can place an order.")}</p></div>`;
  const delivery = status?.delivery === "local_simulation" ? "This local preview records confirmation links on this computer; no email was sent." : status?.delivery === "unavailable" ? "Email delivery is temporarily unavailable. You can still contact support and manage your account." : "Open the latest Cal-Eats email and press Confirm email. Check spam or junk if you can’t find it.";
  return `<div class="email-verification-panel"><div class="eyebrow">${welcome ? "Welcome to Cal-Eats" : "Email confirmation"}</div><h2>${status?.verificationRequired ? "Confirm your email before ordering" : "Confirm your email address"}</h2>${status ? `<p class="verification-email">${escape(status.email)}</p><p>${escape(delivery)}</p>${!status.verificationRequired ? '<p class="meta">You can keep using your existing account.</p>' : '<p class="meta">Your account is created. You can browse, contact support and manage your account while you confirm your email.</p>'}` : `<p role="status">${error ? 'Your email confirmation status is temporarily unavailable.' : 'Checking your email confirmation…'}</p>`}<div class="card-actions"><button type="button" class="primary" data-email-check ${busy ? "disabled" : ""}>${busy ? "Checking…" : "I’ve confirmed · Check status"}</button>${status ? `<button type="button" class="secondary" data-email-resend ${busy || remaining ? "disabled" : ""}>${remaining ? `Resend in ${remaining}s` : "Resend confirmation email"}</button>` : ""}</div><p class="meta" role="status" data-email-feedback>${escape(feedback)}</p><p class="form-error" role="alert">${escape(error)}</p></div>`;
}

export function mountEmailVerification(container, { api, initial = null, welcome = false, onChange = () => {}, now = Date.now, hostWindow = globalThis.window, hostDocument = globalThis.document } = {}) {
  let status = initial ? emailVerificationStatus(initial) : null, closed = false, busy = false, timer = null, revision = 0, feedback = "", error = "";
  const connected = () => !closed && container?.isConnected;
  const tickCooldown = () => {
    timer = null;
    if (!connected()) return;
    const remaining = status?.resendAvailableAt ? Math.max(0, Math.ceil((Date.parse(status.resendAvailableAt) - now()) / 1000)) : 0;
    const button = container.querySelector?.("[data-email-resend]");
    if (button) { button.disabled = busy || remaining > 0; button.textContent = remaining ? `Resend in ${remaining}s` : "Resend confirmation email"; }
    if (remaining && !status?.emailVerified) timer = setTimeout(tickCooldown, 1000);
  };
  const draw = () => {
    clearTimeout(timer); timer = null;
    if (!connected()) return;
    container.innerHTML = emailVerificationHtml(status, { now: now(), busy, feedback, error, welcome });
    if (status?.resendAvailableAt && Date.parse(status.resendAvailableAt) > now() && !status.emailVerified) timer = setTimeout(tickCooldown, 1000);
  };
  async function request(resend = false) {
    if (busy || !connected()) return status;
    if (resend && status?.resendAvailableAt && Date.parse(status.resendAvailableAt) > now()) return status;
    const own = ++revision; busy = true; error = ""; feedback = ""; draw();
    try {
      const next = await api(`/api/auth/email-verification/${resend ? "send" : "status"}`, resend ? { method: "POST", body: "{}" } : {});
      if (!connected() || own !== revision) return null;
      status = emailVerificationStatus(next);
      if (resend && !status.emailVerified) feedback = status.delivery === "unavailable" ? "We couldn’t send an email right now. Try again later or contact support." : next.resent === false ? "A confirmation was requested recently. Please wait before sending another." : status.delivery === "local_simulation" ? "A new confirmation link was recorded locally. No email was sent." : "A new confirmation email is on its way. Use the newest link.";
      else if (status.emailVerified) feedback = "Your email is confirmed.";
      else feedback = "Your email has not been confirmed yet. Open the latest email, then check again.";
      onChange(status);
      return status;
    } catch (failure) {
      if (connected() && own === revision) error = failure.message;
      return null;
    } finally { if (connected() && own === revision) { busy = false; draw(); } }
  }
  const click = event => {
    const button = event.target.closest("[data-email-check],[data-email-resend]");
    if (!button) return;
    event.preventDefault(); event.stopPropagation(); void request(button.hasAttribute("data-email-resend"));
  };
  const resume = () => { if (!hostDocument?.hidden && !status?.canOrder) void request(); };
  container.addEventListener("click", click); hostWindow?.addEventListener("focus", resume); hostDocument?.addEventListener("visibilitychange", resume);
  draw(); if (!status) void request();
  return { refresh: () => request(), resend: () => request(true), get status() { return status; }, close() { closed = true; revision++; clearTimeout(timer); container.removeEventListener("click", click); hostWindow?.removeEventListener("focus", resume); hostDocument?.removeEventListener("visibilitychange", resume); } };
}

export function emailConfirmationHtml({ confirmed = false, busy = false, error = "", invalid = false } = {}) {
  if (confirmed) return `<div class="eyebrow">Account confirmed</div><h1>Your email is confirmed</h1><div class="notice" role="status">You’re ready to order with Cal-Eats.</div><p>Return to the Cal-Eats app or the browser tab where you signed up. Tap <strong>Check status</strong> if the confirmation is not showing yet.</p><a class="primary" href="caleats://">Open Cal-Eats app</a><a class="quiet" href="/download/">Get the Cal-Eats app</a>`;
  return `<div class="eyebrow">Cal-Eats account</div><h1>Confirm your email</h1><p>${invalid ? "This confirmation link is incomplete or invalid. Open the latest email, or request a new link from Account in Cal-Eats." : "Press Confirm email to verify your address. Opening this page alone does not confirm it."}</p>${invalid ? "" : `<button type="button" class="primary" data-email-confirm ${busy ? "disabled" : ""}>${busy ? "Confirming…" : "Confirm email"}</button>`}<p class="form-error" role="alert">${escape(error)}</p><p class="meta">If your link has expired, return to Account in Cal-Eats to resend it. You can still contact <a href="mailto:support@calai.info">support@calai.info</a>.</p>`;
}

// A fragment never reaches the server. Mounting only renders a deliberate
// confirmation button; email scanners and page GETs cannot consume the token.
export function mountEmailConfirmation(container, { api, token, onConfirmed = () => {} } = {}) {
  let closed = false, busy = false, confirmed = false, error = "", secret = token;
  const invalid = typeof secret !== "string" || !/^[A-Za-z0-9_-]{40,100}$/.test(secret);
  const draw = () => { if (!closed && container.isConnected) container.innerHTML = emailConfirmationHtml({ confirmed, busy, error, invalid }); };
  async function confirm() {
    if (closed || busy || confirmed || invalid || !container.isConnected) return;
    busy = true; error = ""; draw();
    try {
      const result = await api("/api/auth/email-verification/confirm", { method: "POST", body: JSON.stringify({ token: secret }) });
      if (closed || !container.isConnected) return;
      if (result?.emailVerified !== true) throw Error("We couldn’t confirm your email. Please try again.");
      secret = null; confirmed = true; onConfirmed();
    } catch (failure) { if (!closed && container.isConnected) error = failure.code === "TOKEN_INVALID" ? "This link has expired or has already been used. Return to Account in Cal-Eats to check your status or request a new link." : failure.message; }
    finally { busy = false; draw(); }
  }
  const click = event => { if (event.target.closest("[data-email-confirm]")) { event.preventDefault(); event.stopPropagation(); void confirm(); } };
  container.addEventListener("click", click); draw();
  return { confirm, close() { closed = true; secret = null; container.removeEventListener("click", click); } };
}
