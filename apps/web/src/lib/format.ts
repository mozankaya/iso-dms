const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Formats an ISO timestamp as dd.MM.yyyy in Europe/Istanbul; "-" when empty. */
export function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return dateFormatter.format(new Date(iso));
}

const dateTimeFormatter = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Formats an ISO timestamp as dd.MM.yyyy HH:mm in Europe/Istanbul; "-" when empty. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  // The locale puts a space or a comma between date and time depending on the runtime: normalise it
  return dateTimeFormatter.format(new Date(iso)).replace(/,s*|s+/, " ");
}

/** Human readable file size ("12 KB", "1,5 MB"); "-" when unknown. */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  return `${(kilobytes / 1024).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB`;
}
