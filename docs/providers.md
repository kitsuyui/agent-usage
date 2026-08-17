# Adding a provider

A provider is a `UsageProvider` (`src/providers/types.ts`): an id, a display
name, a non-interactive `versionCommand`, either a machine-readable `capture`
function or a TUI capture config, and a `parse` function. Nothing outside
`src/providers/` needs to change — storage, HTTP, MCP, and the dashboard all
work against `UsageSnapshot`/`UsageWindow`, not provider-specific types.

## 1. Write the parser

Look at `src/providers/codex/parse.ts` for a worked example. The job is:
given the raw text captured from the CLI's usage screen and an `observedAt`
timestamp, return a `UsageSnapshot` (`src/domain/types.ts`). Use
`usedWindow`/`remainingWindow` from `src/domain/window-builder.ts` to build
each window — they resolve `resetsAt` and `windowSeconds` for you from
`resetsRaw` and the window label.

Use `measuredWindow` when the provider reports an absolute value rather than
a percentage. `metric` and `unit` are intentionally free text, and
`attributes` can identify dimensions such as model, plan, billing category,
or tier. Do not add a model-name enum or a single mutable pricing table:
record provider-reported prices as timestamped measurements so later price
changes do not rewrite the meaning of historical data.

Only emit windows and limits that the provider actually reports. In
particular, do not synthesize a familiar time window from product
documentation when the authenticated CLI output no longer exposes it; the
absence may reflect the account, plan, model, or a product change.

This function is pure (no I/O), so write its tests first against real
captured text (see `tests/providers/parse.test.ts` for the pattern) before
worrying about how to actually capture that text from the live CLI.

If the CLI's screen never shows a reset time but the provider documents a
fixed reset rule instead (e.g. Copilot's included credits, which GitHub's
docs say always reset at 00:00 UTC on the 1st — see
`src/providers/copilot/parse.ts`), compute `resetsAt` directly and pass it to
`usedWindow`/`remainingWindow` instead of `resetsRaw`; it takes precedence.

## 2. Register a window-kind duration if needed

If the provider uses a window label not already in
`src/domain/window-kinds.ts` (`5h`/`session`, `daily`/`day`,
`weekly`/`week`, `monthly`/`month`), call `registerWindowKind("your-label",
seconds)` — e.g. in the provider's `index.ts`, before it's registered.

## 3. Configure capture

Prefer a machine-readable `capture` function when the CLI exposes one. Codex,
for example, uses app-server's `account/rateLimits/read`; it reads the current
account limits without starting or persisting a conversation thread.

Otherwise configure the TUI capture in the provider's `index.ts`:

In the provider's `index.ts`, fill in a `TuiCaptureConfig`
(`src/providers/types.ts`):

- `versionCommand`: a non-interactive version invocation such as
  `["codex", "--version"]`. Its first non-empty output line is stored on
  every sample, including failed captures.
- `command`: the shell command that launches the CLI.
- `readyPattern`: text that appears once the CLI is ready for input.
- `slashCommand`: the command that opens the usage screen (e.g. `/usage`).
- `expectedPattern`: text that appears once that screen has finished
  rendering.
- `interstitials` (optional): known first-launch prompts to auto-dismiss
  while waiting for `readyPattern` — `DEFAULT_INTERSTITIALS` in
  `src/providers/shared.ts` already covers the update-banner and
  trust-this-folder prompts seen across multiple CLIs.

Do not fall back from a machine-readable capture to the TUI automatically.
Failure should be recorded as collector health rather than risking an
interactive prompt being mistaken for user input.

## 4. Register it

Add the provider to `registerBuiltinProviders()` in `src/providers/index.ts`.

## 5. Verify without spending real API usage

Don't rely on the real CLI for iteration — write parser unit tests against
captured fixture text (copy real output once, then iterate against the
fixture). Only run the actual `tmux` capture path once the parser is solid,
since every real run launches an authenticated session against your own
account.

## Failure diagnostics and authentication context

A captured TUI pane is sensitive diagnostic input. It can include account
identity, organization names, workspace paths, prompts, or conversation text,
so collector failures must log only a stable error code and a normalized
message. Never write the raw pane to logs. Fixtures derived from real captures
must be sanitized before they are committed.

Classify only what the captured output proves. For example,
`usage_windows_unavailable` means that the provider returned usage statistics
without the rate-limit windows the parser needs. It does not claim why the
provider chose that screen or whether a particular credential is wrong.

Authentication is a deployment prerequisite. Validate it from the same
execution context as the collector: an interactive shell and a background
service can see different environment variables, credential stores, or login
state. Keep those host-specific authentication checks outside provider parsing
so an environment problem remains distinguishable from a collector defect.
