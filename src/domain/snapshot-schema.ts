import { z } from "zod";
import type { CreditBalance, CreditGrant } from "./credit-balances.ts";
import type { UsageSnapshot, UsageWindow } from "./types.ts";
import { MAX_RESET_CREDITS } from "./reset-credits.ts";

const timestampSchema = z.string().datetime();
const expirySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("never") }),
  z.object({ kind: z.literal("at"), at: timestampSchema }),
]);
const remainingSchema = z.number().finite().nonnegative();
const amountSchema = z.object({
  remaining: remainingSchema.optional(),
  unlimited: z.literal(true).optional(),
}).superRefine((amount, context) => {
  if (amount.remaining === undefined && amount.unlimited !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "remaining or unlimited is required" });
  }
  if (amount.remaining !== undefined && amount.unlimited === true) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "remaining and unlimited cannot both be set" });
  }
});

export const creditGrantSchema = z.object({
  expiry: expirySchema,
}).and(amountSchema);

export const creditBalanceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["credit", "manual_reset"]),
  label: z.string().min(1),
  unit: z.string().min(1),
  expiry: expirySchema,
  renewsAt: timestampSchema.optional(),
  grants: z.array(creditGrantSchema).optional(),
}).and(amountSchema);

const creditBalancesSchema = z.array(creditBalanceSchema).superRefine((balances, context) => {
  const identities = new Set<string>();
  for (const [index, balance] of balances.entries()) {
    // A provider may use the same display id for balances in different units.
    // Only an exact resource identity would make the history ambiguous.
    const identity = `${balance.id}\u0000${balance.kind}\u0000${balance.unit}`;
    if (identities.has(identity)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "credit balance identities must be unique",
        path: [index],
      });
    }
    identities.add(identity);
  }
});

/** Validates a `UsageSnapshot` received over the wire (the ingest endpoint's request body). */
export const usageWindowSchema = z.object({
  scope: z.string().optional(),
  window: z.string(),
  remainingPercent: z.number().optional(),
  usedPercent: z.number().optional(),
  resetsRaw: z.string().optional(),
  resetsAt: z.string().optional(),
  windowSeconds: z.number().optional(),
  metric: z.string().optional(),
  unit: z.string().optional(),
  value: z.number().optional(),
  limitValue: z.number().optional(),
  remainingValue: z.number().optional(),
  usedValue: z.number().optional(),
  attributes: z.record(z.string()).optional(),
});

export const usageSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string(),
  provider: z.string().min(1),
  ok: z.boolean(),
  windows: z.array(usageWindowSchema),
  cliVersion: z.string().optional(),
  errorCode: z.string().optional(),
  resetCredits: z.number().finite().int().nonnegative().max(MAX_RESET_CREDITS).optional(),
  creditBalances: creditBalancesSchema.optional(),
  error: z.string().optional(),
});

type ParsedSnapshot = z.infer<typeof usageSnapshotSchema>;
type ParsedWindow = z.infer<typeof usageWindowSchema>;

/**
 * Zod's `.optional()` output type allows an explicit `undefined` value for
 * present-but-unset keys; our domain types (under `exactOptionalPropertyTypes`)
 * require the key to be entirely absent instead. This bridges the two.
 */
export function toUsageSnapshot(parsed: ParsedSnapshot): UsageSnapshot {
  return {
    schemaVersion: parsed.schemaVersion,
    observedAt: parsed.observedAt,
    provider: parsed.provider,
    ok: parsed.ok,
    windows: parsed.windows.map(toUsageWindow),
    ...(parsed.cliVersion !== undefined ? { cliVersion: parsed.cliVersion } : {}),
    ...(parsed.errorCode !== undefined ? { errorCode: parsed.errorCode } : {}),
    ...(parsed.resetCredits !== undefined ? { resetCredits: parsed.resetCredits } : {}),
    ...(parsed.creditBalances !== undefined ? { creditBalances: toCreditBalances(parsed.creditBalances) } : {}),
    ...(parsed.error !== undefined ? { error: parsed.error } : {}),
  };
}

/** Removes Zod's present-but-undefined optional keys for the domain contract. */
export function toCreditBalances(parsed: z.infer<typeof creditBalanceSchema>[]): CreditBalance[] {
  return parsed.map((balance) => ({
    id: balance.id,
    kind: balance.kind,
    label: balance.label,
    unit: balance.unit,
    expiry: balance.expiry,
    ...toCreditAmount(balance),
    ...(balance.renewsAt !== undefined ? { renewsAt: balance.renewsAt } : {}),
    ...(balance.grants !== undefined ? { grants: balance.grants.map(toCreditGrant) } : {}),
  }));
}

function toCreditGrant(grant: z.infer<typeof creditGrantSchema>): CreditGrant {
  return {
    expiry: grant.expiry,
    ...toCreditAmount(grant),
  };
}

function toCreditAmount(amount: { remaining?: number | undefined; unlimited?: true | undefined }):
  | { remaining: number }
  | { unlimited: true } {
  return amount.remaining !== undefined ? { remaining: amount.remaining } : { unlimited: true };
}

function toUsageWindow(parsed: ParsedWindow): UsageWindow {
  return {
    window: parsed.window,
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
    ...(parsed.remainingPercent !== undefined ? { remainingPercent: parsed.remainingPercent } : {}),
    ...(parsed.usedPercent !== undefined ? { usedPercent: parsed.usedPercent } : {}),
    ...(parsed.resetsRaw !== undefined ? { resetsRaw: parsed.resetsRaw } : {}),
    ...(parsed.resetsAt !== undefined ? { resetsAt: parsed.resetsAt } : {}),
    ...(parsed.windowSeconds !== undefined ? { windowSeconds: parsed.windowSeconds } : {}),
    ...(parsed.metric !== undefined ? { metric: parsed.metric } : {}),
    ...(parsed.unit !== undefined ? { unit: parsed.unit } : {}),
    ...(parsed.value !== undefined ? { value: parsed.value } : {}),
    ...(parsed.limitValue !== undefined ? { limitValue: parsed.limitValue } : {}),
    ...(parsed.remainingValue !== undefined ? { remainingValue: parsed.remainingValue } : {}),
    ...(parsed.usedValue !== undefined ? { usedValue: parsed.usedValue } : {}),
    ...(parsed.attributes !== undefined ? { attributes: parsed.attributes } : {}),
  };
}
