/** A calendar date is not an instant: never shift it through a timezone. */
export function formatDate(value: string): string {
  return value.split("-").reverse().join(".");
}

/** Stable numeric format, including browsers without Kazakh ICU data. */
export function formatDateTime(value: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${get("day")}.${get("month")}.${get("year")} · ${get("hour")}:${get("minute")}`;
}
