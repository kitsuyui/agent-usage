/** Largest value accepted by SQLite's Prisma `Int` column. */
export const MAX_RESET_CREDITS = 2_147_483_647;

export function isResetCreditCount(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RESET_CREDITS;
}
