import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { loadReceiptPdf } from "./receipt-pdf";

const RETENTION_MS = 15 * 60 * 1000;
const activeDirectories = new Set<string>();
const remove = (directory: Directory) => { try { if (directory.exists) directory.delete(); } catch { /* The system may already have cleared its cache. */ } };

export async function shareReceiptPdf(options: Parameters<typeof loadReceiptPdf>[0]) {
  const { orderId, signal, isCurrent } = options;
  if (!isCurrent() || signal.aborted) return;
  if (!await Sharing.isAvailableAsync()) throw new Error("File sharing is unavailable on this device. Open Cal-Eats in your browser to save your receipt.");
  const bytes = await loadReceiptPdf(options);
  if (!bytes || !isCurrent() || signal.aborted) return;
  const cache = new Directory(Paths.cache, "customer-receipt-pdfs");
  cache.create({ intermediates: true, idempotent: true });
  for (const entry of cache.list()) {
    const created = /^receipt-(\d+)-[a-z0-9]+$/.exec(entry.name);
    if (entry instanceof Directory && created && Number(created[1]) < Date.now() - RETENTION_MS && !activeDirectories.has(entry.uri)) remove(entry);
  }
  const directory = new Directory(cache, `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const safeId = orderId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100) || "order";
  const file = new File(directory, `Cal-Eats-receipt-${safeId}.pdf`);
  let shared = false, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    signal.removeEventListener("abort", cleanup);
    activeDirectories.delete(directory.uri);
    remove(directory);
  };
  activeDirectories.add(directory.uri);
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    directory.create();
    file.create({ overwrite: false });
    file.write(bytes);
    if (!isCurrent() || signal.aborted) return;
    await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: "Save or share your Cal-Eats receipt" });
    shared = true;
  } finally {
    // Android apps can read the granted file after the chooser closes. Account
    // changes still remove it immediately through the abort listener.
    if (Platform.OS === "android" && shared && isCurrent() && !signal.aborted) cleanupTimer = setTimeout(cleanup, RETENTION_MS);
    else cleanup();
  }
}
