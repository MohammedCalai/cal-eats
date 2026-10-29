import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

const MAX_BYTES = 256 * 1024;
const RETENTION_MS = 15 * 60 * 1000;
const activeFiles = new Set<string>();
const remove = (file: File) => { try { if (file.exists) file.delete(); } catch { /* The system may already have cleared its cache. */ } };

export async function shareDashboardCsvFile(csv: string, filename: string, isCurrent: () => boolean) {
  if (!isCurrent()) return;
  if (!await Sharing.isAvailableAsync()) throw new Error("File sharing is unavailable on this device. Use the tablet or browser dashboard to download your CSV.");
  if (!isCurrent()) return;
  const directory = new Directory(Paths.cache, "dashboard-csv-exports");
  directory.create({ intermediates: true, idempotent: true });
  for (const entry of directory.list()) {
    if (entry instanceof File && !activeFiles.has(entry.uri) && /^Cal-Eats-[A-Za-z0-9._-]+\.csv$/.test(entry.name) && entry.lastModified !== null && entry.lastModified < Date.now() - RETENTION_MS) remove(entry);
  }
  const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}\.csv$/.test(filename) ? filename.slice(0, -4) : "Cal-Eats-dashboard";
  const file = new File(directory, `${safeName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.csv`);
  let presented = false;
  activeFiles.add(file.uri);
  try {
    const content = csv.startsWith("\uFEFF") ? csv : "\uFEFF" + csv;
    if (content.length > MAX_BYTES || new Blob([content]).size > MAX_BYTES) throw new Error("This export is too large to share on your phone. Download it from the tablet or browser dashboard.");
    file.create({ overwrite: false });
    file.write(content, { encoding: "utf8" });
    if (file.size > MAX_BYTES) throw new Error("This export is too large to share on your phone. Download it from the tablet or browser dashboard.");
    if (!isCurrent()) return;
    presented = true;
    await Sharing.shareAsync(file.uri, { mimeType: "text/csv", UTI: "public.comma-separated-values-text", dialogTitle: "Save or share your Cal-Eats CSV" });
  } finally {
    activeFiles.delete(file.uri);
    // Android targets may open the granted URI after the chooser completes.
    // Keep a short private-cache grace period; the next export also clears stale files.
    if (Platform.OS === "android" && presented) setTimeout(() => remove(file), RETENTION_MS);
    else remove(file);
  }
}
