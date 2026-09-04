import { createHash, randomBytes } from "node:crypto";
import { parseMode, runAgent, type AgentEvent, type AgentMode } from "./agent.js";
import { config } from "./config.js";
import { encrypt } from "./crypto.js";
import { q, q1 } from "./db.js";
import * as box from "./sandbox.js";
import { balancedHtml, chunksOf, sanitizeTgHtml, stripTags } from "./tgformat.js";

type TgUser = { id: number; username?: string; is_bot?: boolean };
type TgChat = { id: number; type: string; title?: string };
type TgPhoto = { file_id: string; file_size?: number };
type TgDocument = { file_id: string; mime_type?: string; file_name?: string };
type TgMessage = {
  message_id: number;
  message_thread_id?: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhoto[];
  document?: TgDocument;
  entities?: { type: string; offset: number; length: number }[];
  caption_entities?: { type: string }[];
  reply_to_message?: { from?: TgUser; text?: string; caption?: string; photo?: TgPhoto[]; document?: TgDocument };
};
type TgGuestMessage = TgMessage & { guest_query_id?: string };
type TgBusinessMessage = TgMessage & { business_connection_id?: string };
type TgBusinessConnection = {
  id: string;
  user: TgUser;
  can_reply?: boolean;
  rights?: Record<string, unknown>;
};
type TgStopped = { chat: TgChat; draft_id: number };
type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  guest_message?: TgGuestMessage;
  business_connection?: TgBusinessConnection;
  business_message?: TgBusinessMessage;
  stopped_message_generation?: TgStopped;
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

async function setCommands() {
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
}

export async function registerTelegramWebhook() {
  if (!token()) return;
  const raw = config.publicUrl;
  const webhookOk =
    raw.startsWith("https://") && !raw.includes("sslip.io") && !raw.includes("localhost") && !raw.includes("127.0.0.1");
  const updates = ["message", "guest_message", "business_connection", "business_message", "stopped_message_generation", "callback_query", "inline_query", "chosen_inline_result"];
  if (!webhookOk) {
    await tg("deleteWebhook").catch(() => {});
    startPolling(updates);
    await setCommands();
    await telegramBotName();
    return;
  }
  const url = `${raw}/api/telegram/webhook`;
  try {
    await tg("setWebhook", {
      url,
      secret_token: secret(),
      allowed_updates: updates,
    });
  } catch (e) {
    console.error("webhook", e, "fallback to polling");
    await tg("deleteWebhook").catch(() => {});
    startPolling();
    await setCommands();
    return;
  }
  try {
    const info = (await tg("getWebhookInfo")) as { last_error_message?: string };
    if (info.last_error_message?.includes("SSL") || info.last_error_message?.includes("certificate")) {
      console.error("SSL webhook, fallback to polling", info);
      await tg("deleteWebhook").catch(() => {});
      startPolling();
      await setCommands();
      return;
    }
  } catch {}
  await setCommands();
  await telegramBotName();
}

