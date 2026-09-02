export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!r.ok) throw new Error(String(r.status));
  if (r.headers.get("content-type")?.includes("application/json")) return r.json() as Promise<T>;
  return undefined as T;
}

export type AgentMode = "ask" | "plan" | "build";

export type Bot = {
  id: string;
  name: string;
  title: string;
  description: string;
  pinned: boolean;
  mode?: AgentMode;
  last_message?: string | null;
};

export type Msg = { id: string; role: string; content: string; created_at: string };
export type Provider = {
  id: string;
  kind: string;
  name: string;
  base_url: string | null;
  default_model: string;
  has_key: boolean;
};
