/** Preserve invalid text in the form; never coerce an empty value to zero. */
export function parseGrade(text: string): number | null | undefined {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 100
    ? number
    : undefined;
}
