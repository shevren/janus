import { createHash, randomBytes } from "node:crypto";
import { parseMode, runAgent, type AgentEvent } from "./agent.js";
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
  const url = `${config.publicUrl}/api/telegram/webhook`;
  await tg("setWebhook", {
    url,
    secret_token: secret(),
    allowed_updates: ["message", "callback_query", "inline_query", "chosen_inline_result"],
  });
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
    await send(msg.chat.id, "Open Settings, Channels, then Link Telegram. I will not guess who you are.");
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
  await send(msg.chat.id, "Linked. Ask me to install an MCP or a skill the same way you would in the app.");
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

async function handleMessage(msg: TgMessage) {
  const name = await telegramBotName();
  const text = (msg.text ?? "").trim();
  if (text.startsWith("/start")) {
    await handleStart(msg);
    return;
  }
  if (!addressed(msg, name)) return;
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
  if (photo) {
    const rel = await savePhoto(userId, photo.file_id);
    if (rel) job = `User sent photo /workspace/${rel}\n${job}`.trim();
  }
  const switched = job.match(/^\/(ask|plan|build)(?:\s+([\s\S]+))?$/i);
  let mode = parseMode(bot.mode);
  if (switched) {
    mode = parseMode(switched[1].toLowerCase());
    await q(`update bots set mode = $2 where id = $1`, [bot.id, mode]);
    job = (switched[2] ?? "").trim();
    if (!job) {
      const hint =
        mode === "plan"
          ? "Plan. Send the job. I write a short plan and wait."
          : mode === "build"
            ? "Build. Send the job. I execute with tools."
            : "Ask. Send a question or a small job.";
      await send(msg.chat.id, hint);
      return;
    }
  }
  if (!job) return;
  const conv = await ensureConv(userId, bot.id);
  const chatId = msg.chat.id;
  await runAgent({
    userId,
    botId: bot.id,
    conversationId: conv,
    text: job,
    surface: "telegram",
    mode,
    emit: (e: AgentEvent) => {
      if (e.type === "text" && e.text) void send(chatId, e.text);
      if (e.type === "approval") {
        void send(chatId, e.detail ? `${e.detail}\n\nAllow ${e.action}?` : `Allow ${e.action}?`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Allow once", callback_data: `a:${e.id}:y` },
                { text: "Deny", callback_data: `a:${e.id}:n` },
              ],
            ],
          },
        });
      }
    },
  });
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
          description: "Open Settings → Channels → Link",
          input_message_content: { message_text: "Link your Telegram in Janus Settings first." },
        },
      ],
      cache_time: 10,
    }).catch(() => {});
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
    }).catch(() => {});
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
  }).catch(() => {});
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
