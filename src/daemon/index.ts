import type { PrismaClient } from "@prisma/client";
import { createHttpServer } from "../server/http.ts";
import type { SnapshotSink } from "../storage/sink.ts";
import { SamplingSchedule } from "./schedule.ts";
import { samplingIntervalSchema, type SamplingConfig, type SamplingControl } from "./sampling-control.ts";
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
  readSamplingConfig?: () => Promise<SamplingConfig>;
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
  http?: { db: PrismaClient; host?: string; port: number; ingestToken?: string; staleAfterSeconds?: number; samplingControl?: SamplingControl; controlToken?: string };
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

  samplingIntervalSchema.parse(intervalSeconds);
  const schedule = new SamplingSchedule(intervalSeconds, Date.now());
  let controlUnavailable = false;

  const server = options.http
    ? createHttpServer({
        db: options.http.db,
        ...(options.http.host ? { host: options.http.host } : {}),
        port: options.http.port,
        ...(options.http.ingestToken ? { ingestToken: options.http.ingestToken } : {}),
        staleAfterSeconds: options.http.staleAfterSeconds ?? intervalSeconds * 2 + 60,
        ...(options.http.samplingControl ? { samplingControl: options.http.samplingControl } : {}),
        ...(options.http.controlToken ? { controlToken: options.http.controlToken } : {}),
      })
    : undefined;
  if (server) console.log(`http api listening on http://${server.hostname}:${server.port}`);
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
    if (options.readSamplingConfig) {
      try {
        schedule.apply(await options.readSamplingConfig(), Date.now());
        controlUnavailable = false;
      } catch (error) {
        if (!controlUnavailable) console.error("sampling control unavailable; retaining schedule:", error);
        controlUnavailable = true;
      }
    }
    if (stopped) break;
    if (Date.now() >= schedule.nextSampleAt) {
      try {
        const snapshots = await runSampleOnce(options.sink!, options.providerId);
        const okCount = snapshots.filter((snapshot) => snapshot.ok).length;
        console.log(`sampled ${snapshots.length} provider(s), ${okCount} ok`);
      } catch (error) {
        console.error("sample failed:", error);
      }
      schedule.completed(Date.now());
      // Check commands arriving during capture before beginning the normal wait.
      continue;
    }
    await new Promise<void>((resolve) => {
      const delay = Math.min(options.readSamplingConfig ? 5000 : Infinity,
        Math.max(0, schedule.nextSampleAt - Date.now()));
      const timer = setTimeout(resolve, delay);
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
