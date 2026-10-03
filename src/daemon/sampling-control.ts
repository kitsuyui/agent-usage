import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

export const samplingIntervalSchema = z.number().int().min(60).max(86400);
export const samplingConfigSchema = z.object({
  intervalSeconds: samplingIntervalSchema,
  refreshRequestId: z.string().nullable(),
  refreshRequestedAt: z.string().datetime().nullable(),
});
export type SamplingConfig = z.infer<typeof samplingConfigSchema>;
export interface SamplingControl {
  read(): Promise<SamplingConfig>;
  setInterval(seconds: number): Promise<SamplingConfig>;
  requestRefresh(): Promise<SamplingConfig>;
}

export function createSamplingControl(db: PrismaClient, defaultInterval: number): SamplingControl {
  const initialInterval = samplingIntervalSchema.parse(defaultInterval);
  const initialize = async () => (await db.samplingControl.findUnique({ where: { id: "global" } }))
    ?? await db.samplingControl.upsert({
      where: { id: "global" }, update: {}, create: { id: "global", intervalSeconds: initialInterval },
    });
  const payload = (row: Awaited<ReturnType<typeof initialize>>): SamplingConfig => ({
    intervalSeconds: row.intervalSeconds,
    refreshRequestId: row.refreshRequestId,
    refreshRequestedAt: row.refreshRequestedAt?.toISOString() ?? null,
  });
  return {
    async read() { return payload(await initialize()); },
    async setInterval(seconds) {
      samplingIntervalSchema.parse(seconds);
      await initialize();
      return payload(await db.samplingControl.update({
        where: { id: "global" }, data: { intervalSeconds: seconds },
      }));
    },
    async requestRefresh() {
      await initialize();
      return payload(await db.samplingControl.update({
        where: { id: "global" },
        data: { refreshRequestId: crypto.randomUUID(), refreshRequestedAt: new Date() },
      }));
    },
  };
}

export function createRemoteControlReader(url: string): () => Promise<SamplingConfig> {
  const endpoint = new URL("/api/sampling", url);
  return async () => {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`sampling settings request failed: ${response.status}`);
    return samplingConfigSchema.parse(await response.json());
  };
}
