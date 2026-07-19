/** Formats a Date as ISO-8601 UTC with seconds precision (no milliseconds). */
export function toIsoSeconds(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
