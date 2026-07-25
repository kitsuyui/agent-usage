import { captureTui } from "./tmux.ts";
import { emptySnapshot, type UsageSnapshot } from "../domain/types.ts";
import { toIsoSeconds } from "../domain/time.ts";
import type { UsageProvider } from "../providers/types.ts";

/** Captures and parses one usage snapshot for a single provider. */
export async function collectSnapshot(provider: UsageProvider): Promise<UsageSnapshot> {
  const observedAt = toIsoSeconds(new Date());
  const cliVersion = await captureCliVersion(provider);
  let raw = "";
  try {
    raw = await captureTui(provider.id, provider.tui);
    let snapshot = provider.parse(raw, observedAt);
    if (!snapshot.ok) {
      const failure = classifyCaptureFailure(raw);
      snapshot = { ...snapshot, error: failure.message, errorCode: failure.code };
    }
    if (cliVersion) snapshot = { ...snapshot, cliVersion };
    if (!snapshot.ok) logFailure(provider.id, raw);
    return snapshot;
  } catch (error) {
    logFailure(provider.id, raw);
    const snapshot = emptySnapshot(
      provider.id,
      observedAt,
      error instanceof Error ? error.message : String(error),
    );
    return cliVersion ? { ...snapshot, cliVersion } : snapshot;
  }
}

const VERSION_TIMEOUT_MS = 5_000;

export async function captureCliVersion(provider: UsageProvider): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(provider.versionCommand, { stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const timer = setTimeout(() => proc.kill(), VERSION_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const [stdout, stderr] = await output;
    if (exitCode !== 0) return undefined;
    return `${stdout}\n${stderr}`
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export function classifyCaptureFailure(raw: string): { code: string; message: string } {
  if (
    /please use \/login|not logged in|invalid authentication credentials|authentication failed|login required|sign in to|unauthorized|\b401\b/i.test(
      raw,
    )
  ) {
    return { code: "authentication_required", message: "provider authentication is required" };
  }
  if (/Loading usage data/i.test(raw)) {
    return { code: "usage_data_unavailable", message: "provider usage data did not finish loading" };
  }
  if (raw.trim() === "") {
    return { code: "capture_failed", message: "provider capture returned no output" };
  }
  return { code: "parse_failed", message: "provider output contained no recognized usage windows" };
}

// Diagnostic-only: the captured pane is UI chrome (window labels, percentages,
// prompts), not a secret, and this is exactly what you need to see to tell a
// stuck trust/update prompt apart from a genuinely unrecognized screen.
function logFailure(providerId: string, raw: string): void {
  console.error(`[${providerId}] capture produced no usable output; raw pane follows:\n${raw || "(empty)"}`);
}
