import { createHash, randomBytes } from "node:crypto";
import { parseMode, runAgent, type AgentEvent, type AgentMode } from "./agent.js";
import { config } from "./config.js";
import { q, q1 } from "./db.js";
import * as box from "./sandbox.js";

type TgUser = { id: number; username?: string; is_bot?: boolean };
type TgChat = { id: number; type: string; title?: string };
type TgMessage = {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number }[];
  entities?: { type: string; offset: number; length: number }[];
  caption_entities?: { type: string }[];
  reply_to_message?: { from?: TgUser; text?: string };
};
type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { chat: TgChat };
  };
  inline_query?: { id: string; from: TgUser; query: string; offset: string };
  chosen_inline_result?: { result_id: string; from: TgUser; query: string };
};

const seen = new Set<number>();
let botUsername = "";
const pendingEmail = new Map<number, number>(); // telegramUserId -> timestamp

function token() {
  return config.telegramToken;
}

function secret() {
  if (config.telegramWebhookSecret) return config.telegramWebhookSecret;
  if (!token()) return "";
  return createHash("sha256").update(`janus-tg-${token()}`).digest("hex").slice(0, 32);
}

async function tg(method: string, body: Record<string, unknown> = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await r.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(json.description ?? method);
  return json.result;
}

export async function telegramBotName() {
  if (!token()) return "";
  if (botUsername) return botUsername;
  const me = (await tg("getMe")) as { username?: string };
  botUsername = me.username ?? "";
  return botUsername;
}

export async function registerTelegramWebhook() {
  if (!token()) return;
  let url = `${config.publicUrl}/api/telegram/webhook`;
  if (!url.startsWith("https://")) { url = url.replace(/^http:\/\//, "https://"); }
  try {
    await tg("setWebhook", {
      url,
      secret_token: secret(),
      allowed_updates: ["message", "callback_query", "inline_query", "chosen_inline_result"],
    });
  } catch (e) {
    console.error("webhook", e, "fallback to polling");
    startPolling();
    return;
  }
  try {
    const info = (await tg("getWebhookInfo")) as { last_error_message?: string };
    if (info.last_error_message?.includes("SSL") || info.last_error_message?.includes("certificate")) {
      console.error("SSL webhook, fallback to polling", info);
      await tg("deleteWebhook").catch(() => {});
      startPolling();
      return;
    }
  } catch {}
  await tg("setMyCommands", {
    commands: [
      { command: "ask", description: "Ask — answer with tools" },
      { command: "plan", description: "Plan — short numbered plan" },
      { command: "build", description: "Build — execute with tools" },
    ],
  }).catch(() => {});
  await tg("setMyCommands", {
    commands: [
      { command: "ask", description: "Ask in any chat via inline" },
      { command: "plan", description: "Plan via inline" },
      { command: "build", description: "Build via inline" },
    ],
    scope: { type: "all_private_chats" },
  }).catch(() => {});
  await telegramBotName();
}

let polling = false;
export function startPolling() {
  if (polling || !token()) return;
  polling = true;
  let offset = 0;
  const loop = async () => {
    try {
      const res = (await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query", "inline_query", "chosen_inline_result"] })) as { result?: TgUpdate[] };
      const arr = Array.isArray((res as unknown as { result?: TgUpdate[] })?.result) ? (res as unknown as { result: TgUpdate[] }).result : Array.isArray(res) ? (res as unknown as TgUpdate[]) : [];
      for (const u of arr) {
        offset = (u.update_id ?? 0) + 1;
        await handleTelegramUpdate(u);
      }
    } catch (e) {
      console.error("polling", e);
    }
    setTimeout(loop, 1000);
  };
  loop();
}

export function telegramSecretOk(header: string | undefined) {
  if (!token()) return false;
  return header === secret();
}

export async function createTelegramLink(userId: string) {
  const name = await telegramBotName();
  if (!name) throw new Error("Telegram bot token is unset.");
  const code = `j_${randomBytes(8).toString("hex")}`;
  await q(`delete from telegram_link_codes where user_id = $1 or expires_at < now()`, [userId]);
  await q(`insert into telegram_link_codes (code, user_id, expires_at) values ($1, $2, now() + interval '20 minutes')`, [
    code,
    userId,
  ]);
  return { url: `https://t.me/${name}?start=${code}`, code };
}

async function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  const chunk = text.slice(0, 4000) || "(empty)";
  await tg("sendMessage", { chat_id: chatId, text: chunk, ...extra });
}

async function sendPhoto(chatId: number, photo: Buffer, caption?: string, extra: Record<string, unknown> = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([new Uint8Array(photo)], { type: "image/png" }), "photo.png");
  if (caption) form.append("caption", caption);
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  const r = await fetch(`https://api.telegram.org/bot${token()}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const json = await r.json() as { ok: boolean; result?: { message_id: number } };
  return json.result?.message_id;
}

async function sendDocument(chatId: number, doc: Buffer, filename: string, caption?: string) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([new Uint8Array(doc)]), filename);
  if (caption) form.append("caption", caption);
  const r = await fetch(`https://api.telegram.org/bot${token()}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const json = await r.json() as { ok: boolean; result?: { message_id: number } };
  return json.result?.message_id;
}

async function deleteMessage(chatId: number, messageId: number) {
  await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
}

async function editMessage(chatId: number, messageId: number, text: string, extra: Record<string, unknown> = {}) {
  await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), ...extra }).catch(() => {});
}

