import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { decrypt } from "./crypto.js";
import { q } from "./db.js";
import type { ToolSpec } from "./providers.js";

type ServerRow = {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  url: string | null;
  env_enc: string | null;
};

const live = new Map<string, Client>();

export function dropMcp(id: string) {
  const c = live.get(id);
  live.delete(id);
  void c?.close().catch(() => {});
}

async function connect(row: ServerRow): Promise<Client> {
  const cached = live.get(row.id);
  if (cached) return cached;
  const client = new Client({ name: "janus", version: "0.1.0" }, { capabilities: {} });
  if (row.transport === "sse" && row.url) {
    const t = new SSEClientTransport(new URL(row.url));
    await client.connect(t);
  } else if (row.command) {
    const env = row.env_enc ? (JSON.parse(decrypt(row.env_enc)) as Record<string, string>) : {};
    const parts = row.command.split(" ").filter(Boolean);
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) merged[k] = v;
    }
    const t = new StdioClientTransport({ command: parts[0], args: parts.slice(1), env: { ...merged, ...env } });
    await client.connect(t);
  } else {
    throw new Error("mcp transport");
  }
  live.set(row.id, client);
  return client;
}

export async function mcpTools(userId: string): Promise<(ToolSpec & { serverId: string; serverName: string })[]> {
  const rows = await q<ServerRow>(
    `select * from mcp_servers where user_id = $1 and enabled = true`,
    [userId],
  );
  const out: (ToolSpec & { serverId: string; serverName: string })[] = [];
  for (const row of rows) {
    try {
      const c = await connect(row);
      const listed = await c.listTools();
      for (const t of listed.tools) {
        out.push({
          serverId: row.id,
          serverName: row.name,
          name: `mcp_${row.name}_${t.name}`.replace(/\W/g, "_"),
          description: t.description ?? t.name,
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        });
      }
    } catch {
      // server down; skip
    }
  }
  return out;
}

export async function callMcp(userId: string, toolName: string, args: unknown) {
  const rows = await q<ServerRow>(
    `select * from mcp_servers where user_id = $1 and enabled = true`,
    [userId],
  );
  for (const row of rows) {
    const prefix = `mcp_${row.name}_`.replace(/\W/g, "_");
    if (!toolName.startsWith(prefix) && !toolName.startsWith(`mcp_${row.name}_`)) continue;
    const orig = toolName.replace(prefix, "").replace(`mcp_${row.name}_`, "");
    const c = await connect(row);
    const r = await c.callTool({ name: orig, arguments: (args ?? {}) as Record<string, unknown> });
    return JSON.stringify(r);
  }
  throw new Error("mcp tool missing");
}
