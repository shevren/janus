import path from "node:path";
import { decrypt, encrypt } from "./crypto.js";
import { q, q1 } from "./db.js";
import { githubConn } from "./github.js";
import { dropMcp } from "./mcp.js";
import { bundledSkills } from "./skills.js";
import { workspace } from "./sandbox.js";
import { searchWebHttp } from "./daily.js";

export type CatalogHit = {
  id: string;
  kind: "mcp" | "skill";
  name: string;
  summary: string;
  source: string;
  transport?: "stdio" | "sse";
  command?: string;
  url?: string;
  envKeys?: string[];
  body?: string;
};

type KnownMcp = {
  id: string;
  name: string;
  aliases: string[];
  summary: string;
  command: string;
  envKeys?: string[];
};

const KNOWN_MCP: KnownMcp[] = [
  {
    id: "playwright",
    name: "playwright",
    aliases: ["playwright", "browser mcp", "playwright mcp"],
    summary: "Playwright browser tools over MCP.",
    command: "npx -y @playwright/mcp",
  },
  {
    id: "github",
    name: "github",
    aliases: ["github", "github mcp", "gh mcp"],
    summary: "GitHub MCP. Uses the Channels GitHub token when connected.",
    command: "npx -y @modelcontextprotocol/server-github",
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  },
  {
    id: "filesystem",
    name: "filesystem",
    aliases: ["filesystem", "files", "fs mcp", "workspace files"],
    summary: "Read and write the computer workspace over MCP.",
    command: "npx -y @modelcontextprotocol/server-filesystem",
  },
  {
    id: "fetch",
    name: "fetch",
    aliases: ["fetch", "http mcp"],
    summary: "HTTP fetch MCP.",
    command: "npx -y @modelcontextprotocol/server-fetch",
  },
  {
    id: "memory",
    name: "memory",
    aliases: ["memory", "memory mcp"],
    summary: "Persistent memory MCP.",
    command: "npx -y @modelcontextprotocol/server-memory",
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    aliases: ["sequential thinking", "thinking"],
    summary: "Sequential thinking MCP.",
    command: "npx -y @modelcontextprotocol/server-sequential-thinking",
  },
  {
    id: "context7",
    name: "context7",
    aliases: ["context7", "docs", "documentation", "library docs", "fresh docs"],
    summary: "Fresh library/framework docs (Context7). Use before writing code with any library.",
    command: "npx -y @upstash/context7-mcp",
  },
  {
    id: "sqlite",
    name: "sqlite",
    aliases: ["sqlite", "sql mcp"],
    summary: "SQLite MCP. Point it at a workspace database path.",
    command: "npx -y @modelcontextprotocol/server-sqlite",
  },
  {
    id: "postgres",
    name: "postgres",
    aliases: ["postgres", "postgresql"],
    summary: "Postgres MCP. Needs a DATABASE_URL in env; never the Janus app database unless asked.",
    command: "npx -y @modelcontextprotocol/server-postgres",
    envKeys: ["DATABASE_URL"],
  },
  {
    id: "brave-search",
    name: "brave-search",
    aliases: ["brave", "brave search"],
    summary: "Brave Search MCP. Needs BRAVE_API_KEY.",
    command: "npx -y @modelcontextprotocol/server-brave-search",
    envKeys: ["BRAVE_API_KEY"],
  },
  {
    id: "puppeteer",
    name: "puppeteer",
    aliases: ["puppeteer"],
    summary: "Puppeteer MCP.",
    command: "npx -y @modelcontextprotocol/server-puppeteer",
  },
];

const PKG = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const BINS = new Set(["npx", "node", "python", "python3", "uvx"]);

export function safeCommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!trimmed || /[;&|`$<>]/.test(trimmed)) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (!parts.length || !BINS.has(parts[0])) return null;
  if (parts[0] === "npx") {
    const rest = parts.slice(1).filter((p) => p !== "-y" && p !== "--yes");
    const pkg = rest[0]?.replace(/@latest$/, "") ?? "";
    const name = pkg.startsWith("@") ? pkg.replace(/@[^@/]+$/, "") : pkg.split("@")[0];
    if (!PKG.test(name)) return null;
    return ["npx", "-y", ...rest].join(" ");
  }
  return parts.join(" ");
}

function safeHttps(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function score(query: string, aliases: string[]) {
  const q = query.toLowerCase();
  let best = 0;
  for (const a of aliases) {
    const n = a.toLowerCase();
    if (n === q) best = Math.max(best, 100);
    else if (n.includes(q) || q.includes(n)) best = Math.max(best, 70);
    else if (q.split(/\s+/).some((w) => w.length > 2 && n.includes(w))) best = Math.max(best, 40);
  }
  return best;
}

function knownHit(k: KnownMcp): CatalogHit {
  return {
    id: `known:${k.id}`,
    kind: "mcp",
    name: k.name,
    summary: k.summary,
    source: "registry",
    transport: "stdio",
    command: k.command,
    envKeys: k.envKeys,
  };
}

async function searchNpm(query: string): Promise<CatalogHit[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`${query} mcp`)}&size=8`;
  const r = await fetch(url, { headers: { "User-Agent": "janus" } });
  if (!r.ok) return [];
  const json = (await r.json()) as {
    objects?: { package: { name: string; description?: string; keywords?: string[] } }[];
  };
  const out: CatalogHit[] = [];
  for (const obj of json.objects ?? []) {
    const p = obj.package;
    const blob = `${p.name} ${p.description ?? ""} ${(p.keywords ?? []).join(" ")}`.toLowerCase();
    if (!blob.includes("mcp") && !p.name.includes("mcp")) continue;
    if (!PKG.test(p.name)) continue;
    out.push({
      id: `npm:${p.name}`,
      kind: "mcp",
      name: p.name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]+/gi, "-"),
      summary: p.description ?? p.name,
      source: "npm",
      transport: "stdio",
      command: `npx -y ${p.name}`,
    });
  }
  return out;
}

