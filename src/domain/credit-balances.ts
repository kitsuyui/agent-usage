/** The time at which a balance or grant expires, when its provider reports one. */
export type CreditExpiry =
  | { kind: "unknown" }
  | { kind: "never" }
  | { kind: "at"; at: string };

/** A provider-reported portion of a balance. Omitted when the provider only reports a total. */
export interface CreditGrant {
  /** Omitted only when `unlimited` is true. Never use zero for an unreported grant. */
  remaining?: number;
  unlimited?: true;
  expiry: CreditExpiry;
}

/** A provider-reported credit balance or manual reset right. */
export interface CreditBalance {
  id: string;
  kind: "credit" | "manual_reset";
  label: string;
  unit: string;
  /** Omitted only when `unlimited` is true. Never use zero for an unreported balance. */
  remaining?: number;
  unlimited?: true;
  expiry: CreditExpiry;
  /** A scheduled renewal is distinct from an individual balance expiring. */
  renewsAt?: string;
  grants?: CreditGrant[];
}