async function ephemeral(chatId: number, userId: number, text: string) {
  await tg("sendMessage", { chat_id: userId, text, disable_notification: true }).catch(() => {});
  const t = await tg("sendMessage", { chat_id: chatId, text: "вњ“ Set (private)", disable_notification: true }) as { message_id?: number } | undefined;
  if (t?.message_id) setTimeout(() => { void deleteMessage(chatId, t.message_id!); }, 1500);
}

async function answerCallback(id: string, text: string) {
  await tg("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});
}

function addressed(msg: TgMessage, name: string) {
  if (msg.chat.type === "private") return true;
  const text = msg.text ?? msg.caption ?? "";
  if (name && text.toLowerCase().includes(`@${name.toLowerCase()}`)) return true;
  if (msg.reply_to_message?.from?.is_bot) return true;
  return false;
}

async function ownerFor(msg: TgMessage): Promise<string | undefined> {
  const chat = await q1<{ owner_user_id: string }>(
    `select owner_user_id from telegram_chats where chat_id = $1`,
    [msg.chat.id],
  );
  if (chat) return chat.owner_user_id;
  if (!msg.from) return;
  const acc = await q1<{ user_id: string }>(
    `select user_id from telegram_accounts where telegram_user_id = $1`,
    [msg.from.id],
  );
  if (!acc) return;
  const kind = msg.chat.type === "private" ? "dm" : "group";
  await q(
    `insert into telegram_chats (chat_id, owner_user_id, kind) values ($1,$2,$3)
     on conflict (chat_id) do update set owner_user_id = excluded.owner_user_id`,
    [msg.chat.id, acc.user_id, kind],
  );
  return acc.user_id;
}

async function defaultBot(userId: string) {
  return q1<{ id: string; mode: string }>(
    `select id, mode from bots where user_id = $1 and hidden = false order by pinned desc, created_at asc limit 1`,
    [userId],
  );
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

async function savePhoto(userId: string, fileId: string) {
  const file = (await tg("getFile", { file_id: fileId })) as { file_path?: string };
  if (!file.file_path) return "";
  const r = await fetch(`https://api.telegram.org/file/bot${token()}/${file.file_path}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = file.file_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const rel = `inbox/${Date.now()}.${ext}`;
  box.writeBytes(userId, rel, buf);
  return rel;
}

async function handleStart(msg: TgMessage) {
  const text = msg.text ?? "";
  const code = text.split(/\s+/)[1];
  if (!code || !msg.from) {
    const fromId = msg.from!.id;
    const acc = await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [fromId]);
    if (acc) {
      await send(msg.chat.id, "Already linked. Send a job or /help.");
      return;
    }
    pendingEmail.set(fromId, Date.now());
    await send(msg.chat.id, "Send your Janus email to link. Or generate a link via web if you have it.");
    return;
  }
  const row = await q1<{ user_id: string }>(
    `select user_id from telegram_link_codes where code = $1 and expires_at > now()`,
    [code],
  );
  if (!row) {
    await send(msg.chat.id, "That link expired. Make a new one under Settings, Channels.");
    return;
  }
  await q(
    `insert into telegram_accounts (telegram_user_id, user_id, username) values ($1,$2,$3)
     on conflict (telegram_user_id) do update set user_id = excluded.user_id, username = excluded.username`,
    [msg.from.id, row.user_id, msg.from.username ?? ""],
  );
  await q(
    `insert into telegram_chats (chat_id, owner_user_id, kind) values ($1,$2,'dm')
     on conflict (chat_id) do update set owner_user_id = excluded.owner_user_id`,
    [msg.chat.id, row.user_id],
  );
  await q(`delete from telegram_link_codes where code = $1`, [code]);
  await send(msg.chat.id, `Linked. You are ${msg.from.username || "you"}. Send a job or mention me in a group.`);
}

async function handleCallback(upd: NonNullable<TgUpdate["callback_query"]>) {
  const data = upd.data ?? "";
  const m = data.match(/^a:([0-9a-f-]{36}):([yn])$/i);
  if (!m) {
    await answerCallback(upd.id, "unknown");
    return;
  }
  const acc = await q1<{ user_id: string }>(
    `select user_id from telegram_accounts where telegram_user_id = $1`,
    [upd.from.id],
  );
  if (!acc) {
    await answerCallback(upd.id, "not linked");
    return;
  }
  const status = m[2] === "y" ? "allowed" : "denied";
  await q(`update approvals set status = $3 where id = $1 and user_id = $2`, [m[1], acc.user_id, status]);
  await answerCallback(upd.id, status === "allowed" ? "allowed once" : "denied");
  if (upd.message?.chat.id) {
    await send(upd.message.chat.id, status === "allowed" ? "Allowed once." : "Denied.");
  }
}

async function handleCommand(msg: TgMessage, cmd: string, args: string) {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const userId = fromId ? await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [fromId]) : null;
  
  await deleteMessage(chatId, msg.message_id);
  const thinking = await tg("sendMessage", { chat_id: chatId, text: "Р”СѓРјР°СЋ..." }) as { message_id?: number } | undefined;
  const thinkingId = thinking?.message_id;
  
  try {
    if (!userId) {
      if (thinkingId) await deleteMessage(chatId, thinkingId);
      await send(chatId, "Link Telegram: Settings > Channels > Link, or use @JanusWorkBot inline.");
      return;
    }
    
    const bot = await defaultBot(userId.user_id);
    if (!bot) {
      if (thinkingId) await deleteMessage(chatId, thinkingId);
      await send(chatId, "No agent on this account.");
      return;
    }

    if (cmd === "/help") {
      if (thinkingId) await deleteMessage(chatId, thinkingId);
      await send(chatId, "Janus вЂ” your cloud computer. Send a job, attach a photo or file. I answer, run code, or make files.");
      return;
    }
    if (cmd === "/model") {
      if (!args) {
        if (thinkingId) await deleteMessage(chatId, thinkingId);
        await send(chatId, "Use /model <name>.");
        return;
      }
      if (thinkingId) await deleteMessage(chatId, thinkingId);
      await ephemeral(chatId, fromId!, `Model set to ${args}.`);
      return;
    }
    if (["/ask", "/plan", "/build"].includes(cmd)) {
      const mode = cmd.slice(1) as AgentMode;
      const conv = await ensureConv(userId.user_id, bot.id);
      let output = "";
      let phase: "think" | "search" | "found" | "extract" = "think";
      let sources = 0;
      let done = false;
      const statusText = () => {
        if (phase === "think") return "Р”СѓРјР°СЋ...";
        if (phase === "search") return "РС‰Сѓ РёСЃС‚РѕС‡РЅРёРєРё...";
        if (phase === "found") return `РќР°Р№РґРµРЅРѕ ${sources} РёСЃС‚РѕС‡РЅРёРєРѕРІ...`;
        return "РР·РІР»РµРєР°СЋ РёРЅС„РѕСЂРјР°С†РёСЋ...";
      };
      let lastText = "";
      const update = async () => {
        if (done || !thinkingId) return;
        const body = statusText();
        if (body !== lastText) {
          await editMessage(chatId, thinkingId, body);
          lastText = body;
        }
      };
      const timer = setInterval(update, 900);
      try {
        await runAgent({
          userId: userId.user_id,
          botId: bot.id,
          conversationId: conv,
          text: args || "help",
          surface: "telegram",
          mode,
          emit: (e: AgentEvent) => {
            if (e.type === "tool" && e.name === "search_web") {
              if (e.status === "running") phase = "search";
              if (e.status === "ok") { sources++; phase = "found"; }
            }
            if (e.type === "tool" && e.status === "ok" && ["read_page", "wiki", "workspace_read"].includes(e.name ?? "")) {
              phase = "extract";
            }
            if (e.type === "text" && e.text) output += e.text;
          },
        });
      } finally {
        done = true;
        clearInterval(timer);
      }
      if (thinkingId) await editMessage(chatId, thinkingId, output.slice(0, 4000) || "(done)");
      return;
    }
    // Contextual: no command means treat as ask
    if (thinkingId) await deleteMessage(chatId, thinkingId);
    const conv = await ensureConv(userId.user_id, bot.id);
    let output = "";
    await runAgent({
      userId: userId.user_id,
      botId: bot.id,
      conversationId: conv,
      text: cmd + " " + args,
      surface: "telegram",
      mode: "ask",
      emit: (e: AgentEvent) => {
        if (e.type === "text" && e.text) output += e.text;
      },
    });
    if (thinkingId) await editMessage(chatId, thinkingId, output.slice(0, 4000) || "(done)");
  } catch (e) {
    if (thinkingId) await editMessage(chatId, thinkingId, `Error: ${String(e)}`);
  }
}

async function handleMessage(msg: TgMessage) {
  console.log("handleMessage", msg.chat.type, msg.text?.slice(0,80), "from", msg.from?.id);
  const text = (msg.text ?? "").trim();
  
  if (text.startsWith("/start")) {
    await handleStart(msg);
    return;
  }

  if (msg.from && pendingEmail.has(msg.from.id) && text.includes("@") && text.includes(".")) {
    const email = text.trim().toLowerCase().split(/\s+/)[0];
    const existing = await q1<{ id: string }>(`select id from users where lower(email)=$1`, [email]);
    let userId = existing?.id;
    if (!userId) {
      const created = await q1<{ id: string }>(`insert into users (email,name) values ($1,$2) returning id`, [email, email.split("@")[0]]);
      userId = created!.id;
      const botName = email.split("@")[0] + "-agent";
      await q(`insert into bots (user_id,name,mode) values ($1,$2,'ask') on conflict do nothing`, [userId, botName]);
    }
    await q(`insert into telegram_accounts (telegram_user_id,user_id,username) values ($1,$2,$3) on conflict (telegram_user_id) do update set user_id=excluded.user_id`, [msg.from.id, userId, msg.from.username ?? ""]);
    await q(`insert into telegram_chats (chat_id,owner_user_id,kind) values ($1,$2,'dm') on conflict (chat_id) do update set owner_user_id=excluded.owner_user_id`, [msg.chat.id, userId]);
    pendingEmail.delete(msg.from.id);
    await send(msg.chat.id, `Linked as ${email}. Send a job — /ask, /plan or /build.`);
    return;
  } else if (msg.from && pendingEmail.has(msg.from.id) && text) {
    if (text.toLowerCase() === "/cancel") { pendingEmail.delete(msg.from.id); await send(msg.chat.id, "Cancelled. Send /start again to link."); return; }
  }
  
  const name = await telegramBotName();
  if (!addressed(msg, name)) {
    console.log("not addressed", text.slice(0,40));
    return;
  }
  
  const userId = await ownerFor(msg);
  if (!userId) {
    await send(msg.chat.id, "Link this Telegram account under Settings, Channels first.");
    return;
  }
  
  const bot = await defaultBot(userId);
  if (!bot) {
    await send(msg.chat.id, "No agent on this account.");
    return;
  }
  
  let job = (msg.text ?? msg.caption ?? "").replace(new RegExp(`@${name}\\b`, "ig"), "").trim();
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : undefined;
  const doc = (msg as any).document ? (msg as any).document : undefined;
  if (photo) {
    const rel = await savePhoto(userId, photo.file_id);
    if (rel) job = `Photo /workspace/${rel}: ${job || "analyze"}`;
  }
  if (doc) {
    const file = await tg("getFile", { file_id: doc.file_id }) as { file_path?: string };
    if (file.file_path) {
      const r = await fetch(`https://api.telegram.org/file/bot${token()}/${file.file_path}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const rel = `inbox/${Date.now()}-${doc.file_name || "doc"}`;
      box.writeBytes(userId, rel, buf);
      job = `File /workspace/${rel}: ${job || "process"}`;
    }
  }
  
  if (!job) return;
  
  await deleteMessage(msg.chat.id, msg.message_id);
  const thinking = await tg("sendMessage", { chat_id: msg.chat.id, text: "Р”СѓРјР°СЋ..." }) as { message_id?: number } | undefined;
  const thinkingId = thinking?.message_id;
  
  const conv = await ensureConv(userId, bot.id);
  let output = "";
  
  await runAgent({
    userId,
    botId: bot.id,
    conversationId: conv,
    text: job,
    surface: "telegram",
    mode: parseMode(bot.mode),
    emit: (e: AgentEvent) => {
      if (e.type === "text" && e.text) output += e.text;
    },
  });
  
  if (thinkingId) await editMessage(msg.chat.id, thinkingId, output.slice(0, 4000) || "(done)");
}

async function handleInlineQuery(q: NonNullable<TgUpdate["inline_query"]>) {
  const acc = await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [q.from.id]);
  if (!acc) {
    await tg("answerInlineQuery", {
      inline_query_id: q.id,
      results: [
        {
          type: "article",
          id: "link",
          title: "Link Telegram first",
          description: "Open Settings в†’ Channels в†’ Link",
          input_message_content: { message_text: "Link your Telegram in Janus Settings first." },
        },
      ],
      cache_time: 10,
    }).catch((e) => { console.error("webhook", e); });
    return;
  }
  const query = q.query.replace(/^\/(ask|plan|build)\s*/i, "").trim() || q.query.trim();
  if (!query) {
    await tg("answerInlineQuery", {
      inline_query_id: q.id,
      results: [
        {
          type: "article",
          id: "hint",
          title: "Ask Janus",
          description: "Type your request after @JanusWorkBot",
          input_message_content: { message_text: "Use: @JanusWorkBot your request" },
        },
      ],
      cache_time: 10,
    }).catch((e) => { console.error("webhook", e); });
    return;
  }
  const bot = await defaultBot(acc.user_id);
  if (!bot) {
    await tg("answerInlineQuery", { inline_query_id: q.id, results: [], cache_time: 10 }).catch(() => {});
    return;
  }
  const mode = q.query.match(/^\/(plan|build)/i) ? parseMode(RegExp.$1.toLowerCase()) : parseMode(bot.mode);
  const conv = await ensureConv(acc.user_id, bot.id);
  let answer = "";
  await runAgent({
    userId: acc.user_id,
    botId: bot.id,
    conversationId: conv,
    text: query,
    surface: "telegram",
    mode,
    emit: (e) => {
      if (e.type === "text" && e.text) answer += e.text;
    },
  });
  await tg("answerInlineQuery", {
    inline_query_id: q.id,
    results: [
      {
        type: "article",
        id: "janus",
        title: "Janus",
        description: answer.slice(0, 80) || "Ready",
        input_message_content: { message_text: answer.slice(0, 4000) || "(empty)", parse_mode: "Markdown" },
      },
    ],
    cache_time: 0,
  }).catch((e) => { console.error("webhook", e); });
}

export async function handleTelegramUpdate(body: unknown) {
  const upd = body as TgUpdate;
  if (!upd?.update_id) return;
  if (seen.has(upd.update_id)) return;
  seen.add(upd.update_id);
  if (seen.size > 400) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  if (upd.callback_query) {
    await handleCallback(upd.callback_query);
    return;
  }
  if (upd.inline_query) {
    await handleInlineQuery(upd.inline_query);
    return;
  }
  if (upd.chosen_inline_result) return;
  if (upd.message) await handleMessage(upd.message);
}
