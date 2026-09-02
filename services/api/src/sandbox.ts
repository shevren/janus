import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { q, q1 } from "./db.js";

type Slot = {
  context: BrowserContext;
  page: Page;
  userId: string;
};

const slots = new Map<string, Slot>();
const CHALLENGE =
  /just a moment|attention required|verify you are human|cf-challenge|recaptcha|hcaptcha|captcha/i;

export function isChallenge(title: string, url: string) {
  return CHALLENGE.test(`${title} ${url}`);
}

export function workspace(userId: string) {
  const dir = path.join(config.dataDir, "computers", userId, "workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function screenPath(userId: string) {
  const dir = path.join(config.dataDir, "screens");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${userId}.png`);
}

export async function getSlot(userId: string): Promise<Slot> {
  const existing = slots.get(userId);
  if (existing) return existing;
  if (slots.size >= 1) {
    const first = slots.keys().next().value as string | undefined;
    if (first && first !== userId) await closeSlot(first);
  }
  const profile = path.join(config.dataDir, "computers", userId, "profile");
  fs.mkdirSync(profile, { recursive: true });
  workspace(userId);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const slot = { context, page, userId };
  slots.set(userId, slot);
  await q(
    `insert into computers (user_id, status) values ($1, 'ready')
     on conflict (user_id) do update set status = 'ready', updated_at = now()`,
    [userId],
  );
  return slot;
}

export async function closeSlot(userId: string) {
  const s = slots.get(userId);
  if (!s) return;
  await s.context.close().catch(() => {});
  slots.delete(userId);
}

export async function snapshot(userId: string): Promise<Buffer> {
  const s = await getSlot(userId);
  const buf = await s.page.screenshot({ type: "png" });
  fs.writeFileSync(screenPath(userId), buf);
  const url = s.page.url();
  const takeover = CHALLENGE.test(`${s.page.url()} ${await s.page.title().catch(() => "")}`);
  await q(
    `insert into computers (user_id, status, last_url, takeover, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (user_id) do update set status = $2, last_url = $3, takeover = $4, updated_at = now()`,
    [userId, takeover ? "takeover" : "ready", url, takeover],
  );
  return buf;
}

export async function browse(userId: string, url: string) {
  const s = await getSlot(userId);
  await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  return snapshot(userId);
}

export async function searchWeb(userId: string, query: string) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  await browse(userId, url);
  return pageText(userId);
}

export async function clickAt(userId: string, x: number, y: number) {
  const s = await getSlot(userId);
  await s.page.mouse.click(x, y);
  return snapshot(userId);
}

export async function typeText(userId: string, text: string) {
  const s = await getSlot(userId);
  await s.page.keyboard.type(text, { delay: 12 });
  return snapshot(userId);
}

export async function keyPress(userId: string, key: string) {
  const s = await getSlot(userId);
  await s.page.keyboard.press(key);
  return snapshot(userId);
}

export async function setDriver(userId: string, driver: "idle" | "agent" | "user", activity?: string) {
  await q(
    `insert into computers (user_id, status, takeover, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id) do update set status = $2, takeover = $3, updated_at = now()`,
    [userId, activity ? `${driver}:${activity}` : driver, driver === "user"],
  );
}

export async function waitIfUserDriving(userId: string) {
  for (let i = 0; i < 3600; i++) {
    const row = await q1<{ status: string; takeover: boolean }>(
      `select status, takeover from computers where user_id = $1`,
      [userId],
    );
    if (!row?.takeover && !row?.status.startsWith("user")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function scroll(userId: string, dy: number) {
  const s = await getSlot(userId);
  await s.page.mouse.wheel(0, dy);
  return snapshot(userId);
}

export async function pageText(userId: string): Promise<{ url: string; title: string; text: string; challenge: boolean }> {
  const s = await getSlot(userId);
  const title = await s.page.title();
  const url = s.page.url();
  const text = await s.page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? "");
  return { url, title, text, challenge: isChallenge(title, url) };
}

export async function pageA11y(userId: string): Promise<string> {
  const s = await getSlot(userId);
  const snap = await s.page.locator("html").ariaSnapshot();
  return snap.slice(0, 40_000);
}

export function listFiles(userId: string, rel = "."): string {
  return listWorkspace(userId, rel).join("\n") || "(empty)";
}

export function listWorkspace(userId: string, rel = "."): string[] {
  const root = workspace(userId);
  const dir = path.resolve(root, rel);
  if (!dir.startsWith(root)) throw new Error("path");
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(path.relative(root, p).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return out.slice(0, 400);
}

export function searchFiles(userId: string, query: string): string {
  const hits: string[] = [];
  for (const rel of listWorkspace(userId)) {
    if (rel.length > 200) continue;
    try {
      const body = readFile(userId, rel);
      const lines = body.split("\n");
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(query.toLowerCase()) && hits.length < 40) {
          hits.push(`${rel}:${i + 1}:${line.trim().slice(0, 200)}`);
        }
      });
    } catch {
      /* binary */
    }
  }
  return hits.join("\n") || "(no hits)";
}

export function readBytes(userId: string, rel: string): Buffer {
  const root = workspace(userId);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root)) throw new Error("path");
  return fs.readFileSync(full);
}

export async function shell(userId: string, command: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  const cwd = workspace(userId);
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, timeout: 120000 });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve(out.slice(0, 80_000) + `\n[exit ${code}]`));
    child.on("error", (e) => resolve(String(e)));
  });
}

export function readFile(userId: string, rel: string) {
  const root = workspace(userId);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root)) throw new Error("path");
  return fs.readFileSync(full, "utf8");
}

export function writeFile(userId: string, rel: string, content: string) {
  writeBytes(userId, rel, Buffer.from(content, "utf8"));
}

export function writeBytes(userId: string, rel: string, buf: Buffer) {
  const root = workspace(userId);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root)) throw new Error("path");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
}

export function imageMime(rel: string) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}
