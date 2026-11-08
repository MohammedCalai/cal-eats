import { HttpError } from "./http.js";

// A bounded, local English screening layer for newly shared text. It is not a
// classifier for images, every language, or the meaning of an entire exchange.
// Keep support/safety-report evidence out of this path so abuse can be reported.
const lookalikes = { "а":"a", "е":"e", "о":"o", "р":"p", "с":"c", "х":"x", "у":"y", "і":"i", "ѕ":"s", "ј":"j", "α":"a", "ο":"o", "ι":"i" };
function screeningText(value, allowReportedQuotes) {
  let text = value.normalize("NFKC").toLowerCase();
  // Only a clearly attributed, quoted past message is treated as evidence.
  // Unattributed quotes do not let a direct threat bypass screening.
  if (allowReportedQuotes) {
    text = text.replace(/\b(?:he|she|they|someone|(?:the|your|our) (?:driver|customer|restaurant|staff|employee))\s+(?:said|wrote|texted|replied|sent(?: me)?(?: the message)?)\s*:?\s*["“]([^"”\r\n]{1,500})["”]/g, " reported message ");
    text = text.replace(/\b(?:he|she|they|someone|(?:the|your|our) (?:driver|customer|restaurant|staff|employee))\s+(?:said|wrote|texted|replied)\s*:?\s*'([^'\r\n]{1,500})'/g, " reported message ");
  }
  text = text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\p{Cf}\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "");
  text = text.replace(/[аеорсхуіѕјαοι]/g, letter => lookalikes[letter]);
  text = text.replace(/[013457@$|]/g, letter => ({ "0":"o", "1":"i", "3":"e", "4":"a", "5":"s", "7":"t", "@":"a", "$":"s", "|":"i" })[letter]).replace(/(?<=[a-z])!(?=[a-z])/g, "i");
  text = text.replace(/[’']/g, "");
  text = text.replace(/\bf(?:u)?[*._-]{1,4}(?:c)?k\b/g, "fuck");
  // Collapse short spelled-out words, not arbitrary gaps between normal words.
  text = text.replace(/\b(?:[a-z][\s._*·-]+){2,14}[a-z]\b/g, word => word.replace(/[^a-z]/g, ""));
  return text.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

const target = "(?:you|youre|u|ya)";
const profane = "(?:f+u+c+k+|fuk|fck|fk|fack)";
const recipient = `(?:${target}|your (?:family|staff|driver|children|kids))`;
const shootIdiom = "(?!(?:\\s+(?:a|an|the))?\\s+(?:messages?|texts?|emails?|photos?|pictures?|updates?|confirmations?|receipts?|invoices?)\\b)";
const threatAction = `(?:(?:kill|murder|stab|rape|hurt)\\s+${recipient}\\b|shoot\\s+${recipient}\\b${shootIdiom})`;
const rules = [
  { category: "abuse", pattern: /\b(?:fuckyou|fukyou|fckyou|fuckoff)\b/ },
  { category: "threat", pattern: /\b(?:iwillkillyou|illkillyou|wewillkillyou|killyourself)\b/ },
  { category: "sexual_request", pattern: /\b(?:sendmenudes|sendnudes|showmeyourtits|suckmydick)\b/ },
  { category: "threat", pattern: new RegExp(`\\b(?:i|we)\\s+(?:will|shall|am going to|are going to|gonna)\\s+${threatAction}`) },
  { category: "threat", pattern: new RegExp(`\\b(?:ill|well|im going to|were going to|im gonna|were gonna)\\s+${threatAction}`) },
  { category: "threat", pattern: /\b(?:i will|ill|we will|well)\s+(?:beat you up|burn (?:your|the) (?:shop|restaurant|house) down)\b/ },
  { category: "threat", pattern: /\b(?:i hope you die|you deserve to die|kill all (?:muslims|jews|christians|hindus|sikhs|immigrants|gays)|exterminate (?:all )?(?:muslims|jews|christians|hindus|sikhs|immigrants|gays))\b/ },
  { category: "abuse", pattern: new RegExp(`\\b${profane}\\s+(?:you|u|off)\\b`) },
  { category: "abuse", pattern: new RegExp(`\\b${target}(?:\\s+(?:are|r|a|an|such|stupid|dirty|worthless|fucking|fuckin)){0,6}\\s+(?:cunt|bitch|bastard|idiot|moron|retard|retarded|nigger|faggot)\\b`) },
  { category: "abuse", pattern: new RegExp(`\\bshut\\s+the\\s+${profane}\\s+up\\b`) },
  { category: "sexual_request", pattern: /\b(?:send|show|give)\s+(?:me\s+)?(?:your\s+)?(?:nudes|nude (?:photos|pics|pictures)|naked (?:photos|pics|pictures)|tits|boobs|penis|vagina)\b/ },
  { category: "sexual_request", pattern: /\b(?:have sex with me|suck my (?:dick|cock)|i want to fuck you|pay (?:me|you) for sex|take off your clothes|get naked for me)\b/ }
];
const selfHarmCommand = /(?:^|\b(?:go|please|you should|why dont you)\s+)(?:kill yourself|go die)\b/g;
const negated = (text, index) => /\b(?:(?:dont|do not|never)(?: say| write| send)?|not|stop saying)\s*$/.test(text.slice(Math.max(0, index - 32), index));

export function screenCustomerContent(value, { allowReportedQuotes = true } = {}) {
  if (typeof value !== "string") return { allowed: true };
  const text = screeningText(value, allowReportedQuotes);
  for (const rule of rules) for (const match of text.matchAll(new RegExp(rule.pattern.source, "g"))) {
    if (!negated(text, match.index)) return { allowed: false, category: rule.category };
  }
  selfHarmCommand.lastIndex = 0;
  for (const match of text.matchAll(selfHarmCommand)) {
    if (!negated(text, match.index)) return { allowed: false, category: "threat" };
  }
  return { allowed: true };
}

export function assertCustomerContentAllowed(value, purpose = "message") {
  if (!screenCustomerContent(value, { allowReportedQuotes: purpose === "message" }).allowed) {
    throw new HttpError(422, "CONTENT_NOT_ALLOWED", `This text could not be ${purpose === "message" ? "sent" : "saved"} because it appears to contain abuse, threats or sexual requests. Reword it, or use Help & support to report what happened.`);
  }
}

export function assertPublicMenuContentAllowed(item) {
  for (const key of ["name", "description", "category"]) assertCustomerContentAllowed(item[key], "listing");
  for (const key of ["allergens", "dietaryTags"]) if (Array.isArray(item[key])) for (const value of item[key]) assertCustomerContentAllowed(value, "listing");
  if (Array.isArray(item.modifierGroups)) for (const group of item.modifierGroups) {
    if (!group || typeof group !== "object") continue;
    assertCustomerContentAllowed(group.name, "listing");
    if (Array.isArray(group.options)) for (const option of group.options) assertCustomerContentAllowed(option?.name, "listing");
  }
}
