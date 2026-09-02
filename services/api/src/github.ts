import { decrypt } from "./crypto.js";
import { q1 } from "./db.js";

const UA = { "User-Agent": "janus", Accept: "application/vnd.github+json" };

export type GhConn = { login: string; token_enc: string; scopes: string };

export async function githubConn(userId: string): Promise<GhConn | undefined> {
  return q1<GhConn>(`select login, token_enc, scopes from github_connections where user_id = $1`, [userId]);
}

async function gh(userId: string, path: string, init: RequestInit = {}) {
  const conn = await githubConn(userId);
  if (!conn) throw new Error("GitHub is not connected. Connect it under Channels.");
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...UA,
      Authorization: `Bearer ${decrypt(conn.token_enc)}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : {};
}

export async function runGithub(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "github_repos") {
    const rows = (await gh(userId, "/user/repos?per_page=50&sort=updated")) as { full_name: string; private: boolean; html_url: string }[];
    return rows.map((r) => `${r.full_name}${r.private ? " private" : ""}\n${r.html_url}`).join("\n\n") || "(none)";
  }
  const owner = String(args.owner ?? "");
  const repo = String(args.repo ?? "");
  if (name === "github_tree") {
    const ref = String(args.ref ?? "HEAD");
    const tree = (await gh(userId, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)) as {
      tree?: { path: string; type: string }[];
    };
    return (tree.tree ?? [])
      .filter((t) => t.type === "blob")
      .slice(0, 400)
      .map((t) => t.path)
      .join("\n");
  }
  if (name === "github_file") {
    const p = String(args.path ?? "");
    const file = (await gh(userId, `/repos/${owner}/${repo}/contents/${p}`)) as { content?: string; encoding?: string; html_url?: string };
    if (file.encoding === "base64" && file.content) {
      return `${file.html_url ?? ""}\n\n${Buffer.from(file.content, "base64").toString("utf8").slice(0, 40_000)}`;
    }
    return JSON.stringify(file).slice(0, 4000);
  }
  if (name === "github_search") {
    const q = encodeURIComponent(String(args.query ?? ""));
    const data = (await gh(userId, `/search/code?q=${q}`)) as { items?: { repository: { full_name: string }; path: string; html_url: string }[] };
    return (data.items ?? [])
      .slice(0, 20)
      .map((i) => `${i.repository.full_name}:${i.path}\n${i.html_url}`)
      .join("\n\n") || "(no hits)";
  }
  if (name === "github_issue") {
    if (args.title) {
      const created = await gh(userId, `/repos/${owner}/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: args.title, body: args.body ?? "" }),
      });
      return JSON.stringify(created).slice(0, 4000);
    }
    const n = args.number ? `/${args.number}` : "?state=open&per_page=20";
    return JSON.stringify(await gh(userId, `/repos/${owner}/${repo}/issues${n}`)).slice(0, 8000);
  }
  if (name === "github_pr") {
    if (args.title && args.head && args.base) {
      const created = await gh(userId, `/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body ?? "",
        }),
      });
      return JSON.stringify(created).slice(0, 4000);
    }
    const n = args.number ? `/${args.number}` : "?state=open&per_page=20";
    return JSON.stringify(await gh(userId, `/repos/${owner}/${repo}/pulls${n}`)).slice(0, 8000);
  }
  if (name === "github_commit") {
    const p = String(args.path ?? "");
    const message = String(args.message ?? "update");
    const content = Buffer.from(String(args.content ?? ""), "utf8").toString("base64");
    let sha: string | undefined;
    try {
      const existing = (await gh(userId, `/repos/${owner}/${repo}/contents/${p}`)) as { sha?: string };
      sha = existing.sha;
    } catch {
      sha = undefined;
    }
    const body: Record<string, unknown> = {
      message,
      content,
      branch: args.branch || undefined,
    };
    if (sha) body.sha = sha;
    const out = await gh(userId, `/repos/${owner}/${repo}/contents/${p}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return JSON.stringify(out).slice(0, 4000);
  }
  return `unknown github tool ${name}`;
}

export function githubTools() {
  return [
    {
      name: "github_repos",
      description: "List repositories the connected GitHub account can see.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "github_tree",
      description: "List file paths in a repository ref.",
      parameters: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" }, ref: { type: "string" } },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_file",
      description: "Read a file from a repository.",
      parameters: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } },
        required: ["owner", "repo", "path"],
      },
    },
    {
      name: "github_search",
      description: "Search code the GitHub account can see.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "github_issue",
      description: "Read or open a GitHub issue. Opening needs approval.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "number" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_pr",
      description: "Read or open a pull request. Opening needs approval.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "number" },
          title: { type: "string" },
          head: { type: "string" },
          base: { type: "string" },
          body: { type: "string" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_commit",
      description: "Create or update a file via the GitHub Contents API. Needs approval.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
          message: { type: "string" },
          branch: { type: "string" },
        },
        required: ["owner", "repo", "path", "content", "message"],
      },
    },
  ];
}
