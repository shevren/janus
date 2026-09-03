import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { decrypt } from "./crypto.js";
import { q, q1 } from "./db.js";

export type ProviderRow = {
  id: string;
  kind: string;
  name: string;
  base_url: string | null;
  api_key_enc: string | null;
  default_model: string;
};

export type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string };

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelOut = {
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
};

export async function listProviders(userId: string) {
  return q<ProviderRow>(
    `select id, kind, name, base_url, default_model, enabled from model_providers where user_id = $1 order by created_at`,
    [userId],
  );
}

export async function activeProvider(userId: string): Promise<ProviderRow | undefined> {
  const row = await q1<ProviderRow>(
    `select * from model_providers where user_id = $1 and enabled = true order by created_at limit 1`,
    [userId],
  );
  if (row) return row;
  const apiKey = process.env.AGENT_MODEL_API_KEY ?? "";
  if (!apiKey) return undefined;
  return {
    id: "env-default",
    kind: "openai",
    name: "janus-default",
    base_url: process.env.AGENT_MODEL_BASE_URL || null,
    api_key_enc: null,
    default_model: process.env.AGENT_MODEL_DEFAULT || "kimi-k3",
  } as unknown as ProviderRow;
}

function keyOf(row: ProviderRow) {
  if ((row as { id?: string }).id === "env-default") return process.env.AGENT_MODEL_API_KEY ?? "";
  return row.api_key_enc ? decrypt(row.api_key_enc) : "";
}

export async function complete(
  row: ProviderRow,
  messages: ChatMsg[],
  tools: ToolSpec[],
): Promise<ModelOut> {
  const kind = row.kind;
  if (kind === "anthropic") return anthropic(row, messages, tools);
  return openaiCompat(row, messages, tools);
}

export async function lookImage(
  row: ProviderRow,
  bytes: Buffer,
  mime: string,
  prompt: string,
): Promise<string> {
  const b64 = bytes.toString("base64");
  const ask = prompt || "Describe what matters for the current job. Be concrete.";
  if (row.kind === "anthropic") {
    const client = new Anthropic({ apiKey: keyOf(row) });
    const r = await client.messages.create({
      model: row.default_model || "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: b64 } },
            { type: "text", text: ask },
          ],
        },
      ],
    });
    return r.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  }
  const client = new OpenAI({
    apiKey: keyOf(row) || "x",
    baseURL: row.base_url || (row.kind === "google" ? "https://generativelanguage.googleapis.com/v1beta/openai/" : undefined),
  });
  const r = await client.chat.completions.create({
    model: row.default_model || "gpt-4.1",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: ask },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
  });
  return r.choices[0]?.message?.content ?? "";
}

async function openaiCompat(row: ProviderRow, messages: ChatMsg[], tools: ToolSpec[]): Promise<ModelOut> {
  const client = new OpenAI({
    apiKey: keyOf(row) || "x",
    baseURL: row.base_url || (row.kind === "google" ? "https://generativelanguage.googleapis.com/v1beta/openai/" : undefined),
  });
  const mapped = messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool" as const, content: m.content, tool_call_id: m.name ?? "tool" };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });
  const r = await client.chat.completions.create({
    model: row.default_model || "gpt-4.1",
    messages: mapped,
    tools: tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  });
  const choice = r.choices[0]?.message;
  const toolCalls =
    choice?.tool_calls?.map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    })) ?? [];
  return { text: choice?.content ?? "", toolCalls };
}

async function anthropic(row: ProviderRow, messages: ChatMsg[], tools: ToolSpec[]): Promise<ModelOut> {
  const client = new Anthropic({ apiKey: keyOf(row) });
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const rest = messages.filter((m) => m.role !== "system");
  const r = await client.messages.create({
    model: row.default_model || "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: system || undefined,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    })),
    messages: rest.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  });
  let text = "";
  const toolCalls: ModelOut["toolCalls"] = [];
  for (const part of r.content) {
    if (part.type === "text") text += part.text;
    if (part.type === "tool_use") {
      toolCalls.push({ id: part.id, name: part.name, arguments: JSON.stringify(part.input) });
    }
  }
  return { text, toolCalls };
}
