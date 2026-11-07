export function accessLinkDestination(hash = "") {
  return /^#(?:reset-password|verify-email)=[^\s]+$/.test(hash) ? `/account-access/${hash}` : null;
}

export function preserveCustomerWebFlow(search = "") {
  const params = new URLSearchParams(search);
  return params.get("view") === "register-restaurant" || /^[A-Za-z0-9_-]{1,100}$/.test(params.get("payment_order") || "");
}

export function storePlatform({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  if (/android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1)) return "ios";
  return null;
}

export function publicStoreDestination(config, device) {
  const entry = config?.[device];
  if (!entry?.available || typeof entry.url !== "string") return null;
  try {
    const url = new URL(entry.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    if (device === "ios" && url.hostname === "apps.apple.com" && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id6831180948\/?$/.test(url.pathname) && !url.search) return url.href;
    if (device === "android" && url.hostname === "play.google.com" && url.pathname === "/store/apps/details" && url.searchParams.get("id") === "uk.co.calai.caleats" && [...url.searchParams.keys()].length === 1) return url.href;
  } catch { /* An unavailable or unverified destination remains disabled. */ }
  return null;
}

export async function initializeDownloads({ document, location, navigator, fetch }) {
  const access = accessLinkDestination(location.hash);
  if (access) { location.replace(access); return; }
  const buttons = [...document.querySelectorAll("[data-store]")];
  if (!buttons.length) return;
  let config;
  try {
    const response = await fetch("/app-downloads.json", { credentials: "omit", cache: "no-store" });
    if (!response.ok) return;
    config = await response.json();
  } catch { return; }
  let available = false;
  for (const button of buttons) {
    const device = button.dataset.store, destination = publicStoreDestination(config, device);
    if (!destination) continue;
    available = true;
    button.disabled = false;
    button.querySelector("[data-store-status]").textContent = device === "ios" ? "Download on the App Store" : "Get it on Google Play";
    button.addEventListener("click", () => location.assign(destination));
  }
  const device = storePlatform(navigator), destination = publicStoreDestination(config, device);
  if (available) {
    for (const node of document.querySelectorAll("[data-download-status]")) node.textContent = "Choose your phone to get Cal-Eats.";
  }
  // Only the dedicated download page auto-opens a verified public listing.
  // No account, order, query-string or fragment data is sent to a store.
  if (document.body.dataset.autoDownload === "true" && destination) location.replace(destination);
}