let polling = false;
export function startPolling(allowed?: string[]) {
  if (polling || !token()) return;
  polling = true;
  let offset = 0;
  const loop = async () => {
    try {
      const res = (await tg("getUpdates", { offset, timeout: 30, allowed_updates: allowed ?? ["message", "guest_message", "business_connection", "business_message", "stopped_message_generation", "callback_query", "inline_query", "chosen_inline_result"] })) as { result?: TgUpdate[] };
      const arr = Array.isArray((res as unknown as { result?: TgUpdate[] })?.result) ? (res as unknown as { result: TgUpdate[] }).result : Array.isArray(res) ? (res as unknown as TgUpdate[]) : [];
      for (const u of arr) {
        offset = (u.update_id ?? 0) + 1;
        await handleTelegramUpdate(u);
      }
    } catch (e) {
      const msg = String(e);
      console.error("polling", msg.slice(0, 200));
      if (msg.includes("409") || msg.toLowerCase().includes("conflict")) {
        await tg("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
      }
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

// Final answer delivery: sanitized HTML, chunked, plain-text fallback.
// Never truncates long answers to the first 4000 chars anymore.
async function deliver(chatId: number, thinkingId: number | undefined, html: string) {
  const parts = chunksOf(html.trim() || "(done)");
  let first = true;
  for (const p of parts) {
    const safe = sanitizeTgHtml(p);
    const useHtml = balancedHtml(safe);
    const text = (useHtml ? safe : stripTags(p)).slice(0, 4000);
    const params = useHtml ? { parse_mode: "HTML" } : {};
    try {
      if (first && thinkingId) {
        await tg("editMessageText", { chat_id: chatId, message_id: thinkingId, text, ...params });
      } else {
        await tg("sendMessage", { chat_id: chatId, text, ...params });
      }
    } catch {
      const plain = stripTags(p).slice(0, 4000);
      if (first && thinkingId) await editMessage(chatId, thinkingId, plain);
      else await send(chatId, plain);
    }
    first = false;
  }
}

async function ephemeral(chatId: number, userId: number, text: string) {
  await tg("sendMessage", { chat_id: userId, text, disable_notification: true }).catch(() => {});
  const t = await tg("sendMessage", { chat_id: chatId, text: "✓ Set (private)", disable_notification: true }) as { message_id?: number } | undefined;
  if (t?.message_id) setTimeout(() => { void deleteMessage(chatId, t.message_id!); }, 1500);
}

async function answerCallback(id: string, text: string) {
  await tg("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});
}

const SEARCH_TOOLS = new Set(["search_web", "wiki", "github_search", "catalog_search", "search_file"]);
const EXTRACT_TOOLS = new Set(["read_page", "wiki", "workspace_read", "workspace_read_many", "github_file", "read_pages"]);
const READ_TOOLS = new Set([
  "workspace_read", "workspace_read_many", "workspace_list", "read_page", "read_pages",
  "github_file", "github_tree", "github_repos", "analyze_image", "now", "calc", "convert", "think",
]);

// Shared progress chain: Думаю → Ищу → Нашёл → Извлекаю (+ Работаю/Подтверждение).
// Both /ask commands and plain mentions use it, so the status never sticks.
function makeStatus() {
  let phase: "think" | "search" | "found" | "read" | "work" | "approval" | "extract" = "think";
  let sources = 0;
  let detail = "";
  return {
    onEvent(e: AgentEvent) {
      if (e.type === "tool" && e.status === "running") {
        if (SEARCH_TOOLS.has(e.name ?? "")) phase = "search";
        else if (READ_TOOLS.has(e.name ?? "")) phase = "read";
        else phase = "work";
        detail = e.name ?? "";
      }
      if (e.type === "tool" && e.status === "ok") {
        if (e.name === "search_web") {
          sources++;
          phase = "found";
        } else if (EXTRACT_TOOLS.has(e.name ?? "")) {
          phase = "extract";
        }
      }
      if (e.type === "approval") phase = "approval";
    },
    text() {
      switch (phase) {
        case "think": return "Думаю...";
        case "search": return "Ищу источники...";
        case "found": return sources > 0 ? `Нашёл ${sources}, читаю...` : "Ищу источники...";
        case "read": return "Читаю...";
        case "extract": return "Извлекаю информацию...";
        case "work": return detail ? `Делаю (${detail})...` : "Работаю...";
        case "approval": return "Нужно подтверждение — кнопки выше";
      }
    },
  };
}

function startStatusLoop(chatId: number, thinkingId: number | undefined, st: ReturnType<typeof makeStatus>) {
  let done = false;
  let last = "";
  const timer = setInterval(() => {
    void (async () => {
      if (done || !thinkingId) return;
      const body = st.text();
      if (body !== last) {
        last = body;
        await editMessage(chatId, thinkingId, body);
      }
    })();
  }, 900);
  return () => {
    done = true;
    clearInterval(timer);
  };
}

async function askApproval(chatId: number, id: string, action: string, detail?: string) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: `Подтвердить: ${action}${detail ? `\n${detail.slice(0, 300)}` : ""}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Allow once", callback_data: `a:${id}:y` },
          { text: "Deny", callback_data: `a:${id}:n` },
        ],
      ],
    },
  }).catch(() => {});
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

function isImageDoc(d?: TgDocument) {
  return !!d && (/^image\//i.test(d.mime_type ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(d.file_name ?? ""));
}

/** Biggest photo file_id: own photo → reply photo → reply image-document. */
function photoFileId(msg: TgMessage): string | undefined {
  if (msg.photo?.length) return msg.photo[msg.photo.length - 1].file_id;
  const doc = (msg as { document?: TgDocument }).document;
  if (isImageDoc(doc)) return doc!.file_id;
  const rep = msg.reply_to_message;
  if (rep?.photo?.length) return rep.photo[rep.photo.length - 1].file_id;
  if (isImageDoc(rep?.document)) return rep!.document!.file_id;
  return undefined;
}

async function saveAnyFile(userId: string, fileId: string, hint: string) {
  const file = (await tg("getFile", { file_id: fileId })) as { file_path?: string };
  if (!file.file_path) return "";
  const r = await fetch(`https://api.telegram.org/file/bot${token()}/${file.file_path}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const safe = (hint || "file").replace(/[^\w.-]+/g, "-").slice(0, 60) || "file";
  const rel = `inbox/${Date.now()}-${safe}`;
  box.writeBytes(userId, rel, buf);
  return rel;
}

function isAbortError(e: unknown) {
  return (e as { name?: string })?.name === "AbortError";
}

// Sweep stale link intents (10 min TTL) so the map can't grow forever.
function pendingTouch(id: number) {
  const now = Date.now();
  for (const [k, at] of pendingEmail) {
    if (now - at > 10 * 60 * 1000) pendingEmail.delete(k);
  }
  pendingEmail.set(id, now);
}

type UserRun = {
  controller: AbortController;
  query: string;
  chatId: number;
  thinkingId?: number;
  draftId?: number;
  tail: Promise<void>;
};
const userRuns = new Map<number, UserRun>();

const inlineAbort = new Map<number, AbortController>();
const inlineCache = new Map<string, { at: number; answer: string; mode: string }>();

/** Cheap flash call: is the new message a continuation of the running job? */
async function isContinuation(prev: string, next: string): Promise<boolean> {
  const base = config.agentModelBaseUrl;
  const key = config.agentModelApiKey;
  if (!base || !key) return false;
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: config.agentModelFlash || config.agentModelDefault,
        messages: [
          {
            role: "system",
            content: "Answer only YES or NO. YES if the second user message continues, refines or corrects the first task. NO if it is a different topic.",
          },
          { role: "user", content: `First: ${prev.slice(0, 500)}\nSecond: ${next.slice(0, 500)}` },
        ],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return /\byes\b/i.test(j.choices?.[0]?.message?.content ?? "");
  } catch {
    return false;
  }
}

async function startRun(args: {
  tgId: number;
  userId: string;
  botId: string;
  conv: string;
  job: string;
  mode: AgentMode;
  chatId: number;
  thinkingId?: number;
  isPrivate?: boolean;
}): Promise<void> {
  const controller = new AbortController();
  const st = makeStatus();
  // PM chats: native streaming draft (Thinking… + Stop button) instead of
  // a "Думаю..." message. Groups keep the editable status message.
  const useDraft = !!args.isPrivate;
  const draftId = useDraft ? 1 + Math.floor(Math.random() * 2 ** 31) : 0;
  const stopStatus = useDraft ? () => {} : startStatusLoop(args.chatId, args.thinkingId, st);
  let output = "";
  let lastSent = "";
  const pushDraft = async (text: string) => {
    if (text === lastSent) return;
    lastSent = text;
    const safe = sanitizeTgHtml(text);
    const useHtml = balancedHtml(safe);
    await tg("sendMessageDraft", {
      chat_id: args.chatId,
      draft_id: draftId,
      text: (useHtml ? safe : stripTags(text)).slice(0, 4000),
      ...(useHtml ? { parse_mode: "HTML" } : {}),
      can_stop: true,
    }).catch(() => {});
  };
  if (useDraft) await pushDraft("");
  const draftTimer = useDraft
    ? setInterval(() => {
        void (async () => {
          if (controller.signal.aborted) return;
          const body = output ? output.slice(-4000) : st.text();
          await pushDraft(body);
        })();
      }, 1200)
    : undefined;
  const run = (async () => {
    try {
      await runAgent({
        userId: args.userId,
        botId: args.botId,
        conversationId: args.conv,
        text: args.job,
        surface: "telegram",
        mode: args.mode,
        signal: controller.signal,
        approvalTimeoutMs: 180000,
        emit: (e: AgentEvent) => {
          st.onEvent(e);
          if (e.type === "approval") void askApproval(args.chatId, e.id, e.action, e.detail);
          if (e.type === "text" && e.text) output += e.text;
        },
      });
    } catch (e) {
      if (!isAbortError(e)) output = `Ошибка: ${String(e).slice(0, 500)}`;
    } finally {
      stopStatus();
      if (draftTimer) clearInterval(draftTimer);
    }
    if (controller.signal.aborted) {
      // Stopped by the user via the Stop button: persist what we have.
      if (controller.signal.reason === "stop" && output.trim()) {
        await deliver(args.chatId, args.thinkingId, `${output}\n\n⏹ Остановлено.`);
      }
      return;
    }
    await deliver(args.chatId, args.thinkingId, output);
  })();
  userRuns.set(args.tgId, { controller, query: args.job, chatId: args.chatId, thinkingId: args.thinkingId, draftId, tail: run });
  try {
    await run;
  } finally {
    if (userRuns.get(args.tgId)?.controller === controller) userRuns.delete(args.tgId);
  }
}

/**
 * Smart per-user execution: continuation of the running job aborts it and
 * answers the merged request in the SAME thinking message; a new topic is
 * queued and answered after the current one.
 */
async function runUserJob(args: {
  tgId: number;
  userId: string;
  botId: string;
  conv: string;
  job: string;
  mode: AgentMode;
  chatId: number;
  thinkingId?: number;
  isPrivate?: boolean;
}): Promise<void> {
  const prev = userRuns.get(args.tgId);
  if (prev && !prev.controller.signal.aborted) {
    let cont = false;
    try {
      cont = await isContinuation(prev.query, args.job);
    } catch {
      cont = false;
    }
    if (cont) {
      prev.controller.abort();
      try {
        await prev.tail;
      } catch {}
      if (args.thinkingId && args.thinkingId !== prev.thinkingId) {
        await deleteMessage(args.chatId, args.thinkingId);
      }
      if (prev.thinkingId) await editMessage(prev.chatId, prev.thinkingId, "Дополняю...");
      return startRun({ ...args, job: `${prev.query}\n\nUpdate: ${args.job}`, chatId: prev.chatId, thinkingId: prev.thinkingId });
    }
    if (args.thinkingId) await deleteMessage(args.chatId, args.thinkingId);
    await send(args.chatId, "Принял, отвечу после текущего ⏳");
    prev.tail = prev.tail.then(() => startRun({ ...args })).catch(() => {});
    return;
  }
  return startRun(args);
}

async function handleStart(msg: TgMessage) {
  const text = msg.text ?? "";
  const rawCode = text.split(/\s+/)[1];
  // Continuity from inline/guest ("Open Janus" button): no link code, just greet/link.
  const code = rawCode === "inline" || rawCode === "guest" ? undefined : rawCode;
  if (!code || !msg.from) {
    const fromId = msg.from!.id;
    const acc = await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [fromId]);
    if (acc) {
      await send(msg.chat.id, "Already linked. Send a job or /help.");
      return;
    }
    pendingTouch(fromId);
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

async function senderOrChatOwner(msg: TgMessage): Promise<string | undefined> {
  if (msg.from) {
    const acc = await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [msg.from.id]);
    if (acc) return acc.user_id;
  }
  return ownerFor(msg);
}

async function handleCommand(msg: TgMessage, cmd: string, args: string) {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const acc = fromId ? await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [fromId]) : null;
  const chatOwner = await q1<{ owner_user_id: string }>(`select owner_user_id from telegram_chats where chat_id = $1`, [chatId]);
  const userId = acc ?? (chatOwner ? { user_id: chatOwner.owner_user_id } : null);
  
  await deleteMessage(chatId, msg.message_id);
  const isPrivate = msg.chat.type === "private";
  const thinking = isPrivate
    ? undefined
    : (await tg("sendMessage", { chat_id: chatId, text: "Думаю..." }).catch(() => undefined) as { message_id?: number } | undefined);
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
      await send(chatId, "Janus — твой агент везде. В любом чате без добавления: просто упомяни @JanusWorkBot с вопросом — отвечу сам (guest), либо @JanusWorkBot <запрос> и выбери результат (inline). На фото можно отвечать reply + упоминание. С ботом в группе: /ask /plan /build или упомяни меня. В личке: просто пиши, файлы и фото — в inbox. Секретарь для своих чатов: /secretary on.");
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
    if (cmd === "/secretary") {
      if (thinkingId) await deleteMessage(chatId, thinkingId);
      const sub = args.toLowerCase().split(/\s+/)[0];
      if (!fromId) {
        await send(chatId, "Link Telegram first: open @JanusWorkBot in DM and send /start.");
        return;
      }
      if (sub === "on" || sub === "off") {
        await q(`update business_connections set auto_reply = $2, updated_at = now() where telegram_user_id = $1`, [
          fromId,
          sub === "on",
        ]);
        await send(
          chatId,
          sub === "on"
            ? "Секретарь включён: буду отвечать в твоих чатах, где подключён. Чтобы подключить: включи Secretary Mode в BotFather и привяжи аккаунт к боту."
            : "Секретарь выключен: входящие бизнес-сообщения игнорирую.",
        );
      } else {
        const rows = await q<{ connection_id: string; auto_reply: boolean }>(
          `select connection_id, auto_reply from business_connections where telegram_user_id = $1`,
          [fromId],
        );
        await send(
          chatId,
          rows.length
            ? `Подключения: ${rows.map((r) => `${r.connection_id.slice(0, 8)}… (${r.auto_reply ? "on" : "off"})`).join(", ")}. /secretary on|off`
            : "Нет подключений. Включи Secretary Mode в BotFather, подключи аккаунт к боту, затем /secretary on.",
        );
      }
      return;
    }
    if (["/ask", "/plan", "/build"].includes(cmd)) {
      const mode = cmd.slice(1) as AgentMode;
      const conv = await ensureConv(userId.user_id, bot.id);
      await runUserJob({
        tgId: fromId ?? chatId,
        userId: userId.user_id,
        botId: bot.id,
        conv,
        job: args || "help",
        mode,
        chatId,
        thinkingId,
        isPrivate,
      });
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
    await deliver(chatId, thinkingId, output);
  } catch (e) {
    await deliver(chatId, thinkingId, `Ошибка: ${String(e)}`);
  }
}

async function handleMessage(msg: TgMessage) {
  console.log("handleMessage", msg.chat.type, msg.text?.slice(0,80), "from", msg.from?.id);
  const text = (msg.text ?? "").trim();
  if (msg.from) {
    const now = Date.now();
    for (const [k, at] of pendingEmail) {
      if (now - at > 10 * 60 * 1000) pendingEmail.delete(k);
    }
  }

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
      if (config.agentModelApiKey) {
        await q(`insert into model_providers (user_id,kind,name,base_url,api_key_enc,default_model) values ($1,'openai','janus-default',$2,$3,$4) on conflict do nothing`, [userId, config.agentModelBaseUrl || null, encrypt(config.agentModelApiKey), config.agentModelDefault]);
      }
    } else {
      const has = await q1<{ id: string }>(`select id from model_providers where user_id=$1 limit 1`, [userId]);
      if (!has && config.agentModelApiKey) {
        await q(`insert into model_providers (user_id,kind,name,base_url,api_key_enc,default_model) values ($1,'openai','janus-default',$2,$3,$4)`, [userId, config.agentModelBaseUrl || null, encrypt(config.agentModelApiKey), config.agentModelDefault]);
      }
    }
    await q(`insert into telegram_accounts (telegram_user_id,user_id,username) values ($1,$2,$3) on conflict (telegram_user_id) do update set user_id=excluded.user_id`, [msg.from.id, userId, msg.from.username ?? ""]);
    await q(`insert into telegram_chats (chat_id,owner_user_id,kind) values ($1,$2,'dm') on conflict (chat_id) do update set owner_user_id=excluded.owner_user_id`, [msg.chat.id, userId]);
    pendingEmail.delete(msg.from.id);
    await send(msg.chat.id, `Linked as ${email}. Send a job — /ask, /plan or /build.`);
    return;
  } else if (msg.from && pendingEmail.has(msg.from.id) && text) {
    if (text.toLowerCase() === "/cancel") { pendingEmail.delete(msg.from.id); await send(msg.chat.id, "Cancelled. Send /start again to link."); return; }
  }

  const cmdMatch = text.match(/^\/(ask|plan|build|help|model|secretary)(@\w+)?(\s+([\s\S]*))?$/i);
  if (cmdMatch) {
    const cmd = "/" + cmdMatch[1].toLowerCase();
    const args = (cmdMatch[4] ?? "").trim();
    await handleCommand(msg, cmd, args);
    return;
  }

  const name = await telegramBotName();
  if (!addressed(msg, name)) {
    console.log("not addressed", text.slice(0,40));
    return;
  }
  
  const userId = await senderOrChatOwner(msg);
  if (!userId) {
    await send(msg.chat.id, "Link first: open @JanusWorkBot in DM and send /start, then use /ask here or @JanusWorkBot <query> inline without adding.");
    return;
  }
  
  const bot = await defaultBot(userId);
  if (!bot) {
    await send(msg.chat.id, "No agent on this account.");
    return;
  }
  
  let job = (msg.text ?? msg.caption ?? "").replace(new RegExp(`@${name}\\b`, "ig"), "").trim();
  const replyText = msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "";
  if (!job && replyText) job = replyText.replace(new RegExp(`@${name}\\b`, "ig"), "").trim();
  const img = photoFileId(msg);
  if (img) {
    const rel = await savePhoto(userId, img);
    if (rel) job = `Photo /workspace/${rel}: ${job || "analyze this photo"}`;
  } else {
    const doc = (msg as { document?: TgDocument }).document ?? msg.reply_to_message?.document;
    if (doc) {
      const rel = await saveAnyFile(userId, doc.file_id, doc.file_name ?? "doc");
      if (rel) job = `File /workspace/${rel}: ${job || "process"}`;
    }
  }
  
  if (!job) return;
  
  await deleteMessage(msg.chat.id, msg.message_id);
  const pm = msg.chat.type === "private";
  const thinking = pm
    ? undefined
    : (await tg("sendMessage", { chat_id: msg.chat.id, text: "Думаю..." }).catch(() => undefined) as { message_id?: number } | undefined);
  const thinkingId = thinking?.message_id;

  const conv = await ensureConv(userId, bot.id);
  await runUserJob({
    tgId: msg.from?.id ?? msg.chat.id,
    userId,
    botId: bot.id,
    conv,
    job,
    mode: parseMode(bot.mode),
    chatId: msg.chat.id,
    thinkingId,
    isPrivate: pm,
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
  // Short queries (mid-typing keystrokes): instant empty + button, no agent run.
  if (query.length < 3) {
    await tg("answerInlineQuery", {
      inline_query_id: q.id,
      results: [],
      cache_time: 0,
      is_personal: true,
      button: { text: "Допиши вопрос — отвечу здесь", start_parameter: "inline" },
    }).catch(() => {});
    return;
  }
  const cacheKey = `${q.from.id}\n${mode}\n${query}`;
  const hit = inlineCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 90000) {
    await tg("answerInlineQuery", {
      inline_query_id: q.id,
      results: [guestArticle(mode === "ask" ? "Janus" : `Janus (${mode})`, hit.answer)],
      cache_time: 0,
      is_personal: true,
      button: { text: "Продолжить в Janus", start_parameter: "inline" },
    }).catch(() => {});
    return;
  }
  // New keystroke cancels the stale run for this user.
  inlineAbort.get(q.from.id)?.abort();
  const controller = new AbortController();
  inlineAbort.set(q.from.id, controller);
  const conv = await ensureConv(acc.user_id, bot.id);
  let answer = "";
  try {
    await runAgent({
      userId: acc.user_id,
      botId: bot.id,
      conversationId: conv,
      text: query,
      surface: "telegram",
      mode,
      signal: controller.signal,
      approvalTimeoutMs: 180000,
      emit: (e) => {
        if (e.type === "text" && e.text) answer += e.text;
      },
    });
  } catch (e) {
    if (!isAbortError(e)) answer = `Ошибка: ${String(e).slice(0, 300)}`;
  } finally {
    if (inlineAbort.get(q.from.id) === controller) inlineAbort.delete(q.from.id);
  }
  if (controller.signal.aborted || !answer) return;
  inlineCache.set(cacheKey, { at: Date.now(), answer, mode });
  if (inlineCache.size > 200) {
    const first = inlineCache.keys().next().value;
    if (first !== undefined) inlineCache.delete(first);
  }
  // Plain text: agent output can contain unbalanced markdown which makes
  // Telegram reject the whole answer with 400 (silent spinner for the user).
  // is_personal: answers depend on the linked account. button: one-tap jump
  // to PM to continue heavy tasks where the bot lives.
  await tg("answerInlineQuery", {
    inline_query_id: q.id,
    results: [guestArticle(mode === "ask" ? "Janus" : `Janus (${mode})`, answer || "(empty)")],
    cache_time: 0,
    is_personal: true,
    button: { text: "Продолжить в Janus", start_parameter: "inline" },
  }).catch((e) => { console.error("webhook", e); });
}

function guestArticle(title: string, body: string) {
  const safe = sanitizeTgHtml((body || "(empty)").slice(0, 4000));
  const useHtml = balancedHtml(safe);
  const text = (useHtml ? safe : stripTags(body || "(empty)")).slice(0, 4000);
  return {
    type: "article",
    id: `janus-${Math.random().toString(36).slice(2, 10)}`,
    title,
    description: stripTags(body).slice(0, 80) || "Janus",
    input_message_content: { message_text: text, ...(useHtml ? { parse_mode: "HTML" } : {}) },
  };
}

async function answerGuest(queryId: string, title: string, body: string) {
  await tg("answerGuestQuery", { guest_query_id: queryId, result: guestArticle(title, body) }).catch((e) => {
    console.error("guest", e);
  });
}

// Guest Mode (Bot API 10+): user mentions @JanusWorkBot in ANY chat without
// adding it. We get one update with context and reply once, as the bot.
async function handleGuest(msg: TgGuestMessage) {
  const queryId = msg.guest_query_id;
  if (!queryId) return;
  const name = await telegramBotName();
  const from = msg.from;
  if (!from) {
    await answerGuest(queryId, "Janus", "Janus here. Mention me with a question.");
    return;
  }
  const acc = await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [from.id]);
  if (!acc) {
    await answerGuest(queryId, "Link Janus first", "Open @JanusWorkBot in a private chat and send /start, then mention me anywhere.");
    return;
  }
  const bot = await defaultBot(acc.user_id);
  if (!bot) {
    await answerGuest(queryId, "Janus", "No agent on this account yet.");
    return;
  }
  // Best effort: remove the summon message where we have delete rights.
  if (msg.chat && msg.message_id) await deleteMessage(msg.chat.id, msg.message_id);
  let text = (msg.text ?? msg.caption ?? "").replace(new RegExp(`@${name}\\b`, "ig"), "").trim();
  const replyCtx = (msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "").trim();
  if (replyCtx) text = `Context:\n${replyCtx.slice(0, 1000)}\n\nTask:\n${text}`;
  const m = text.match(/^\/(plan|build|ask)\s+([\s\S]*)$/i);
  const mode = m ? parseMode(m[1].toLowerCase()) : parseMode(bot.mode);
  let job = (m ? m[2] : text).trim() || "help";
  const img = photoFileId(msg);
  if (img) {
    const rel = await savePhoto(acc.user_id, img).catch(() => "");
    if (rel) job = `Photo /workspace/${rel}: ${job || "analyze this photo"}`;
  }
  const conv = await ensureConv(acc.user_id, bot.id);
  let answer = "";
  try {
    await runAgent({
      userId: acc.user_id,
      botId: bot.id,
      conversationId: conv,
      text: job,
      surface: "telegram",
      mode,
      emit: (e) => {
        if (e.type === "text" && e.text) answer += e.text;
      },
    });
  } catch (e) {
    answer = `Ошибка: ${String(e).slice(0, 300)}`;
  }
  await answerGuest(queryId, mode === "ask" ? "Janus" : `Janus (${mode})`, answer || "(done)");
}

