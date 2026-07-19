import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { listProviders } from "../providers/index.ts";
import { distinctProviders, latestSnapshot, latestSnapshots, nextResets, queryHistory } from "../storage/repository.ts";

/** Builds the MCP server exposing recorded usage data as read-only tools. */
export function createMcpServer(db: PrismaClient): McpServer {
  const server = new McpServer({ name: "agent-usage", version: "0.1.0" });

  server.registerTool(
    "list_providers",
    {
      title: "List usage providers",
      description:
        "Lists agent CLI providers this server can report rate-limit/usage data for, and whether each has recorded data yet.",
    },
    async () => {
      const withData = new Set(await distinctProviders(db));
      return textResult(
        listProviders().map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          hasData: withData.has(provider.id),
        })),
      );
    },
  );

  server.registerTool(
    "get_latest_usage",
    {
      title: "Get latest usage",
      description:
        "Returns the most recently recorded rate-limit/usage snapshot for one provider, or every provider with data when omitted.",
      inputSchema: {
        provider: z
          .string()
          .optional()
          .describe('Provider id, e.g. "claude", "codex", "antigravity". Omit for all providers.'),
      },
    },
    async ({ provider }) => {
      if (provider) {
        const snapshot = await latestSnapshot(db, provider);
        return textResult(snapshot ? [snapshot] : []);
      }
      return textResult(await latestSnapshots(db));
    },
  );

  server.registerTool(
    "get_usage_history",
    {
      title: "Get usage history",
      description:
        "Returns a time series of rate-limit/usage observations, optionally filtered by provider, window label, and time range.",
      inputSchema: {
        provider: z.string().optional(),
        window: z.string().optional().describe('Provider-specific window label, e.g. "5h", "Weekly", "session".'),
        since: z.string().optional().describe("ISO-8601 timestamp; only observations at or after this time."),
        until: z.string().optional().describe("ISO-8601 timestamp; only observations at or before this time."),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ provider, window, since, until, limit }) => {
      const points = await queryHistory(db, {
        ...(provider ? { provider } : {}),
        ...(window ? { window } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return textResult(points);
    },
  );

  server.registerTool(
    "get_next_resets",
    {
      title: "Get next reset times",
      description: "Returns each provider's most recently observed rate-limit windows and when they next reset.",
    },
    async () => textResult(await nextResets(db)),
  );

  return server;
}

/** Starts the MCP server over stdio (the transport agent CLIs expect). */
export async function startMcpStdioServer(db: PrismaClient): Promise<McpServer> {
  const server = createMcpServer(db);
  await server.connect(new StdioServerTransport());
  return server;
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
