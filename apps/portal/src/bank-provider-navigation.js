export function bankProviderDestination(url, allowedHosts, browser = window) {
  const destination = new URL(url);
  if (destination.protocol !== "https:" || !allowedHosts.includes(destination.host) ||
      destination.username || destination.password) {
    throw new Error("The payment service returned an unexpected destination. Refresh and try again.");
  }
  // The combined workspace keeps listening for orders and messages during secure bank setup.
  if (browser.parent !== browser) return destination.href;
  browser.location.assign(destination.href);
  return null;
}
