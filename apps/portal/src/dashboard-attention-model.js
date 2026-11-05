export function printerConnectionSummary(items = []) {
  const configured = items.filter(printer => !printer.revoked && printer.status !== "revoked");
  return { configured, disconnected: configured.filter(printer => printer.enabled === false || printer.status !== "online") };
}
