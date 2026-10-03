import type { SamplingConfig } from "./sampling-control.ts";

/** State machine shared by local and remote collectors. Captures never overlap. */
export class SamplingSchedule {
  intervalSeconds: number;
  nextSampleAt: number;
  private requestId: string | null = null;
  private initialized = false;

  constructor(intervalSeconds: number, now: number) {
    this.intervalSeconds = intervalSeconds;
    this.nextSampleAt = now;
  }

  apply(config: SamplingConfig, now: number): void {
    if (config.intervalSeconds !== this.intervalSeconds) {
      this.intervalSeconds = config.intervalSeconds;
      // An already-due capture stays due; otherwise restart the waiting period.
      if (this.nextSampleAt > now) this.nextSampleAt = now + this.intervalSeconds * 1000;
    }
    if (this.initialized && config.refreshRequestId !== this.requestId && config.refreshRequestId !== null) {
      this.nextSampleAt = now;
    }
    this.requestId = config.refreshRequestId;
    this.initialized = true;
  }

  completed(now: number): void {
    // If the initial control read failed, a request seen after reconnection
    // must still trigger capture. Prefer one extra pass to losing a command.
    this.initialized = true;
    this.nextSampleAt = now + this.intervalSeconds * 1000;
  }
}