async function ghHeaders(userId: string): Promise<Record<string, string>> {
  const conn = await githubConn(userId);
  const h: Record<string, string> = { "User-Agent": "janus", Accept: "application/vnd.github+json" };
  if (conn) h.Authorization = `Bearer ${decrypt(conn.token_enc)}`;
  return h;
}

async function searchGithubMcp(userId: string, query: string): Promise<CatalogHit[]> {
  const conn = await githubConn(userId);
  if (!conn) return [];
  const q = encodeURIComponent(`${query} filename:mcp.json`);
  const r = await fetch(`https://api.github.com/search/code?q=${q}`, { headers: await ghHeaders(userId) });
  if (!r.ok) return [];
  const json = (await r.json()) as {
    items?: { repository: { full_name: string }; path: string; html_url: string }[];
  };
  const out: CatalogHit[] = [];
  for (const item of (json.items ?? []).slice(0, 6)) {
    const raw = await fetchMcpJson(item.repository.full_name, item.path, userId);
    if (!raw) continue;
    out.push(...raw);
  }
  return out;
}

async function fetchMcpJson(fullName: string, filePath: string, userId: string): Promise<CatalogHit[] | null> {
  const [owner, repo] = fullName.split("/");
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`;
  const r = await fetch(url, { headers: await ghHeaders(userId) });
  if (!r.ok) return null;
  let json: unknown;
  try {
    json = JSON.parse(await r.text());
  } catch {
    return null;
  }
  const servers = (json as { mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }> })
    .mcpServers;
  if (!servers) return null;
  const hits: CatalogHit[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.url) {
      const https = safeHttps(spec.url);
      if (!https) continue;
      hits.push({
        id: `ghjson:${fullName}:${name}`,
        kind: "mcp",
        name,
        summary: `From ${fullName} mcp.json (HTTP).`,
        source: "github",
        transport: "sse",
        url: https,
      });
      continue;
    }
    const cmd = safeCommand([spec.command, ...(spec.args ?? [])].filter(Boolean).join(" "));
    if (!cmd) continue;
    hits.push({
      id: `ghjson:${fullName}:${name}`,
      kind: "mcp",
      name,
      summary: `From ${fullName} mcp.json.`,
      source: "github",
      transport: "stdio",
      command: cmd,
    });
  }
  return hits;
}

async function searchGithubSkills(userId: string, query: string): Promise<CatalogHit[]> {
  const conn = await githubConn(userId);
  if (!conn) return [];
  const q = encodeURIComponent(`${query} filename:SKILL.md`);
  const r = await fetch(`https://api.github.com/search/code?q=${q}`, { headers: await ghHeaders(userId) });
  if (!r.ok) return [];
  const json = (await r.json()) as {
    items?: { repository: { full_name: string }; path: string; html_url: string }[];
  };
  const out: CatalogHit[] = [];
  for (const item of (json.items ?? []).slice(0, 8)) {
    const [owner, repo] = item.repository.full_name.split("/");
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${item.path}`;
    const body = await fetchSkillMd(rawUrl);
    if (!body) continue;
    const name = skillName(body, path.basename(path.dirname(item.path)));
    out.push({
      id: `ghskill:${item.repository.full_name}:${item.path}`,
      kind: "skill",
      name,
      summary: `${item.repository.full_name}/${item.path}`,
      source: "github",
      body,
    });
  }
  return out;
}

function skillName(body: string, fallback: string) {
  const fm = body.match(/^---\s*\nname:\s*(.+)\n/);
  if (fm) return fm[1].trim().replace(/^["']|["']$/g, "");
  return fallback.replace(/[^a-z0-9-]+/gi, "-") || "skill";
}

async function fetchSkillMd(url: string): Promise<string | null> {
  const https = safeHttps(url);
  if (!https) return null;
  const host = new URL(https).hostname;
  if (host !== "raw.githubusercontent.com" && host !== "github.com") return null;
  const raw =
    host === "github.com"
      ? https.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/")
      : https;
  const r = await fetch(raw, { headers: { "User-Agent": "janus" } });
  if (!r.ok) return null;
  const text = await r.text();
  if (text.length < 40 || text.length > 80_000) return null;
  if (!/skill|when to use|you will|steps/i.test(text) && !text.startsWith("---")) return null;
  if (/curl\s+\S+\s*\|\s*(bash|sh)/i.test(text)) return null;
  return text;
}

function bundledHits(query: string): CatalogHit[] {
  const q = query.toLowerCase();
  return bundledSkills()
    .filter((s) => {
      const blob = `${s.name} ${s.body}`.toLowerCase();
      if (!q.trim()) return true;
      return blob.includes(q) || score(q, [s.name, "учеба", "учебы", "study", "daily", "daily tools"]) > 0;
    })
    .map((s) => ({
      id: `bundled:${s.name}`,
      kind: "skill" as const,
      name: s.name,
      summary: s.body.slice(0, 160).replace(/\s+/g, " "),
      source: "bundled",
      body: s.body,
    }));
}

export async function catalogSearch(userId: string, query: string, kind: "mcp" | "skill" | "any"): Promise<string> {
  const q = query.trim();
  if (!q) return "Say what you need. Example: playwright mcp, github mcp, skill for studying.";
  const hits: CatalogHit[] = [];
  if (kind !== "skill") {
    const known = KNOWN_MCP.map((k) => ({ k, s: score(q, [...k.aliases, k.name, k.command]) }))
      .filter((x) => x.s >= 40)
      .sort((a, b) => b.s - a.s)
      .map((x) => knownHit(x.k));
    hits.push(...known);
    try {
      hits.push(...(await searchNpm(q)));
    } catch {
      /* npm down */
    }
    try {
      hits.push(...(await searchGithubMcp(userId, q)));
    } catch {
      /* github optional */
    }
  }
  if (kind !== "mcp") {
    hits.push(...bundledHits(q));
    try {
      hits.push(...(await searchGithubSkills(userId, q)));
    } catch {
      /* optional */
    }
  }
  if (!hits.length) {
    try {
      const web = await searchWebHttp(`${q} mcp server npm OR SKILL.md`);
      return `No catalog match yet. Web hints (not an install):\n${web.slice(0, 4000)}\n\nAsk again with a package name if you see one. Do not run install scripts.`;
    } catch {
      return "No catalog match. Try a clearer name, e.g. playwright mcp or study skill.";
    }
  }
  const seen = new Set<string>();
  const lines: string[] = [
    "Propose the best match. Then call catalog_install with that id after the user agrees.",
    "Never ask them to paste an MCP URL. You are the installer.",
    "",
  ];
  for (const h of hits) {
    const key = `${h.kind}:${h.name}:${h.command ?? h.url ?? h.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      [
        `${h.kind}  id=${h.id}`,
        `name ${h.name}`,
        `source ${h.source}`,
        h.summary,
        h.command ? `command ${h.command}` : "",
        h.url ? `url ${h.url}` : "",
        h.envKeys?.length ? `env ${h.envKeys.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    lines.push("");
  }
  return lines.join("\n").slice(0, 12_000);
}

function knownById(id: string): KnownMcp | undefined {
  if (!id.startsWith("known:")) return;
  return KNOWN_MCP.find((k) => k.id === id.slice(6));
}

export async function catalogInstall(
  userId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const kind = String(args.kind ?? "mcp") as "mcp" | "skill";
  const id = String(args.id ?? "");
  if (kind === "skill") return installSkill(userId, id, args);
  return installMcp(userId, id, args);
}

/** Default MCP set for every new account: docs + structured thinking. No keys needed. */
export async function seedDefaultMcps(userId: string) {
  const existing = await q1(`select 1 from mcp_servers where user_id = $1 limit 1`, [userId]);
  if (existing) return;
  for (const id of ["known:context7", "known:sequential-thinking"]) {
    try {
      await installMcp(userId, id, {});
    } catch {
      /* best effort */
    }
  }
}

async function installSkill(userId: string, id: string, args: Record<string, unknown>): Promise<string> {
  let name = String(args.name ?? "").trim();
  let body = String(args.body ?? "");
  if (id.startsWith("bundled:")) {
    const b = bundledSkills().find((s) => s.name === id.slice(8));
    if (!b) return "bundled skill missing";
    name = b.name;
    body = b.body;
  } else if (id.startsWith("ghskill:")) {
    const rest = id.slice("ghskill:".length);
    const cut = rest.indexOf(":");
    const fullName = rest.slice(0, cut);
    const filePath = rest.slice(cut + 1);
    const [owner, repo] = fullName.split("/");
    const fetched = await fetchSkillMd(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`);
    if (!fetched) return "could not fetch SKILL.md";
    body = fetched;
    name = name || skillName(fetched, path.basename(path.dirname(filePath)));
  } else if (!body && typeof args.url === "string") {
    const fetched = await fetchSkillMd(args.url);
    if (!fetched) return "skill URL must be a GitHub SKILL.md, not a script";
    body = fetched;
    name = name || skillName(fetched, "skill");
  }
  if (!name || !body) return "skill needs a name and SKILL.md body";
  const existing = await q1<{ id: string }>(`select id from skills where user_id = $1 and name = $2`, [userId, name]);
  if (existing) {
    await q(`update skills set body = $2, enabled = true where id = $1`, [existing.id, body]);
  } else {
    await q(`insert into skills (user_id, name, body, enabled) values ($1,$2,$3,true)`, [userId, name, body]);
  }
  return `Skill "${name}" is on for this user now. Follow it for the rest of this turn.\n\n${body.slice(0, 4000)}`;
}

async function installMcp(userId: string, id: string, args: Record<string, unknown>): Promise<string> {
  let name = String(args.name ?? "").trim();
  let transport = String(args.transport ?? "stdio");
  let command = typeof args.command === "string" ? args.command : "";
  let url = typeof args.url === "string" ? args.url : "";
  const known = knownById(id);
  if (known) {
    name = name || known.name;
    command = known.command;
    transport = "stdio";
  } else if (id.startsWith("npm:")) {
    const pkg = id.slice(4);
    if (!PKG.test(pkg)) return "rejected npm package name";
    name = name || pkg.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]+/gi, "-");
    command = `npx -y ${pkg}`;
    transport = "stdio";
  }
  if (name === "filesystem" || id === "known:filesystem") {
    command = `npx -y @modelcontextprotocol/server-filesystem ${workspace(userId)}`;
  }
  const env: Record<string, string> = {};
  if (args.env && typeof args.env === "object") {
    for (const [k, v] of Object.entries(args.env as Record<string, unknown>)) {
      if (typeof v === "string" && v) env[k] = v;
    }
  }
  if ((id === "known:github" || name === "github") && !env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    const conn = await githubConn(userId);
    if (conn) env.GITHUB_PERSONAL_ACCESS_TOKEN = decrypt(conn.token_enc);
  }
  if (url) {
    const https = safeHttps(url);
    if (!https) return "MCP URL must be https";
    url = https;
    transport = "sse";
    command = "";
  } else {
    const safe = safeCommand(command);
    if (!safe) {
      return "Rejected command. Install from a known manifest (npx package, mcp.json, SKILL.md). No shell pipes or remote scripts.";
    }
    command = safe;
    url = "";
    transport = "stdio";
  }
  if (!name) name = "mcp";
  name = name.replace(/[^\w.-]+/g, "-").slice(0, 40);
  const existing = await q1<{ id: string }>(
    `select id from mcp_servers where user_id = $1 and name = $2`,
    [userId, name],
  );
  const envEnc = Object.keys(env).length ? encrypt(JSON.stringify(env)) : null;
  if (existing) {
    dropMcp(existing.id);
    await q(
      `update mcp_servers set transport=$2, command=$3, url=$4, env_enc=$5, enabled=true where id=$1`,
      [existing.id, transport, command || null, url || null, envEnc],
    );
  } else {
    await q(
      `insert into mcp_servers (user_id, name, transport, command, url, env_enc, enabled)
       values ($1,$2,$3,$4,$5,$6,true)`,
      [userId, name, transport, command || null, url || null, envEnc],
    );
  }
  const hint = Object.keys(env).length ? " (env stored encrypted)" : "";
  return `MCP "${name}" is enabled${hint}. Its tools are available on the next step. command=${command || "-"} url=${url || "-"}`;
}

export function catalogTools() {
  return [
    {
      name: "catalog_search",
      description:
        "Search known MCP registries, npm, GitHub manifests (mcp.json, SKILL.md), and bundled skills. Use this when the user asks to install or add an MCP server or skill. No URL required from the user.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["mcp", "skill", "any"] },
        },
        required: ["query"],
      },
    },
    {
      name: "catalog_install",
      description:
        "Install an MCP server or skill from a catalog id (or a validated npx command / GitHub SKILL.md). Writes need approval. Do not run remote install scripts.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["mcp", "skill"] },
          id: { type: "string" },
          name: { type: "string" },
          command: { type: "string" },
          url: { type: "string" },
          transport: { type: "string" },
          env: { type: "object" },
          body: { type: "string" },
        },
        required: ["kind"],
      },
    },
  ];
}
