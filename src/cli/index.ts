#!/usr/bin/env bun
import type { PrismaClient } from "@prisma/client";
import { runDaemon } from "../daemon/index.ts";
import { createRemoteSink } from "../daemon/remote-sink.ts";
import { runSampleOnce } from "../daemon/sampler.ts";
import { startMcpStdioServer } from "../mcp/server.ts";
import { registerBuiltinProviders } from "../providers/index.ts";
import { disconnectPrismaClient, getPrismaClient } from "../storage/client.ts";
import { createLocalSink, type SnapshotSink } from "../storage/sink.ts";

const DEFAULT_HTTP_PORT = 7979;

async function main(): Promise<void> {
  registerBuiltinProviders();
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "daemon":
      await daemonCommand(args);
      return;
    case "sample":
      await sampleCommand(args);
      return;
    case "mcp":
      await startMcpStdioServer(getPrismaClient());
      return;
    default:
      printUsage();
      process.exit(command === undefined ? 0 : 1);
  }
}

async function daemonCommand(args: string[]): Promise<void> {
  if (args.includes("--no-sample")) {
    // Pure server: no CLI/tmux use at all, just the HTTP API + dashboard.
    // For a host with none of the agent CLIs installed (e.g. a container).
    const db = getPrismaClient();
    await runDaemon({ sample: false, http: resolveHttpOptions(db) });
    await disconnectPrismaClient();
    return;
  }

  const providerId = parseProviderFlag(args);
  const { sink, db } = resolveSink();
  await runDaemon({
    sink,
    ...(providerId ? { providerId } : {}),
    // A standalone collector (INGEST_SERVER_URL set) has no local database,
    // so it serves no HTTP API of its own — it only captures and pushes out.
    // The server itself still accepts pushes from other collectors (guarded
    // by INGEST_TOKEN below) while also sampling whatever providers are
    // available on its own host, if any.
    ...(db ? { http: resolveHttpOptions(db) } : {}),
  });
  if (db) await disconnectPrismaClient();
}

async function sampleCommand(args: string[]): Promise<void> {
  const providerId = parseProviderFlag(args);
  const { sink, db } = resolveSink();
  const snapshots = await runSampleOnce(sink, providerId);
  console.log(JSON.stringify(snapshots, null, 2));
  if (db) await disconnectPrismaClient();
}

/**
 * Resolves where captured snapshots go. `INGEST_SERVER_URL` set => this
 * process is a standalone collector pushing to a central server (no local
 * database). Unset => today's all-in-one behavior: write to the local
 * database directly.
 */
function resolveSink(): { sink: SnapshotSink; db: PrismaClient | undefined } {
  const serverUrl = process.env.INGEST_SERVER_URL;
  if (serverUrl) {
    const token = process.env.INGEST_TOKEN;
    return { sink: createRemoteSink({ url: serverUrl, ...(token ? { token } : {}) }), db: undefined };
  }
  const db = getPrismaClient();
  return { sink: createLocalSink(db), db };
}

function resolveHttpOptions(db: PrismaClient): { db: PrismaClient; port: number; ingestToken?: string } {
  return {
    db,
    port: Number(process.env.HTTP_PORT ?? DEFAULT_HTTP_PORT),
    ...(process.env.INGEST_TOKEN ? { ingestToken: process.env.INGEST_TOKEN } : {}),
  };
}

function parseProviderFlag(args: string[]): string | undefined {
  const index = args.indexOf("--provider");
  return index >= 0 ? args[index + 1] : undefined;
}

function printUsage(): void {
  console.log(
    [
      "usage: agent-usage <command>",
      "",
      "commands:",
      "  daemon [--provider ID]    run the sampler loop, then exit; see below for deployment modes",
      "  daemon --no-sample        pure server: HTTP API/dashboard only, no CLI/tmux use at all",
      "  sample [--provider ID]    capture and push/store one snapshot, then exit",
      "  mcp                       run the MCP server over stdio (reads the local database)",
      "",
      "deployment modes (env vars):",
      "  (none)                    all-in-one: local database + HTTP API/dashboard + sampler",
      "  INGEST_SERVER_URL=<url>   standalone collector: push to <url> instead of a local database",
      "  INGEST_TOKEN=<token>      shared-secret bearer token (set on both the server and its collectors)",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
