import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { businessFixture } from './unified-business-test-fixture.js';

test('the combined live order gauge matches the scoped restaurant kitchen through a partial Calai outage', async () => {
  const f = await businessFixture();
  try {
    const dashboard = async (session = f.session) => (await f.call('/api/business/dashboard', { session })).body.data;
    assert.equal((await dashboard()).eatsLiveOrders, null);
    await f.allow('calai');
    assert.equal((await f.link()).status, 200);
    const restaurant = f.restaurant;
    const other = f.db.prepare('SELECT restaurant_id FROM restaurant_memberships WHERE user_id=?').get(f.otherOwner.id);
    const customer = f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get();
    const add = f.db.prepare(`INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,
      subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,
      request_hash,created_at,updated_at,merchant_visible_at,confirmed_at)
      VALUES(?,?,'Kitchen',?,?,'GBP',500,500,35,'cash','cash_due','collection',?,'fixture',?,?,?,?)`);
    const now = f.config.now().toISOString(), yesterday = new Date(f.config.now().getTime() - 86400000).toISOString();
    function order(location, status, at = now, visible = true) {
      const id = randomUUID();
      add.run(id, location, customer.id, status, id, at, at, visible ? at : null, status === 'placed' ? null : at);
    }
    order(restaurant.id, 'ready', yesterday);
    order(restaurant.id, 'accepted');
    order(restaurant.id, 'placed');
    order(restaurant.id, 'placed', now, false);
    order(restaurant.id, 'out_for_delivery');
    order(restaurant.id, 'completed');
    order(other.restaurant_id, 'preparing');
    const expected = { liveOrders: 3, pendingConfirmation: 1, confirmedInKitchen: 1, readyForHandover: 1 };
    assert.deepEqual((await dashboard()).eatsLiveOrders, expected);
    f.state.available = false;
    const partial = await dashboard();
    assert.equal(partial.calaiLiveCalls, null);
    assert.equal(partial.counts.total.today, null);
    assert.deepEqual(partial.eatsLiveOrders, expected);
    assert.equal((await dashboard(f.otherSession)).eatsLiveOrders, null);
    await f.allow('cal-eats', false);
    assert.equal((await dashboard()).eatsLiveOrders, null);
  } finally {
    await f.close();
  }
});
