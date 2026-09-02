import fs from "node:fs";
import path from "node:path";

function req(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  agentModelBaseUrl: req("AGENT_MODEL_BASE_URL"),
  agentModelApiKey: req("AGENT_MODEL_API_KEY"),
  agentModelDefault: req("AGENT_MODEL_DEFAULT", "kimi-k3"),
  agentModelFlash: req("AGENT_MODEL_FLASH", "glm-5.3-flash"),
  agentModelPro: req("AGENT_MODEL_PRO", "gpt-5.6-terra"),
  imageModelBaseUrl: req("IMAGE_MODEL_BASE_URL"),
  imageModelApiKey: req("IMAGE_MODEL_API_KEY"),
  imageModel: req("IMAGE_MODEL", "gpt-image-2"),
  port: Number(req("JANUS_PORT", "8788")),
  listen: req("JANUS_LISTEN", "127.0.0.1"),
  publicUrl: req("PUBLIC_URL", "http://localhost:8788").replace(/\/$/, ""),
  databaseUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL", "redis://127.0.0.1:6379"),
  sessionSecret: req("SESSION_SECRET", "dev-only-change-me"),
  encryptionKey: req("ENCRYPTION_KEY", "dev-only-change-me-32bytes-key!!"),
  githubId: req("GITHUB_CLIENT_ID"),
  githubSecret: req("GITHUB_CLIENT_SECRET"),
  googleId: req("GOOGLE_CLIENT_ID"),
  googleSecret: req("GOOGLE_CLIENT_SECRET"),
  dataDir: req("JANUS_DATA", path.resolve("data")),
  webDir: req("JANUS_WEB", ""),
  skillsDir: req("JANUS_SKILLS") || skillsDir(),
  telegramToken: req("TELEGRAM_BOT_TOKEN"),
  telegramWebhookSecret: req("TELEGRAM_WEBHOOK_SECRET"),
};

function skillsDir() {
  const cands = [path.resolve("skills"), path.resolve("../../skills"), "/src/skills"];
  return cands.find((d) => fs.existsSync(d)) ?? path.resolve("skills");
}

export function ensureDirs() {
  fs.mkdirSync(path.join(config.dataDir, "computers"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "screens"), { recursive: true });
}
