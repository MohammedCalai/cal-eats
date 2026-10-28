import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGraphMailAdapter, graphMailReadiness, loadGraphMailConfig } from "./graph-mail.js";

const HOSTS = new Set(["smtp.ionos.co.uk", "smtp.ionos.com"]);
const email = value => typeof value === "string" && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value) && value.length <= 254;
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : "EMAIL_OUTCOME_UNKNOWN";

export function loadOrderAlertEmailConfig(overrides = {}, dbPath, env = process.env) {
  const mode = overrides.mode ?? env.CALAI_ORDER_ALERT_EMAIL_MODE ?? "local";
  if (!["local", "smtp", "graph", "off"].includes(mode)) throw new Error("CALAI_ORDER_ALERT_EMAIL_MODE must be local, smtp, graph or off");
  const recipient = overrides.recipient ?? env.CALAI_ORDER_ALERT_RECIPIENT ?? "", from = overrides.from ?? env.CALAI_ORDER_ALERT_FROM ?? "caleats-support@calai.info";
  if (recipient && !email(recipient)) throw new Error("CALAI_ORDER_ALERT_RECIPIENT must be one email address");
  if (!email(from)) throw new Error("CALAI_ORDER_ALERT_FROM must be an email address");
  const host = overrides.host ?? env.CALAI_ORDER_ALERT_SMTP_HOST ?? "", port = Number(overrides.port ?? env.CALAI_ORDER_ALERT_SMTP_PORT ?? 465);
  if ((host && !HOSTS.has(host)) || ![465, 587].includes(port)) throw new Error("Order alert SMTP requires an explicitly approved host and encrypted port 465 or 587");
  const user = overrides.user ?? env.CALAI_ORDER_ALERT_SMTP_USER ?? "", password = overrides.password ?? env.CALAI_ORDER_ALERT_SMTP_PASSWORD ?? "", enabled = overrides.enabled ?? env.CALAI_ORDER_ALERT_SMTP_ENABLED === "true";
  if (typeof enabled !== "boolean") throw new Error("Order alert SMTP enablement must be a boolean");
  if (user && (!email(user) || user.toLowerCase() !== from.toLowerCase())) throw new Error("Order alert SMTP user must match the sender mailbox");
  const graph = loadGraphMailConfig({ ...overrides.graph, sender: from }, dbPath, env);
  return { mode, recipient, from, host, port, user, password, enabled, graph, localDirectory: path.resolve(overrides.localDirectory ?? env.CALAI_ORDER_ALERT_LOCAL_DIRECTORY ?? path.join(path.dirname(dbPath), "local-mail", "order-alerts")) };
}

export function orderAlertEmailTransportReadiness(settings) {
  const configured = settings.mode === "graph" ? graphMailReadiness(settings.graph) : settings.mode === "smtp" && settings.enabled && Boolean(settings.from && settings.host && settings.user && settings.password);
  return { mode: settings.mode, from: settings.from, configured, realDeliveryEnabled: configured, host: settings.mode === "graph" ? "graph.microsoft.com" : settings.host || null, port: settings.mode === "graph" ? 443 : settings.port, note: settings.mode === "local" ? "Saved to a private local mailbox only; no email is sent" : configured ? "Mail transport configured; sent means accepted by the provider, not confirmed inbox delivery. Microsoft sign-in may need renewing." : "Automatic email delivery is not configured; the connected desktop mailbox does not grant this app sending access" };
}
export function orderAlertEmailReadiness(settings) {
  const transport = orderAlertEmailTransportReadiness(settings);
  return { ...transport, recipient: settings.recipient || null, configured: transport.configured && Boolean(settings.recipient), realDeliveryEnabled: transport.realDeliveryEnabled && Boolean(settings.recipient) };
}

export function createOrderAlertEmailAdapter(settings, { transportFactory, graphOptions } = {}) {
  let transport;
  const graph = settings.mode === "graph" ? createGraphMailAdapter(settings.graph, graphOptions) : null;
  return async (message, { beforeSend = () => true } = {}) => {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(message.id) || !email(message.to) || !email(message.from) || message.from.toLowerCase() !== settings.from.toLowerCase() || /[\r\n\0]/.test(message.subject) || !/^<cal-eats-(?:order-alert|customer-email)-[A-Za-z0-9-]+@[A-Za-z0-9.-]+>$/.test(message.messageId)) return { status: "failed", errorCode: "EMAIL_MESSAGE_INVALID" };
    if (settings.mode === "off") return { status: "failed", errorCode: "EMAIL_DISABLED" };
    if (graph) return graph(message, { beforeSend });
    if (settings.mode === "smtp" && (!HOSTS.has(settings.host) || ![465,587].includes(settings.port))) return {status:"failed",errorCode:"SMTP_CONFIGURATION_INVALID"};
    if (settings.mode === "local") {
      if (!beforeSend()) return { status: "cancelled" };
      const boundary = `cal-eats-${message.id}`;
      const body = message.html ? `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(message.text).toString("base64")}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(message.html).toString("base64")}\r\n--${boundary}--\r\n` : `Content-Type: text/plain; charset=utf-8\r\n\r\n${message.text.replace(/\r?\n/g,"\r\n")}\r\n`;
      const content = `From: Cal-Eats <${message.from}>\r\nTo: ${message.to}\r\nSubject: =?UTF-8?B?${Buffer.from(message.subject).toString("base64")}?=\r\nMessage-ID: ${message.messageId}\r\nMIME-Version: 1.0\r\n${body}`;
      try {
        fs.mkdirSync(settings.localDirectory, { recursive: true });
        const filename = path.join(settings.localDirectory, `${message.id}.eml`);
        try { fs.writeFileSync(filename, content, { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (createHash("sha256").update(fs.readFileSync(filename)).digest("hex") !== createHash("sha256").update(content).digest("hex")) return { status: "failed", errorCode: "LOCAL_MAIL_CONFLICT" };
        }
        return { status: "local_saved" };
      } catch { return { status: "failed", errorCode: "LOCAL_MAIL_WRITE_FAILED" }; }
    }
    if (!orderAlertEmailTransportReadiness(settings).configured) return { status: "failed", errorCode: "SMTP_NOT_CONFIGURED" };
    try {
      if (!transport) {
        const options = { host: settings.host, port: settings.port, secure: settings.port === 465, requireTLS: true, auth: { user: settings.user, pass: settings.password }, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: settings.host }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false };
        const factory = transportFactory ?? (await import("nodemailer")).default.createTransport;
        transport = factory(options);
      }
      // Dependencies/DNS preparation can yield; recheck the order at the final dispatch boundary.
      if (!beforeSend()) return { status: "cancelled" };
      const result = await transport.sendMail({ from: { name: "Cal-Eats", address: message.from }, to: message.to, subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}), messageId: message.messageId, disableFileAccess: true, disableUrlAccess: true });
      const accepted = Array.isArray(result?.accepted) && result.accepted.some(value => (typeof value === "string" ? value : value?.address)?.toLowerCase() === message.to.toLowerCase());
      return accepted ? { status: "sent" } : { status: "failed", errorCode: "SMTP_RECIPIENT_NOT_ACCEPTED" };
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND") return { status: "failed", errorCode: "SMTP_DEPENDENCY_MISSING" };
      if (["EAUTH", "EENVELOPE", "EMESSAGE"].includes(error?.code) || Number(error?.responseCode) >= 400) return { status: "failed", errorCode: safeCode(error?.code) };
      // A network failure can happen after server acceptance. Never assume it is safe to resend.
      return { status: "unknown", errorCode: safeCode(error?.code) };
    }
  };
}
