import type { TuiCaptureConfig } from "../providers/types.ts";

/**
 * Drives a provider's interactive TUI inside a disposable tmux session and
 * returns the final captured pane text.
 *
 * None of `claude`, `codex`, or `agy` expose usage/quota through a
 * non-interactive flag today, so this screen-scrapes the same way a human
 * would: launch the CLI headless in tmux, wait for it to be ready, send the
 * usage slash-command, wait for the screen to render, capture the pane, and
 * tear the session down. One session per call — kept disposable (rather than
 * left running) so a stuck pane from one poll can never wedge the next one;
 * see docs/architecture.md for the tradeoff against a kept-alive session.
 */
export interface TmuxCaptureOptions {
  sessionPrefix?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  expectedAttempts?: number;
}

const DEFAULT_POLL_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_EXPECTED_ATTEMPTS = 15;

export async function captureTui(
  providerId: string,
  config: TuiCaptureConfig,
  options: TmuxCaptureOptions = {},
): Promise<string> {
  const session = `${options.sessionPrefix ?? "agent-usage"}-${providerId}-${process.pid}`;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const expectedAttempts = options.expectedAttempts ?? DEFAULT_EXPECTED_ATTEMPTS;

  await tmux(["kill-session", "-t", session]);
  // remain-on-exit (scoped to this session, not -g, so a shared host tmux
  // server is unaffected) keeps the pane around if the CLI dies, so its last
  // words are capturable instead of the whole session silently vanishing.
  // Chained into the same tmux call to minimize the launch/set race.
  const launch = await tmux([
    "new-session", "-d", "-s", session, "-x", "200", "-y", "50", config.command,
    ";", "set-option", "-t", session, "remain-on-exit", "on",
  ]);
  if (launch.exitCode !== 0) {
    throw new Error(
      `failed to launch tmux session for provider "${providerId}": ${launch.stderr.trim() || "(no stderr)"}`,
    );
  }

  try {
    let pane = "";
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      await sleep(pollIntervalMs);
      pane = await capturePane(session);
      // The CLI exited before (or instead of) rendering its UI — return what
      // it left behind (startup errors etc.) rather than waiting out the
      // polls and interacting with a corpse.
      if (await paneIsDead(session)) return pane;
      const interstitial = config.interstitials?.find((entry) => entry.pattern.test(pane));
      if (interstitial) {
        await tmux(["send-keys", "-t", session, interstitial.sendKeys, "Enter"]);
        continue;
      }
      if (config.readyPattern.test(pane)) break;
    }

    await tmux(["send-keys", "-t", session, config.slashCommand]);
    await sleep(1000);
    await tmux(["send-keys", "-t", session, "Enter"]);

    for (let attempt = 0; attempt < expectedAttempts; attempt += 1) {
      await sleep(pollIntervalMs);
      pane = await capturePane(session);
      if (await paneIsDead(session)) return pane;
      if (config.expectedPattern.test(pane)) break;
    }
    return pane;
  } finally {
    await tmux(["send-keys", "-t", session, "C-c"]);
    await sleep(500);
    await tmux(["send-keys", "-t", session, "C-c"]);
    await sleep(500);
    await tmux(["kill-session", "-t", session]);
  }
}

async function capturePane(session: string): Promise<string> {
  const result = await tmux(["capture-pane", "-t", session, "-p"]);
  return result.exitCode === 0 ? result.stdout : "";
}

async function paneIsDead(session: string): Promise<boolean> {
  const result = await tmux(["list-panes", "-t", session, "-F", "#{pane_dead}"]);
  return result.exitCode === 0 ? result.stdout.trim().startsWith("1") : true;
}

async function tmux(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Nested tmux sessions get confused if the parent's TMUX env var leaks in
  // when this daemon is itself run inside a long-lived tmux/screen session.
  const env = { ...process.env };
  delete env.TMUX;
  try {
    const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch {
    return { stdout: "", stderr: "tmux binary not found or not executable", exitCode: 1 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
