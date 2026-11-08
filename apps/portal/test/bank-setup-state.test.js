import test from "node:test";
import assert from "node:assert/strict";
import { bankSetupState } from "../src/bank-setup-state.js";

const connected = { configured: true, providerMode: "stripe_live", account: { status: "not_started", chargesEnabled: false, payoutsEnabled: false, requirements: [] } };

test("an owner with no connected account gets the secure add-bank action", () => {
  const setup = bankSetupState({ value: connected });
  assert.equal(setup.label, "Add bank account");
  assert.equal(setup.action, "onboarding");
  assert.equal(setup.available, true);
  assert.match(setup.description, /securely/);
});

test("unfinished verification continues onboarding instead of opening a missing account", () => {
  for (const status of ["pending", "restricted"]) {
    const setup = bankSetupState({ value: { ...connected, account: { ...connected.account, status, requirements: ["external_account"] } } });
    assert.equal(setup.label, "Continue bank setup");
    assert.equal(setup.action, "onboarding");
    assert.equal(setup.available, true);
  }
});

test("only an enabled account without pending requirements gets manage-bank navigation", () => {
  const ready = { ...connected, account: { status: "enabled", chargesEnabled: true, payoutsEnabled: true, requirements: [] } };
  assert.deepEqual([bankSetupState({ value: ready }).label, bankSetupState({ value: ready }).action], ["Manage bank details", "dashboard"]);
  for (const account of [{ ...ready.account, payoutsEnabled: false }, { ...ready.account, requirements: ["business_profile"] }]) {
    assert.equal(bankSetupState({ value: { ...ready, account } }).action, "onboarding");
  }
});

test("the banking password gate applies to both onboarding-only and fully live modes", () => {
  for (const onboardingOnly of [false, true]) {
    const setup = bankSetupState({ value: { ...connected, onboardingOnly, passwordChangeRequired: true } });
    assert.equal(setup.available, false);
    assert.equal(setup.passwordRequired, true);
    assert.equal(setup.label, "Add bank account");
    assert.match(setup.description, /password/);
  }
});

test("unconfigured, failed or refreshing connections keep the bank action discoverable but locked", () => {
  for (const input of [{ value: { ...connected, configured: false } }, { value: { ...connected, modeMismatch: true } }, { value: connected, loading: true }, { value: connected, error: "Restaurant banking belongs to another payment mode" }, { value: null, error: "Connection unavailable" }, { value: null }]) {
    const setup = bankSetupState(input);
    assert.equal(setup.label, "Add bank account");
    assert.equal(setup.available, false);
    assert.ok(setup.description);
  }
});

test("ready bank setup does not imply that customer live payments have launched", () => {
  const setup = bankSetupState({ value: { ...connected, onboardingOnly: true, customerPaymentsLive: false } });
  assert.equal(setup.available, true);
  assert.doesNotMatch(setup.status + setup.description, /payments (?:are )?live|ready for customer payments/i);
});
