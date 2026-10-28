export function mailAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) throw new TypeError("Only one bounded statement attachment is supported");
  return value.map(item => {
    if (!item || typeof item !== "object" || Object.keys(item).some(key => !["filename", "contentType", "contentBase64"].includes(key)) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.csv$/.test(item.filename) || item.contentType !== "text/csv" || typeof item.contentBase64 !== "string" || item.contentBase64.length > 1400000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.contentBase64)) throw new TypeError("Statement attachment is invalid");
    const bytes = Buffer.from(item.contentBase64, "base64");
    if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString("base64") !== item.contentBase64) throw new TypeError("Statement attachment is too large or invalid");
    return { filename: item.filename, contentType: "text/csv", contentBase64: item.contentBase64 };
  });
}
