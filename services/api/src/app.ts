import fs from "node:fs";
import path from "node:path";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import { parseMode, runAgent } from "./agent.js";
import { clearSession, createSession, currentUser, hashPassword, requireUser, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { encrypt } from "./crypto.js";
import { q, q1 } from "./db.js";
import { githubConn } from "./github.js";
import { dropMcp } from "./mcp.js";
import * as box from "./sandbox.js";
import { seedDefaultSkills } from "./skills.js";
import {
  createTelegramLink,
  handleTelegramUpdate,
  telegramBotName,
  telegramSecretOk,
} from "./telegram.js";

export async function buildApp() {
  const app = fastify({ logger: false, bodyLimit: 8_000_000 });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);

  const web = path.resolve(config.webDir);
  if (fs.existsSync(web)) {
    await app.register(staticFiles, { root: web, wildcard: false });
  }

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/me", async (req, reply) => {
    const u = await currentUser(req);
    if (!u) return reply.code(401).send({ error: "auth" });
    return u;
  });

  app.post("/api/auth/register", async (req, reply) => {
    const { email, password, name } = req.body as { email?: string; password?: string; name?: string };
    if (!email || !password || password.length < 8) return reply.code(400).send({ error: "invalid" });
    const exists = await q1(`select 1 from users where email = $1`, [email.toLowerCase()]);
    if (exists) return reply.code(409).send({ error: "exists" });
    const user = await q1<{ id: string }>(
      `insert into users (email, password_hash, name) values ($1, $2, $3) returning id`,
      [email.toLowerCase(), await hashPassword(password), name ?? ""],
    );
    await q(`insert into bots (user_id, name, title, description) values ($1, 'Scout', 'first agent', $2)`, [
      user!.id,
      "Own open tasks. Ask before sending or deleting. Keep durable notes in /workspace.",
    ]);
    await seedDefaultSkills(user!.id);
    await createSession(reply, user!.id);
    return { ok: true };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    const user = await q1<{ id: string; password_hash: string }>(
      `select id, password_hash from users where email = $1`,
      [email?.toLowerCase()],
    );
    if (!user?.password_hash || !(await verifyPassword(user.password_hash, password ?? ""))) {
      return reply.code(401).send({ error: "auth" });
    }
    await createSession(reply, user.id);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await clearSession(req, reply);
    return { ok: true };
  });

  app.get("/api/auth/github", async (_req, reply) => {
    if (!config.githubId) return reply.code(501).send({ error: "github unset" });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.githubId);
    url.searchParams.set("redirect_uri", `${config.publicUrl}/api/auth/github/callback`);
    url.searchParams.set("scope", "user:email");
    return reply.redirect(url.toString());
  });

  app.get("/api/auth/github/callback", async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    if (!code) return reply.redirect("/login");
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.githubId,
        client_secret: config.githubSecret,
        code,
        redirect_uri: `${config.publicUrl}/api/auth/github/callback`,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    const gh = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, "User-Agent": "janus" },
    });
    const profile = (await gh.json()) as { id: number; login: string; email?: string };
    const emails = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, "User-Agent": "janus" },
    });
    const emailList = (await emails.json()) as { email: string; primary: boolean; verified: boolean }[];
    const email =
      profile.email ||
      emailList.find((e) => e.primary && e.verified)?.email ||
      emailList.find((e) => e.verified)?.email;
    if (!email) return reply.redirect("/login?err=email");
    const userId = await upsertOauth("github", String(profile.id), email, profile.login);
    await createSession(reply, userId);
    return reply.redirect("/");
  });

  app.get("/api/auth/google", async (_req, reply) => {
    if (!config.googleId) return reply.code(501).send({ error: "google unset" });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", config.googleId);
    url.searchParams.set("redirect_uri", `${config.publicUrl}/api/auth/google/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    return reply.redirect(url.toString());
  });

  app.get("/api/auth/google/callback", async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    if (!code) return reply.redirect("/login");
    const body = new URLSearchParams({
      code,
      client_id: config.googleId,
      client_secret: config.googleSecret,
      redirect_uri: `${config.publicUrl}/api/auth/google/callback`,
      grant_type: "authorization_code",
    });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    const me = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const profile = (await me.json()) as { id: string; email: string; name: string };
    if (!profile.email) return reply.redirect("/login?err=email");
    const userId = await upsertOauth("google", profile.id, profile.email, profile.name);
    await createSession(reply, userId);
    return reply.redirect("/");
  });

  app.get("/api/bots", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    return q(
      `select b.*, (select content from messages m
         join conversations c on c.id = m.conversation_id
         where c.bot_id = b.id order by m.created_at desc limit 1) as last_message
       from bots b where b.user_id = $1 and b.hidden = false
       order by b.pinned desc, b.created_at`,
      [u.id],
    );
  });

  app.post("/api/bots", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { name, title, description } = req.body as { name: string; title?: string; description?: string };
    const row = await q1(
      `insert into bots (user_id, name, title, description) values ($1,$2,$3,$4) returning *`,
      [u.id, name, title ?? "", description ?? ""],
    );
    return row;
  });

  app.patch("/api/bots/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    const body = req.body as Record<string, unknown>;
    const row = await q1(
      `update bots set
        name = coalesce($3, name),
        title = coalesce($4, title),
        description = coalesce($5, description),
        pinned = coalesce($6, pinned),
        hidden = coalesce($7, hidden),
        mode = coalesce($8, mode)
       where id = $1 and user_id = $2 returning *`,
      [
        id,
        u.id,
        body.name ?? null,
        body.title ?? null,
        body.description ?? null,
        body.pinned ?? null,
        body.hidden ?? null,
        typeof body.mode === "string" ? parseMode(body.mode) : null,
      ],
    );
    return row;
  });

  app.get("/api/bots/:id/messages", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    const conv = await ensureConv(u.id, id);
    return q(`select * from messages where conversation_id = $1 order by created_at asc`, [conv]);
  });

  app.post("/api/bots/:id/messages", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    const body = req.body as { text: string; mode?: string };
    const text = body.text;
    if (body.mode) {
      await q(`update bots set mode = $3 where id = $1 and user_id = $2`, [id, u.id, parseMode(body.mode)]);
    }
    const bot = await q1<{ mode: string }>(`select mode from bots where id = $1 and user_id = $2`, [id, u.id]);
    const conv = await ensureConv(u.id, id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (e: object) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    try {
      await runAgent({
        userId: u.id,
        botId: id,
        conversationId: conv,
        text,
        surface: "web",
        mode: parseMode(bot?.mode),
        emit: (ev) => send(ev),
      });
    } catch (e) {
      send({ type: "text", text: String(e) });
      send({ type: "done" });
    }
    reply.raw.end();
  });

  app.get("/api/models", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    return q(
      `select id, kind, name, base_url, default_model, enabled, (api_key_enc is not null) as has_key
       from model_providers where user_id = $1 order by created_at`,
      [u.id],
    );
  });

  app.post("/api/models", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const b = req.body as {
      kind: string;
      name: string;
      base_url?: string;
      api_key?: string;
      default_model: string;
    };
    const row = await q1(
      `insert into model_providers (user_id, kind, name, base_url, api_key_enc, default_model)
       values ($1,$2,$3,$4,$5,$6) returning id, kind, name, base_url, default_model, enabled`,
      [u.id, b.kind, b.name, b.base_url ?? null, b.api_key ? encrypt(b.api_key) : null, b.default_model],
    );
    return row;
  });

  app.delete("/api/models/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    await q(`delete from model_providers where id = $1 and user_id = $2`, [(req.params as { id: string }).id, u.id]);
    return { ok: true };
  });

  app.get("/api/skills", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    return q(`select * from skills where user_id = $1`, [u.id]);
  });

  app.post("/api/skills", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { name, body } = req.body as { name: string; body: string };
    return q1(`insert into skills (user_id, name, body) values ($1,$2,$3) returning *`, [u.id, name, body]);
  });

  app.delete("/api/skills/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    await q(`delete from skills where id = $1 and user_id = $2`, [(req.params as { id: string }).id, u.id]);
    return { ok: true };
  });

  app.get("/api/mcp", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    return q(`select id, name, transport, command, url, enabled from mcp_servers where user_id = $1`, [u.id]);
  });

  app.post("/api/mcp", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const b = req.body as { name: string; transport: string; command?: string; url?: string; env?: Record<string, string> };
    return q1(
      `insert into mcp_servers (user_id, name, transport, command, url, env_enc)
       values ($1,$2,$3,$4,$5,$6) returning id, name, transport, command, url, enabled`,
      [u.id, b.name, b.transport, b.command ?? null, b.url ?? null, b.env ? encrypt(JSON.stringify(b.env)) : null],
    );
  });

  app.delete("/api/mcp/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    dropMcp(id);
    await q(`delete from mcp_servers where id = $1 and user_id = $2`, [id, u.id]);
    return { ok: true };
  });

  app.patch("/api/mcp/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as { id: string }).id;
    const { enabled } = req.body as { enabled?: boolean };
    if (enabled === false) dropMcp(id);
    return q1(
      `update mcp_servers set enabled = coalesce($3, enabled) where id = $1 and user_id = $2
       returning id, name, transport, command, url, enabled`,
      [id, u.id, enabled ?? null],
    );
  });

  app.patch("/api/skills/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { enabled } = req.body as { enabled?: boolean };
    return q1(
      `update skills set enabled = coalesce($3, enabled) where id = $1 and user_id = $2 returning *`,
      [(req.params as { id: string }).id, u.id, enabled ?? null],
    );
  });

  app.get("/api/approvals", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    return q(`select * from approvals where user_id = $1 order by created_at desc limit 50`, [u.id]);
  });

  app.post("/api/approvals/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { status } = req.body as { status: "allowed" | "denied" };
    await q(`update approvals set status = $3 where id = $1 and user_id = $2`, [
      (req.params as { id: string }).id,
      u.id,
      status,
    ]);
    return { ok: true };
  });

  app.get("/api/routines", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    return q(
      `select r.* from routines r join bots b on b.id = r.bot_id where b.user_id = $1`,
      [u.id],
    );
  });

  app.post("/api/routines", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const b = req.body as { bot_id: string; name: string; cron_expr: string; timezone?: string; instructions: string };
    const bot = await q1(`select id from bots where id = $1 and user_id = $2`, [b.bot_id, u.id]);
    if (!bot) return reply.code(404).send({ error: "bot" });
    return q1(
      `insert into routines (bot_id, name, cron_expr, timezone, instructions) values ($1,$2,$3,$4,$5) returning *`,
      [b.bot_id, b.name, b.cron_expr, b.timezone ?? "UTC", b.instructions],
    );
  });

  app.post("/api/routines/:id/toggle", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    return q1(
      `update routines r set enabled = not enabled
       from bots b where r.id = $1 and r.bot_id = b.id and b.user_id = $2
       returning r.*`,
      [(req.params as { id: string }).id, u.id],
    );
  });

  app.get("/api/computer", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const row = await q1(`select * from computers where user_id = $1`, [u.id]);
    return row ?? { status: "idle", takeover: false };
  });

  app.get("/api/computer/screen.png", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    try {
      const buf = await box.snapshot(u.id);
      return reply.type("image/png").send(buf);
    } catch {
      return reply.code(503).send({ error: "computer" });
    }
  });

  app.post("/api/computer/input", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const row = await q1<{ status: string; takeover: boolean }>(
      `select status, takeover from computers where user_id = $1`,
      [u.id],
    );
    if (row && !row.takeover && String(row.status).startsWith("agent")) {
      return reply.code(423).send({ error: "agent driving" });
    }
    const b = req.body as { type: string; x?: number; y?: number; text?: string; key?: string; url?: string };
    if (b.type === "click") await box.clickAt(u.id, b.x ?? 0, b.y ?? 0);
    if (b.type === "type") await box.typeText(u.id, b.text ?? "");
    if (b.type === "key") await box.keyPress(u.id, b.key ?? "Enter");
    if (b.type === "open") await box.browse(u.id, b.url ?? "about:blank");
    if (b.type === "scroll") await box.scroll(u.id, b.y ?? 400);
    return { ok: true };
  });

  app.post("/api/computer/takeover", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { on } = req.body as { on: boolean };
    await box.setDriver(u.id, on ? "user" : "idle");
    return { ok: true };
  });

  app.get("/api/computer/live", { websocket: true }, (socket, req) => {
    currentUser(req).then(async (u) => {
      if (!u) {
        socket.close();
        return;
      }
      const tick = async () => {
        try {
          const buf = await box.snapshot(u.id);
          if (socket.readyState === 1) socket.send(buf);
        } catch {
          /* idle */
        }
      };
      const t = setInterval(tick, 1200);
      socket.on("close", () => clearInterval(t));
      socket.on("message", (raw) => {
        try {
          const b = JSON.parse(String(raw)) as { type: string; x?: number; y?: number; text?: string };
          if (b.type === "click") box.clickAt(u.id, b.x ?? 0, b.y ?? 0).catch(() => {});
          if (b.type === "type") box.typeText(u.id, b.text ?? "").catch(() => {});
        } catch {
          /* ignore */
        }
      });
    });
  });

  app.get("/api/channels", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const gh = await githubConn(u.id);
    const tg = await q1<{ username: string | null }>(
      `select username from telegram_accounts where user_id = $1 limit 1`,
      [u.id],
    );
    let bot = "";
    try {
      bot = await telegramBotName();
    } catch {
      bot = "";
    }
    return {
      github: gh ? { login: gh.login, scopes: gh.scopes } : null,
      telegram: tg ? { username: tg.username } : null,
      telegramBot: bot || null,
    };
  });

  app.get("/api/channels/github", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    if (!config.githubId) return reply.code(501).send({ error: "github unset" });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.githubId);
    url.searchParams.set("redirect_uri", `${config.publicUrl}/api/channels/github/callback`);
    url.searchParams.set("scope", "repo read:org");
    url.searchParams.set("state", u.id);
    return reply.redirect(url.toString());
  });

  app.get("/api/channels/github/callback", async (req, reply) => {
    const u = await currentUser(req);
    if (!u) return reply.redirect("/login");
    const { code } = req.query as { code?: string };
    if (!code) return reply.redirect("/settings");
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.githubId,
        client_secret: config.githubSecret,
        code,
        redirect_uri: `${config.publicUrl}/api/channels/github/callback`,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; scope?: string };
    if (!tokenJson.access_token) return reply.redirect("/settings?err=github");
    const gh = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, "User-Agent": "janus" },
    });
    const profile = (await gh.json()) as { login?: string };
    await q(
      `insert into github_connections (user_id, login, token_enc, scopes)
       values ($1,$2,$3,$4)
       on conflict (user_id) do update set login = excluded.login, token_enc = excluded.token_enc, scopes = excluded.scopes`,
      [u.id, profile.login ?? "", encrypt(tokenJson.access_token), tokenJson.scope ?? "repo,read:org"],
    );
    return reply.redirect("/settings");
  });

  app.delete("/api/channels/github", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    await q(`delete from github_connections where user_id = $1`, [u.id]);
    return { ok: true };
  });

  app.post("/api/channels/telegram/link", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    try {
      return await createTelegramLink(u.id);
    } catch (e) {
      return reply.code(501).send({ error: String(e) });
    }
  });

  app.delete("/api/channels/telegram", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    await q(`delete from telegram_accounts where user_id = $1`, [u.id]);
    await q(`delete from telegram_chats where owner_user_id = $1`, [u.id]);
    return { ok: true };
  });

  app.post("/api/telegram/webhook", async (req, reply) => {
    if (!telegramSecretOk(req.headers["x-telegram-bot-api-secret-token"] as string | undefined)) {
      return reply.code(401).send({ error: "telegram" });
    }
    void handleTelegramUpdate(req.body).catch(() => {});
    return { ok: true };
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "missing" });
    const index = path.join(web, "index.html");
    if (fs.existsSync(index)) return reply.type("text/html").send(fs.readFileSync(index));
    return reply.code(404).send("missing");
  });

  return app;
}

async function upsertOauth(provider: string, subject: string, email: string, name: string) {
  const existing = await q1<{ user_id: string }>(
    `select user_id from oauth_accounts where provider = $1 and subject = $2`,
    [provider, subject],
  );
  if (existing) return existing.user_id;
  let user = await q1<{ id: string }>(`select id from users where email = $1`, [email.toLowerCase()]);
  if (!user) {
    user = await q1<{ id: string }>(
      `insert into users (email, name) values ($1, $2) returning id`,
      [email.toLowerCase(), name],
    );
    await q(`insert into bots (user_id, name, title, description) values ($1, 'Scout', 'first agent', $2)`, [
      user!.id,
      "Own open tasks. Ask before sending or deleting.",
    ]);
    await seedDefaultSkills(user!.id);
  }
  await q(`insert into oauth_accounts (user_id, provider, subject, email) values ($1,$2,$3,$4)`, [
    user!.id,
    provider,
    subject,
    email,
  ]);
  return user!.id;
}

async function ensureConv(userId: string, botId: string) {
  const row = await q1<{ id: string }>(
    `insert into conversations (user_id, bot_id) values ($1,$2)
     on conflict (user_id, bot_id) do update set bot_id = excluded.bot_id
     returning id`,
    [userId, botId],
  );
  return row!.id;
}
