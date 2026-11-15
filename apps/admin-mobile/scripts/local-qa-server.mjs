// Development only: the real API with a disposable synthetic database and
// test signing adapter. This is not the Windows device-authority implementation.
import http from "node:http";

if (!process.argv.includes("--isolated-fixture") || process.env.NODE_ENV === "production") {
  console.error("Use --isolated-fixture for local development only.");
  process.exit(1);
}
// Do not inherit real payment, mail, push, storage or legal activation settings.
// This process never reads an .env file and always binds to loopback.
for (const key of Object.keys(process.env)) {
  if (/^(CALAI_|STRIPE_|AZURE_|VITE_|EXPO_PUBLIC_)/i.test(key)) delete process.env[key];
}
const { businessDeviceFixture } = await import("../../api/test/business-device-fixture.js");
const { createApp } = await import("../../api/src/app.js");
const fixture = await businessDeviceFixture({
  port: 4350, now: () => new Date(), runMode: "local", nodeEnv: "development",
  paymentProviderMode: "local_simulator", livePaymentsEnabled: false,
  orderAlertEmail: { mode: "off" }, businessStatements: { sendEnabled: false },
  businessPush: { enabled: false }, customerPush: { enabled: false }
});
let server, timer, pending = null, closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await pending;
  if (server?.listening) {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await fixture.close();
}
try {
  const staff = await fixture.json(`/api/restaurant/restaurants/${fixture.restaurant.id}/staff`, {
    method: "POST", cookie: fixture.owner,
    body: { name: "QA manager", email: "manager@calai.local", password: "LocalManager!4310" }
  });
  if (staff.status !== 201) throw new Error("Unable to create the isolated manager fixture.");
  const customer = await fixture.login("customer@calai.local", "LocalCustomer!4310");
  const item = fixture.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1").get(fixture.restaurant.id);
  for (let index = 0; index < 3; index++) {
    const order = await fixture.json("/api/orders", {
      method: "POST", cookie: customer, headers: { "Idempotency-Key": `admin-local-qa-${index}` },
      body: { restaurantId: fixture.restaurant.id, items: [{ menuItemId: item.id, quantity: index + 1 }], fulfillment: "collection", paymentMethod: "mock_card" }
    });
    if (order.status !== 201) throw new Error("Unable to create an isolated sample order.");
    if (index < 2) {
      const accepted = await fixture.signed(`/api/restaurant/orders/${order.body.data.id}/status`, { status: "accepted" }, { method: "PATCH" });
      if (accepted.status !== 200) throw new Error("Unable to accept an isolated sample order.");
    }
  }
  await fixture.report("unknown", "none");
  server = http.createServer(createApp({ db: fixture.db, config: fixture.config }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4350, "127.0.0.1", resolve);
  });
  timer = setInterval(() => {
    if (pending || closing) return;
    pending = (async () => {
      await fixture.pulse();
      await fixture.report("unknown", "none");
    })().catch(() => console.error("The simulated tablet heartbeat failed; restart the isolated fixture.")).finally(() => { pending = null; });
  }, 15000);
  console.log("Cal Eats Admin isolated QA API: http://127.0.0.1:4350");
  console.log("Synthetic owner: restaurant@calai.local / LocalRestaurant!4310");
  console.log("Synthetic manager: manager@calai.local / LocalManager!4310");
  console.log("No real payment, email, push or printer connection. Device health is simulated; physical readiness is unknown.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void close().then(() => process.exit(0)));
} catch (error) {
  await close();
  throw error;
}
