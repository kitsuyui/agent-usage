# Architecture

## Layers

```
src/
  domain/       provider-neutral types + pure logic (no I/O)
    types.ts             UsageSnapshot / UsageWindow
    window-kinds.ts       window label -> duration-in-seconds registry
    reset-time.ts         "resets in..." text -> absolute ISO timestamp
    window-builder.ts     builds a UsageWindow, wiring resetsAt/windowSeconds
    snapshot-schema.ts    zod validation for a snapshot arriving over the wire

  providers/    one UsageProvider per agent CLI (id, TUI config, parser)
    registry.ts        pluggable id -> UsageProvider map
    claude/ codex/ antigravity/
      parse.ts          raw captured text -> UsageSnapshot (pure, unit-tested)
      index.ts           UsageProvider wiring (TUI capture config + parse)

  capture/      turns a UsageProvider into an actual observation
    tmux.ts             drives the CLI's TUI inside a disposable tmux session
    collect.ts          capture + parse one provider, with error fallback

  storage/      Prisma-backed persistence
    client.ts           lazy PrismaClient singleton
    repository.ts       record/query functions, all domain-typed in and out
    sink.ts             SnapshotSink — where a captured snapshot goes (see below)

  server/http.ts       REST API (read + ingest) + static dashboard (Bun.serve)
  mcp/server.ts        MCP server exposing the same reads as tools
  daemon/
    index.ts            the sampler loop (`daemon` command)
    sampler.ts           one sampling pass, against any SnapshotSink
    remote-sink.ts        SnapshotSink that pushes to a server's ingest endpoint
  cli/index.ts     `daemon` / `sample` / `mcp` subcommands
```

Data flows one direction: `capture -> parse -> sink -> storage -> {http, mcp}`.
The HTTP and MCP layers never touch tmux or provider parsing directly — they
only read through `src/storage/repository.ts`. That keeps the "is this data
fresh/queryable" question and the "how do I get this data out of a TUI"
question fully decoupled.

## Deployment modes: all-in-one vs. server + collectors

`src/daemon/sampler.ts`'s `runSampleOnce` never touches Prisma directly — it
writes through a `SnapshotSink` (`src/storage/sink.ts`). This is what makes
two deployment shapes possible from the same code:

- **All-in-one** (the default): `createLocalSink` wraps the local Prisma
  client directly. One process owns the database, samples every registered
  provider, and serves the HTTP API/dashboard.
- **Server + collectors**: the **server** is `daemon` with no `--provider`
  filter and no `INGEST_SERVER_URL` — it owns the database and serves
  `POST /api/usage/samples` (guarded by an optional `INGEST_TOKEN` bearer
  check) alongside the read API. Each **collector** is `daemon --provider
  <id>` with `INGEST_SERVER_URL` set, so `resolveSink()` in `src/cli/index.ts`
  builds a `createRemoteSink` instead — it never touches a database, and
  needs only that one provider's CLI and credentials.

The provider registry (`src/providers/index.ts`) and the capture/parse layer
are identical either way; only which `SnapshotSink` gets constructed changes.
This split exists to let a provider's collector run somewhere with narrower
access than the server — e.g. a container that only has one CLI's
credentials mounted, rather than all of them.

## Why screen-scrape a TUI instead of calling an API

As of writing, none of the supported CLIs expose rate-limit/usage data via a
documented, non-interactive flag — only their interactive `/usage` or
`/status` screen shows it. So capture works the way a human would: launch the
CLI headless in tmux, wait for it to be ready, send the usage command, wait
for the screen to render, capture the pane text, tear the session down. See
`src/capture/tmux.ts` for the exact sequence and `src/providers/*/parse.ts`
for the per-provider regex parsing of that captured text.

Each tmux session is disposable (kill stray session, launch fresh, capture,
kill again) rather than kept alive across polls. That trades a bit of
per-sample startup overhead for never having a stuck pane from one poll wedge
the next one. If startup overhead becomes a real problem at your sampling
interval, the natural next step is a kept-alive session per provider inside
`src/capture/tmux.ts` — the `UsageProvider`/`TuiCaptureConfig` shape above it
doesn't need to change either way.

## Storage shape

A `Sample` is one observation of one provider at one point in time (`ok`,
`error`, `resetCredits` if the provider reports manual reset tickets). It fans
out into zero or more `Window` rows — one per rate-limit window the provider
reported (e.g. Claude's "session" and "week", Codex's "5h" and "Weekly").
Splitting these lets a failed/partial capture still be recorded (as a sample
with no windows) without losing the attempt, and keeps window shape
(labels, how many, whether they're scoped to a sub-model) entirely
provider-defined — adding a provider with a different window shape never
requires a schema migration. See `prisma/schema.prisma`.

## Extensibility points

- **New provider**: see [`providers.md`](providers.md).
- **New window label** (e.g. a "monthly" window some future provider
  reports): register its duration in `src/domain/window-kinds.ts` — no
  schema or API changes needed, since `window` is stored as free text.
