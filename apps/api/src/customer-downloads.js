// Public distribution is deliberately separate from invited testing channels.
// Enable each platform only after its public store listing has been verified.
export function customerDownloadConfig(env = process.env) {
  const release = (platform) => {
    const prefix = platform === "ios" ? "CALAI_IOS_PUBLIC_APP" : "CALAI_ANDROID_PUBLIC_APP";
    if (env[`${prefix}_AVAILABLE`] !== "true") return { available: false, url: null };
    let url;
    try { url = new URL(env[`${prefix}_URL`]); } catch { throw new Error(`${prefix}_URL must be a verified public store URL`); }
    const secure = url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash;
    const target = platform === "ios"
      ? url.hostname === "apps.apple.com" && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id6831180948\/?$/.test(url.pathname) && !url.search
      : url.hostname === "play.google.com" && url.pathname === "/store/apps/details" && url.searchParams.get("id") === "uk.co.calai.caleats" && [...url.searchParams.keys()].length === 1;
    if (!secure || !target) throw new Error(`${prefix}_URL must identify the public Cal-Eats store listing`);
    return { available: true, url: url.href };
  };
  return { ios: release("ios"), android: release("android") };
}

export function preserveCustomerWebFlow(search = "") {
  const params = new URLSearchParams(search);
  return params.get("view") === "register-restaurant" || /^[A-Za-z0-9_-]{1,100}$/.test(params.get("payment_order") || "");
}
