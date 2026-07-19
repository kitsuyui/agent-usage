# agent-usage

Tracks rate-limit / usage data for AI coding agent CLIs (Claude Code, Codex
CLI, Antigravity, GitHub Copilot CLI, ...) over time, tells you when each
window next resets, and exposes the history over HTTP and MCP, plus a small
dashboard.

## Why

None of these CLIs currently expose their quota through a machine-readable
flag — the only place the numbers show up is an interactive `/usage` or
`/status` screen. This project drives that screen inside a disposable `tmux`
session, parses it, and records it, so you get a queryable history instead of
a number you have to read off a TUI by hand.

One exception: Copilot's `/usage` screen shows a percentage but never a reset
time. GitHub's docs say the included AI-credit allowance always resets at
00:00 UTC on the 1st of the month regardless of subscription date, so that
provider computes `resetsAt` directly instead of parsing it — see
`src/domain/reset-time.ts`'s `nextUtcMonthStart`.

## Features

- Periodic sampling of every registered provider, stored as a time series in
  SQLite (via Prisma) — not just the latest reading.
- Resolves each provider's raw "resets in..." text into an absolute
  timestamp, so you can ask "when does this actually reset" instead of doing
  the math yourself.
- HTTP API (`/api/providers`, `/api/usage/latest`, `/api/usage/history`,
  `/api/usage/next-resets`) and an MCP server exposing the same data as tools,
  so both scripts and agents can read it.
- A dependency-free static dashboard (plain HTML/CSS/TS, hand-rolled SVG
  charts) served by the same HTTP server.
- New providers are a config object + a parser function away — see
  [`docs/providers.md`](docs/providers.md).

## Quickstart

```sh
bun install
cp .env.example .env
bun run db:migrate:dev   # creates prisma/migrations + the local SQLite db
bun run build:frontend   # bundles frontend/main.ts -> frontend/main.js

bun run dev               # daemon: sampler loop + HTTP API + dashboard
# or, one-off:
bun run sample -- --provider claude
# or, for an MCP client:
bun run src/cli/index.ts mcp
```

The dashboard is served at `http://localhost:7979/` by default (see
`HTTP_PORT` / `SAMPLE_INTERVAL_SECONDS` in `.env.example`).

`bun run dev` shells out to the real `claude`/`codex`/`agy`/`copilot` CLIs on
your machine (via tmux) — only run it where you actually want that.

## Deployment modes

By default `daemon` is all-in-one: local SQLite database + HTTP API/dashboard
+ sampler, all in one process — this is what `bun run dev` runs.

It can also split into a central **server** (owns the database, serves
read/write HTTP, no CLI dependencies of its own) and one or more standalone
**collectors** (each just captures and pushes to the server, no database or
HTTP server of its own). This is useful when you'd rather isolate the
credential-bearing CLI processes from the server — e.g. one lightweight
collector per provider, each only needing that one CLI's credentials.

```sh
# server: owns the database, accepts pushes, serves the dashboard.
# --no-sample makes it a pure server (no CLI/tmux use at all) for hosts
# with none of the agent CLIs installed; omit it to also sample locally.
INGEST_TOKEN=some-shared-secret bun run src/cli/index.ts daemon --no-sample

# collector: only samples codex, pushes to the server, no local database
INGEST_SERVER_URL=http://server-host:7979 \
INGEST_TOKEN=some-shared-secret \
bun run src/cli/index.ts daemon --provider codex
```

`INGEST_TOKEN` is an optional shared-secret bearer token — set it on both
sides to require it, or leave it unset for an unauthenticated ingest endpoint
(fine on a trusted network; put a real auth layer in front otherwise, which
neither the server nor its collectors need to know about).

## How it works

1. **Capture** (`src/capture/tmux.ts`): launches a provider's CLI in a
   disposable tmux session, sends its usage slash-command, and captures the
   rendered pane text once it settles.
2. **Parse** (`src/providers/*/parse.ts`): a small regex-based parser per
   provider turns that captured text into a provider-neutral
   `UsageSnapshot` (see `src/domain/types.ts`).
3. **Store** (`src/storage/sink.ts`): each snapshot goes to a `SnapshotSink`
   — either a direct Prisma write (`createLocalSink`) or a push to a remote
   server's ingest endpoint (`createRemoteSink`, in `src/daemon/`), depending
   on the deployment mode (see below). Local writes persist a `Sample` with
   its `Window`s via `src/storage/repository.ts`.
4. **Serve**: `src/server/http.ts` (REST) and `src/mcp/server.ts` (MCP tools)
   both read from the same repository layer, regardless of which collectors
   fed it.

See [`docs/architecture.md`](docs/architecture.md) for more detail, and
[`docs/providers.md`](docs/providers.md) for how to add a new agent CLI.

## Development

```sh
bun run typecheck   # backend + frontend (two separate tsconfigs; the
                     # frontend one adds DOM lib for browser globals)
bun run lint
bun test
```

Tests that touch storage/HTTP/MCP spin up their own throwaway SQLite file via
`prisma db push` in `beforeAll` — no shared or checked-in test database.

## License

MIT — see [`LICENSE`](LICENSE).
