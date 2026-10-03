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
