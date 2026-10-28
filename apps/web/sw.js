const CACHE="calai-public-v15";
const PUBLIC=["/offline.html","/styles.css","/app.js","/checkout-attempt.js","/model.js","/live-notifications.js","/order-messaging.js","/dispute-resolution.js","/loyalty-ui.js","/customer-additions.js","/stripe-ui.js","/customer-contact.js","/calai-theme.css","/manifest.webmanifest","/assets/calai-original.png","/assets/cal-eats-logo.png","/assets/food-demo.png","/assets/calai-icon.svg","/assets/calai-icon-maskable.svg"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PUBLIC)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("calai-public-")&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return;
  if(event.request.mode==="navigate"){event.respondWith(fetch(event.request).catch(()=>caches.match("/offline.html")));return;}
  if(url.pathname.startsWith("/api/")){event.respondWith(fetch(event.request));return;}
  if(PUBLIC.includes(url.pathname) && !url.search) event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{}));}return response;}).catch(()=>caches.match(event.request)));
});
