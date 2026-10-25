import fs from "node:fs/promises";
import path from "node:path";
import { Journal } from "../src/journal.js";
import { NullLogger } from "../src/logger.js";

export async function temporaryWorkspace(name) {
  const root = path.resolve("apps/print-bridge/.test-tmp");
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, `${name}-`));
}

export async function removeWorkspace(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}

export async function journalAt(directory) {
  return new Journal(path.join(directory, "journal.json")).load();
}

export const logger = new NullLogger();

export function receipt(overrides = {}) {
  return {
    format: "cal-eats-receipt-v1",
    orderNumber: "CE-1042",
    restaurantName: "Synthetic Kitchen",
    fulfillment: "delivery",
    createdAt: "2026-10-25T12:30:00.000Z",
    customerName: "Test Customer",
    customerPhone: "07000000000",
    deliveryAddress: "1 Test Street, Luton",
    items: [{ name: "Meal", quantity: 2, unitPriceMinor: 500, totalMinor: 1000, modifiers: [{ name: "Hot", priceMinor: 0 }], note: "No onions" }],
    orderNotes: "Ring bell",
    allergyNotes: "Synthetic note only",
    subtotalMinor: 1000,
    deliveryFeeMinor: 200,
    totalMinor: 1200,
    currency: "GBP",
    paymentStatus: "mock_captured",
    ...overrides,
  };
}

export function claimedJob(overrides = {}) {
  return {
    id: "job_test_00000001",
    claimToken: "claim_token_abcdefghijklmnopqrstuvwxyz",
    leaseExpiresAt: "2026-10-25T12:35:00.000Z",
    attempt: 1,
    receipt: receipt(),
    manualReprint: false,
    ...overrides,
  };
}

export class FakeApi {
  constructor(jobs = []) {
    this.jobs = [...jobs];
    this.claimCalls = 0;
    this.acks = [];
    this.failClaim = null;
    this.ackHook = null;
  }
  heartbeat() { return Promise.resolve({}); }
  async claim() {
    this.claimCalls += 1;
    if (this.failClaim) throw this.failClaim;
    return this.jobs.shift() ?? null;
  }
  async ack(id, body) {
    this.acks.push({ id, body: structuredClone(body) });
    if (this.ackHook) return this.ackHook(id, body, this.acks.length);
    return { status: body.outcome };
  }
}
