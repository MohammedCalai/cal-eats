import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { journeyFixture } from './helpers.js';
import { createApp } from '../src/app.js';
import { customerErasureWriteError } from '../src/customer-erasure.js';

const policy = { enabled: true, version: 'privacy-fixture-v1', approvedAt: '2026-01-01T00:00:00.000Z', approvalReference: 'isolated-fixture-review-only', deletionTargetDays: 30, deletionTargetCalendarMonths: 1, retention: { chatDays: 30, allergyDays: 30, orderContactDays: 90, resolvedSupportDays: 30, accountingYears: 6 } };

test('only exact SQLite customer-erasure guards become account-erased conflicts', () => {
  for (const message of ['Customer account has been erased', 'Erased customer profiles cannot be restored', 'Erased order contact information cannot be restored', 'Erased support content cannot be restored']) {
    const mapped = customerErasureWriteError({ code: 'ERR_SQLITE_ERROR', message });
    assert.equal(mapped.status, 409); assert.equal(mapped.code, 'ACCOUNT_ERASED');
  }
  for (const error of [null, new Error('Customer account has been erased'), { code: 'ERR_SQLITE_ERROR', message: 'database is locked' }, { code: 'ERR_SQLITE_ERROR', message: 'Customer erasure tombstones are immutable' }, { code: 'ERR_SQLITE_ERROR', message: 'prefix Customer account has been erased' }]) assert.equal(customerErasureWriteError(error), null);
});

test('an address save authenticated before completed erasure returns a clear conflict and cannot restore personal data', async () => {
  const f = await journeyFixture({ customerPrivacy: policy, rateLimit: { attempts: 100, windowMs: 60000 } });
  let release;
  try {
    const customer = await f.login('customer@calai.local', 'LocalCustomer!4310'), admin = await f.login('admin@calai.local', 'LocalAdmin!4310');
    const userId = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id;
    const intake = await f.json('/api/account/deletion-requests/verified', { method: 'POST', cookie: customer, body: { password: 'LocalCustomer!4310', confirm: 'DELETE MY ACCOUNT' } });
    assert.equal(intake.status, 201, intake.text);
    const id = intake.body.data.id, preview = await f.json(`/api/admin/deletion-requests/${id}/erasure-preview`, { cookie: admin });
    assert.equal(preview.body.data.eligible, true);
    const gate = new Promise(resolve => { release = resolve; }); let bodyStarted;
    const reading = new Promise(resolve => { bodyStarted = resolve; });
    const req = Readable.from((async function* () { bodyStarted(); await gate; yield Buffer.from(JSON.stringify({ label: 'Home', line1: '1 Synthetic Delayed Road', line2: '', city: 'Luton', postcode: 'LU1 1AA' })); })());
    Object.assign(req, { method: 'POST', url: '/api/account/addresses', headers: { host: f.config.expectedHost, cookie: customer, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
    const pending = new Promise(resolve => {
      const chunks = [], res = { headersSent: false, statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } };
      void createApp({ db: f.db, config: f.config })(req, res);
    });
    await reading;
    const erased = await f.json(`/api/admin/deletion-requests/${id}/erase-customer`, { method: 'POST', cookie: admin, body: { confirm: 'ERASE CUSTOMER DATA', previewHash: preview.body.data.previewHash, note: 'Isolated fixture: authenticated identity and request reviewed; no active work remains.' } });
    assert.equal(erased.status, 200, erased.text); release();
    const late = await pending;
    assert.equal(late.status, 409); assert.equal(late.body.error.code, 'ACCOUNT_ERASED');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saved_addresses WHERE user_id=?').get(userId).n, 0);
    assert.equal(f.db.prepare('SELECT account_enabled FROM users WHERE id=?').get(userId).account_enabled, 0);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { release?.(); await f.close(); }
});
