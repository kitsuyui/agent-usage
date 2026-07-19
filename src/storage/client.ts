import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Lazily creates (and reuses) the process-wide Prisma client. */
export function getPrismaClient(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export async function disconnectPrismaClient(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
