import { ApiError } from "./api.js";

export const calaiTabletSetupFilename = "CalEats-Tablet-Setup.ps1";

export async function requestCalaiFirstTabletSetup(path, payload, { signal, request = fetch } = {}) {
  const response = await request(path, {
    method: "POST",
    credentials: "same-origin",
    mode: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/octet-stream, application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null))?.error;
    throw new ApiError(detail?.message || "Could not prepare the tablet setup. Check the current assignment and try again.", response.status, detail?.code);
  }
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const disposition = response.headers.get("content-disposition") ?? "";
  if (response.status === 202 && type === "application/json" && !disposition) {
    const data = (await response.json().catch(() => null))?.data;
    if (data?.managed === true && Object.keys(data).length === 1) return { managed: true };
    throw new Error("Could not confirm the tablet approval. Check the assignment before trying again.");
  }
  if (response.status !== 200 || type !== "application/octet-stream" || !/^attachment(?:\s*;|$)/i.test(disposition.trim())) {
    throw new Error("The server did not provide a private tablet setup file. Check the assignment and try again.");
  }
  const packageFile = await response.blob();
  if (!packageFile.size) throw new Error("The tablet setup file is empty. Try again.");
  return packageFile;
}

export function saveCalaiFirstTabletSetup(file) {
  const href = URL.createObjectURL(file);
  const link = document.createElement("a");
  try {
    link.href = href;
    link.download = calaiTabletSetupFilename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}
