import type { UsageProvider } from "./types.ts";

const providers = new Map<string, UsageProvider>();

/** Registers a provider (or replaces one already registered under the same id). */
export function registerProvider(provider: UsageProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): UsageProvider | undefined {
  return providers.get(id);
}

export function listProviders(): UsageProvider[] {
  return [...providers.values()];
}
