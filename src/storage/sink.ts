import type { PrismaClient } from "@prisma/client";
import type { UsageSnapshot } from "../domain/types.ts";
import { recordSnapshot } from "./repository.ts";

/** Where a captured snapshot goes once it's parsed. Decouples capture from storage. */
export interface SnapshotSink {
  record(snapshot: UsageSnapshot): Promise<void>;
}

/** Writes directly to the local database — the all-in-one (server + collector) deployment. */
export function createLocalSink(db: PrismaClient): SnapshotSink {
  return {
    record: (snapshot) => recordSnapshot(db, snapshot),
  };
}