const bizRate = new Map<string, number>();

async function handleBusinessConnection(conn: TgBusinessConnection) {
  const acc = await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [conn.user.id]);
  await q(
    `insert into business_connections (connection_id, telegram_user_id, user_id, rights, updated_at)
     values ($1,$2,$3,$4,now())
     on conflict (connection_id) do update set telegram_user_id = excluded.telegram_user_id, user_id = excluded.user_id, rights = excluded.rights, updated_at = now()`,
    [conn.id, conn.user.id, acc?.user_id ?? null, JSON.stringify(conn.rights ?? { can_reply: conn.can_reply ?? false })],
  );
  // Best effort: tell the owner where to flip the switch. Works if they started the bot.
  await tg("sendMessage", {
    chat_id: conn.user.id,
    text: "Секретарь подключён. Включи автоответы: /secretary on. Выключить: /secretary off.",
  }).catch(() => {});
}

// Secretary Mode: the owner's account forwards incoming DMs here.
// Replies go out on behalf of the owner. Default OFF, loop-guarded.
async function handleBusinessMessage(msg: TgBusinessMessage) {
  const connId = msg.business_connection_id;
  if (!connId) return;
  const row = await q1<{ telegram_user_id: number; user_id: string | null; rights: { can_reply?: boolean }; auto_reply: boolean }>(
    `select telegram_user_id, user_id, rights, auto_reply from business_connections where connection_id = $1`,
    [connId],
  );
  if (!row?.auto_reply) return;
  if (!row.rights?.can_reply) return;
  if (msg.from?.is_bot || (msg.from && msg.from.id === row.telegram_user_id)) return;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!text) return;
  const last = bizRate.get(connId) ?? 0;
  if (Date.now() - last < 20000) return;
  bizRate.set(connId, Date.now());
  let userId = row.user_id;
  if (!userId) {
    const acc = await q1<{ user_id: string }>(`select user_id from telegram_accounts where telegram_user_id = $1`, [row.telegram_user_id]);
    if (!acc) return;
    userId = acc.user_id;
  }
  const bot = await defaultBot(userId);
  if (!bot) return;
  const conv = await ensureConv(userId, bot.id);
  let output = "";
  try {
    await runAgent({
      userId,
      botId: bot.id,
      conversationId: conv,
      text,
      surface: "telegram",
      mode: "ask",
      approvalTimeoutMs: 60000,
      emit: (e) => {
        if (e.type === "text" && e.text) output += e.text;
      },
    });
  } catch (e) {
    output = `Ошибка: ${String(e).slice(0, 300)}`;
  }
  if (!output.trim()) return;
  const safe = sanitizeTgHtml(output.slice(0, 4000));
  const useHtml = balancedHtml(safe);
  const body = (useHtml ? safe : stripTags(output)).slice(0, 4000);
  await tg("sendMessage", {
    chat_id: msg.chat.id,
    business_connection_id: connId,
    reply_parameters: { message_id: msg.message_id },
    text: body,
    ...(useHtml ? { parse_mode: "HTML" } : {}),
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
  if (upd.business_connection) {
    await handleBusinessConnection(upd.business_connection);
    return;
  }
  if (upd.business_message) {
    await handleBusinessMessage(upd.business_message);
    return;
  }
  if (upd.stopped_message_generation) {
    // User hit Stop on a streaming draft: abort that PM run.
    const s = upd.stopped_message_generation;
    const run = userRuns.get(s.chat.id);
    if (run && run.draftId === s.draft_id) run.controller.abort("stop");
    return;
  }
  if (upd.guest_message) {
    await handleGuest(upd.guest_message);
    return;
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
