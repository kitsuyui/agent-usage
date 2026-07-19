import { collectSnapshot } from "../capture/collect.ts";
import type { UsageSnapshot } from "../domain/types.ts";
import { getProvider, listProviders, type UsageProvider } from "../providers/index.ts";
import type { SnapshotSink } from "../storage/sink.ts";

/**
 * Captures one snapshot per provider (or one specific provider) and hands
 * each to `sink` — a local database write or a push to a remote server,
 * depending on how the caller was configured.
 *
 * Providers are sampled sequentially — each spawns an interactive TUI
 * session, and running several at once buys little while adding contention
 * risk for no real benefit at the sampling intervals this is meant for.
 */
export async function runSampleOnce(sink: SnapshotSink, providerId?: string): Promise<UsageSnapshot[]> {
  const providers = providerId ? [requireProvider(providerId)] : listProviders();
  const snapshots: UsageSnapshot[] = [];
  for (const provider of providers) {
    const snapshot = await collectSnapshot(provider);
    await sink.record(snapshot);
    snapshots.push(snapshot);
  }
  return snapshots;
}

function requireProvider(id: string): UsageProvider {
  const provider = getProvider(id);
  if (!provider) throw new Error(`unknown provider: ${id}`);
  return provider;
}
