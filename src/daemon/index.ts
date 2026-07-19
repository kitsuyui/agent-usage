import type { PrismaClient } from "@prisma/client";
import { createHttpServer } from "../server/http.ts";
import type { SnapshotSink } from "../storage/sink.ts";
import { runSampleOnce } from "./sampler.ts";

const DEFAULT_INTERVAL_SECONDS = 900;

export interface DaemonOptions {
  /**
   * Where captured snapshots go — a local database write, or a push to a
   * remote server. Required unless `sample` is `false`.
   */
  sink?: SnapshotSink;
  /** Sample only this provider. Omit to sample every registered provider. */
  providerId?: string;
  intervalSeconds?: number;
  /**
   * Set to `false` for a pure server: no sampling, no CLI/tmux use at all —
   * just the HTTP API + dashboard, e.g. a containerized central server with
   * no agent CLIs of its own. Defaults to `true`.
   */
  sample?: boolean;
  /**
   * Present in all-in-one or pure-server mode: also serves the HTTP API +
   * static dashboard from this database. Omit for a standalone collector —
   * it only captures and pushes to `sink`, with no local database or HTTP
   * server.
   */
  http?: { db: PrismaClient; port: number; ingestToken?: string };
}

/**
 * Runs the long-lived process meant to be left running: a sampler loop on a
 * fixed interval (unless `sample: false`), and — in all-in-one or
 * pure-server mode — the HTTP API + dashboard too. Exits cleanly on
 * SIGTERM/SIGINT.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const sampleEnabled = options.sample ?? true;
  if (sampleEnabled && !options.sink) {
    throw new Error("runDaemon: a sink is required unless sample is set to false");
  }
  if (!sampleEnabled && !options.http) {
    throw new Error("runDaemon: nothing to do — sampling is disabled and no HTTP server was configured");
  }

  const intervalSeconds =
    options.intervalSeconds ?? Number(process.env.SAMPLE_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS);

  const server = options.http
    ? createHttpServer({
        db: options.http.db,
        port: options.http.port,
        ...(options.http.ingestToken ? { ingestToken: options.http.ingestToken } : {}),
      })
    : undefined;
  if (server) console.log(`http api listening on http://localhost:${server.port}`);
  console.log(
    !sampleEnabled
      ? "sampling disabled — serving only"
      : options.providerId
        ? `sampling "${options.providerId}" every ${intervalSeconds}s`
        : `sampling every ${intervalSeconds}s`,
  );

  let stopped = false;
  let wake: (() => void) | undefined;
  const requestStop = (): void => {
    stopped = true;
    wake?.();
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  while (!stopped) {
    if (!sampleEnabled) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
      continue;
    }
    try {
      // options.sink is guaranteed by the check above when sampleEnabled is true
      const snapshots = await runSampleOnce(options.sink!, options.providerId);
      const okCount = snapshots.filter((snapshot) => snapshot.ok).length;
      console.log(`sampled ${snapshots.length} provider(s), ${okCount} ok`);
    } catch (error) {
      console.error("sample failed:", error);
    }
    if (stopped) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalSeconds * 1000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
  }

  process.off("SIGTERM", requestStop);
  process.off("SIGINT", requestStop);
  server?.stop();
}
