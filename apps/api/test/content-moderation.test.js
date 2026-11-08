import assert from "node:assert/strict";
import test from "node:test";
import { assertCustomerContentAllowed, screenCustomerContent } from "../src/content-moderation.js";

test("shared text screening rejects direct threats, targeted abuse and sexual requests including common obfuscation", () => {
  const samples = [
    "I will kill you", "I'll stab you", "I'm going to hurt you", "Pay me now or I will shoot you", "I will burn your restaurant down", "I will kill you an update", "I will shoot you a bullet",
    "kill yourself", "You should kill yourself", "go die", "I hope you die", "kill all Muslims",
    "Fuck you!", "You are a stupid idiot", "You're a dirty bastard", "shut the fuck up", "you fucking cunt",
    "Send me nudes", "show me your tits", "have sex with me", "pay me for sex",
    "i w!ll k1ll y0u!", "I will k.i.l.l you", "i will k i l l you", "f**k you", "f.u.c.k y.o.u", "s3nd m3 nud3s",
    "ＦＵＣＫ ＹＯＵ", "f\u200buck you", "I will kіll you", "You are an idïot"
  ];
  samples.forEach((text, index) => assert.equal(screenCustomerContent(text).allowed, false, `Unsafe fixture ${index} should be rejected`));
});

test("screening preserves food, allergy, health, delivery, complaints and clearly reported/negated evidence", () => {
  const samples = [
    "Chicken breast with shiitake mushrooms, cumin and nuts", "Faggots with mash", "Sex on the Beach cocktail", "Scunthorpe delivery address",
    "Please remove all nuts: I have a severe allergy and need to avoid contamination.", "The food made me sick and I need help", "The curry is fucking cold",
    "This chilli will kill your hunger", "I'll shoot you a message when your food is ready", "I will shoot you an email", "We'll shoot you an update when the order is ready.", "I'll shoot you a confirmation shortly.", "We will beat the delivery estimate",
    "Your driver threatened to kill me", 'Your driver said "fuck you" to me. Please investigate.', "The customer wrote 'I will kill you'. I need support.",
    "Do not send me nudes", "Don't say fuck you", "Please don't kill yourself", "Do not kill all Muslims", "I will not hurt you",
    "Chicken contains milk; breast fillet may contain nuts. Please call about your allergy."
  ];
  samples.forEach((text, index) => assert.equal(screenCustomerContent(text).allowed, true, `Legitimate fixture ${index} must remain available`));
  assert.equal(screenCustomerContent('Your driver said "fuck you", but I will kill you').allowed, false, "An attributed quote does not exempt the remaining text");
  assert.equal(screenCustomerContent('"I will kill you"').allowed, false, "Unattributed quotes do not bypass the filter");
});

test("rejection uses a safe actionable message without retaining or echoing submitted text", () => {
  assert.throws(() => assertCustomerContentAllowed("I will kill you"), error => error.status === 422 && error.code === "CONTENT_NOT_ALLOWED" && /Reword it.*Help & support/.test(error.message) && !error.message.includes("kill you"));
  assert.throws(() => assertCustomerContentAllowed("send me nudes", "listing"), /could not be saved/);
  assert.throws(() => assertCustomerContentAllowed('Your driver said "fuck you"', "listing"), /could not be saved/, "Published listings cannot use the private-message evidence exception");
});
