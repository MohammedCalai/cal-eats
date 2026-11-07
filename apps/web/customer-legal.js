const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function customerLegalPayload(status, termsAccepted) {
  if (!status) throw Error("Wait for your account information to load before continuing.");
  if (!status.enabled) return undefined;
  if (status.termsAcceptanceRequired && termsAccepted !== true) throw Error("Please read and accept the Customer Terms before continuing.");
  return {
    ...(status.termsAcceptanceRequired ? { termsVersion: status.terms.version, termsSha256: status.terms.sha256, termsAccepted: true } : {}),
    ...(status.privacyAcknowledgementRequired ? { privacyVersion: status.privacy.version, privacySha256: status.privacy.sha256, privacyNoticeAcknowledged: true } : {})
  };
}
function documentURL(value, origin) {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/legal/")) throw Error("The document link could not be verified.");
  return url.href;
}
export function customerLegalHtml(status, origin) {
  if (!status?.enabled || !status.termsAcceptanceRequired && !status.privacyAcknowledgementRequired) return "";
  return `<fieldset class="customer-legal-review"><legend>Before you continue</legend><p><a href="${escape(documentURL(status.terms.url, origin))}" target="_blank" rel="noopener">Read Customer Terms</a> · <a href="${escape(documentURL(status.privacy.url, origin))}" target="_blank" rel="noopener">Read Privacy Notice</a></p>${status.termsAcceptanceRequired ? '<label class="customer-legal-check"><input type="checkbox" data-legal-terms required><span>I accept the Customer Terms.</span></label>' : ""}${status.privacyAcknowledgementRequired ? '<p class="meta">The Privacy Notice explains how your information is used. Continuing records that this notice was provided; it is not general consent to processing.</p>' : ""}<p class="meta">Offers and marketing preferences are a separate choice in your account.</p></fieldset>`;
}
export function mountCustomerLegal(container, { api, origin = location.origin } = {}) {
  let status = null, revision = 0, closed = false;
  const connected = () => !closed && container?.isConnected;
  async function refresh() {
    const request = ++revision; status = null;
    if (!connected()) return;
    container.innerHTML = '<p class="meta" role="status">Checking account information…</p>';
    try {
      const next = await api("/api/customer/legal");
      if (!connected() || request !== revision) return;
      status = next; container.innerHTML = customerLegalHtml(next, origin);
    } catch (error) {
      if (!connected() || request !== revision) return;
      container.innerHTML = `<p class="error" role="alert">${escape(error.message)}</p><button type="button" class="quiet" data-legal-reload>Reload account information</button>`;
    }
  }
  const click = event => { if (event.target.closest("[data-legal-reload]")) void refresh(); };
  container.addEventListener("click", click); void refresh();
  return {
    payload() { if (!connected()) throw Error("Return to the current form before continuing."); return customerLegalPayload(status, Boolean(container.querySelector("[data-legal-terms]")?.checked)); },
    async acceptForNewOrder() {
      const body = this.payload();
      if (!body || !status.termsAcceptanceRequired && !status.privacyAcknowledgementRequired) return;
      const request = revision;
      try { const next = await api("/api/customer/legal/acceptances", { method: "POST", body: JSON.stringify(body) }); if (connected() && request === revision) { status = next; container.innerHTML = customerLegalHtml(next, origin); } }
      catch (error) { await refresh(); throw error; }
    },
    close() { closed = true; revision++; container.removeEventListener("click", click); }
  };
}
