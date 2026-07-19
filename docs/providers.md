# Adding a provider

A provider is a `UsageProvider` (`src/providers/types.ts`): an id, a display
name, a TUI capture config, and a `parse` function. Nothing outside
`src/providers/` needs to change — storage, HTTP, MCP, and the dashboard all
work against `UsageSnapshot`/`UsageWindow`, not provider-specific types.

## 1. Write the parser

Look at `src/providers/codex/parse.ts` for a worked example. The job is:
given the raw text captured from the CLI's usage screen and an `observedAt`
timestamp, return a `UsageSnapshot` (`src/domain/types.ts`). Use
`usedWindow`/`remainingWindow` from `src/domain/window-builder.ts` to build
each window — they resolve `resetsAt` and `windowSeconds` for you from
`resetsRaw` and the window label.

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

## 3. Configure the TUI capture

In the provider's `index.ts`, fill in a `TuiCaptureConfig`
(`src/providers/types.ts`):

- `command`: the shell command that launches the CLI.
- `readyPattern`: text that appears once the CLI is ready for input.
- `slashCommand`: the command that opens the usage screen (e.g. `/usage`).
- `expectedPattern`: text that appears once that screen has finished
  rendering.
- `interstitials` (optional): known first-launch prompts to auto-dismiss
  while waiting for `readyPattern` — `DEFAULT_INTERSTITIALS` in
  `src/providers/shared.ts` already covers the update-banner and
  trust-this-folder prompts seen across multiple CLIs.

If the provider has a real non-interactive, machine-readable usage endpoint
(as GitHub Copilot does via `gh api .../premium_request/usage`), skip the TUI
entirely: give it a `capture`-free path by writing a custom collector instead
of going through `src/capture/tmux.ts` — prefer that whenever it's available,
since it's strictly cheaper and more reliable than screen-scraping.

## 4. Register it

Add the provider to `registerBuiltinProviders()` in `src/providers/index.ts`.

## 5. Verify without spending real API usage

Don't rely on the real CLI for iteration — write parser unit tests against
captured fixture text (copy real output once, then iterate against the
fixture). Only run the actual `tmux` capture path once the parser is solid,
since every real run launches an authenticated session against your own
account.
