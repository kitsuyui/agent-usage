import type { UsageSnapshot } from "../domain/types.ts";
import type { SnapshotSink } from "../storage/sink.ts";

export interface RemoteSinkOptions {
  /** Base URL of the central server, e.g. "http://collector-host:7979". */
  url: string;
  /** Shared-secret bearer token. Omit if the server has no `INGEST_TOKEN` configured. */
  token?: string;
}

/**
 * Pushes captured snapshots to a central server's ingest endpoint instead of
 * writing to a local database — what a standalone, provider-specific
 * collector (e.g. one per Docker container) uses.
 */
export function createRemoteSink(options: RemoteSinkOptions): SnapshotSink {
  const endpoint = new URL("/api/usage/samples", options.url).toString();
  return {
    async record(snapshot: UsageSnapshot): Promise<void> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(snapshot),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`ingest request failed: ${response.status} ${body}`.trim());
      }
    },
  };
}
