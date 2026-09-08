import type { TuiCaptureConfig } from "../providers/types.ts";

/**
 * Drives a provider's interactive TUI inside an isolated, disposable tmux
 * session and returns the final captured pane text.
 *
 * None of `claude`, `codex`, or `agy` expose usage/quota through a
 * non-interactive flag today, so this screen-scrapes the same way a human
 * would: launch the CLI headless in a private tmux server, wait for it to be
 * ready, send the usage slash-command, wait for the screen to render, capture
 * the pane, and tear the session down. One session per call — kept disposable
 * (rather than left running) so a stuck pane from one poll can never wedge the
 * next one; see docs/architecture.md for the tradeoff against a kept-alive
 * session.
 */
export interface TmuxCaptureOptions {
  sessionPrefix?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  expectedAttempts?: number;
  /** Injectable for deterministic capture tests. */
  runTmux?: TmuxRunner;
  /** Injectable for deterministic capture tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type TmuxResult = { stdout: string; stderr: string; exitCode: number };
export type TmuxRunner = (args: string[]) => Promise<TmuxResult>;

// A first cold launch can spend appreciable time loading extensions and
// credentials. Keep that bounded, but allow it longer than the usage screen.
const DEFAULT_POLL_ATTEMPTS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_EXPECTED_ATTEMPTS = 15;
const TMUX_SOCKET_NAME = `agent-usage-${process.pid}`;

export async function captureTui(
  providerId: string,
  config: TuiCaptureConfig,
  options: TmuxCaptureOptions = {},
): Promise<string> {
  const session = `${options.sessionPrefix ?? "agent-usage"}-${providerId}-${process.pid}`;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const expectedAttempts = options.expectedAttempts ?? DEFAULT_EXPECTED_ATTEMPTS;
  const runTmux = options.runTmux ?? tmux;
  const wait = options.sleep ?? sleep;

  await runTmux(["kill-session", "-t", session]);
  // remain-on-exit (scoped to this session, not -g, so a shared host tmux
  // server is unaffected) keeps the pane around if the CLI dies, so its last
  // words are capturable instead of the whole session silently vanishing.
  // Chained into the same tmux call to minimize the launch/set race.
  const launch = await runTmux([
    "new-session", "-d", "-s", session, "-x", "200", "-y", "50", config.command,
    ";", "set-option", "-t", session, "remain-on-exit", "on",
  ]);
  if (launch.exitCode !== 0) {
    throw new Error(`provider "${providerId}" TUI failed to launch (exit code ${launch.exitCode})`);
  }

  try {
    let pane = "";
    let ready = false;
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      await wait(pollIntervalMs);
      pane = await capturePane(session, runTmux);
      // The CLI exited before (or instead of) rendering its UI — return what
      // it left behind (startup errors etc.) rather than waiting out the
      // polls and interacting with a corpse.
      if (await paneIsDead(session, runTmux)) return pane;
      const interstitial = config.interstitials?.find((entry) => entry.pattern.test(pane));
      if (interstitial) {
        await runTmux(["send-keys", "-t", session, interstitial.sendKeys, "Enter"]);
        continue;
      }
      if (config.readyPattern.test(pane)) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      throw new Error(`provider "${providerId}" TUI did not become ready before startup timeout`);
    }

    await runTmux(["send-keys", "-t", session, config.slashCommand]);
    await wait(1000);
    await runTmux(["send-keys", "-t", session, "Enter"]);

    for (let attempt = 0; attempt < expectedAttempts; attempt += 1) {
      await wait(pollIntervalMs);
      pane = await capturePane(session, runTmux);
      if (await paneIsDead(session, runTmux)) return pane;
      if (config.expectedPattern.test(pane)) break;
    }
    return pane;
  } finally {
    await runTmux(["send-keys", "-t", session, "C-c"]);
    await wait(500);
    await runTmux(["send-keys", "-t", session, "C-c"]);
    await wait(500);
    await runTmux(["kill-session", "-t", session]);
  }
}

async function capturePane(session: string, runTmux: TmuxRunner): Promise<string> {
  const result = await runTmux(["capture-pane", "-t", session, "-p"]);
  return result.exitCode === 0 ? result.stdout : "";
}

async function paneIsDead(session: string, runTmux: TmuxRunner): Promise<boolean> {
  const result = await runTmux(["list-panes", "-t", session, "-F", "#{pane_dead}"]);
  return result.exitCode === 0 ? result.stdout.trim().startsWith("1") : true;
}

async function tmux(args: string[]): Promise<TmuxResult> {
  // Never reuse the user's tmux server. A tmux server retains the environment
  // and launch context that created it, so attaching collector panes to an
  // older server can make provider CLIs observe stale credentials even when
  // the daemon itself has the correct environment.
  const env = { ...process.env };
  delete env.TMUX;
  try {
    const proc = Bun.spawn(buildTmuxCommand(args), { stdout: "pipe", stderr: "pipe", env });
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

export function buildTmuxCommand(
  args: string[],
  socketName = TMUX_SOCKET_NAME,
): string[] {
  return ["tmux", "-L", socketName, "-f", "/dev/null", ...args];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
