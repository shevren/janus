import type { FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { config } from "./config.js";
import { hashToken, newToken } from "./crypto.js";
import { q, q1 } from "./db.js";

const COOKIE = "janus";

export type User = { id: string; email: string; name: string };

export async function createSession(reply: FastifyReply, userId: string) {
  const token = newToken();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await q(
    `insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)`,
    [userId, hashToken(token), expires.toISOString()],
  );
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicUrl.startsWith("https"),
    expires,
  });
}

export async function currentUser(req: FastifyRequest): Promise<User | null> {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const row = await q1<User & { expires_at: string }>(
    `select u.id, u.email, u.name, s.expires_at
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  const u = await currentUser(req);
  if (!u) {
    reply.code(401).send({ error: "auth" });
    return null;
  }
  return u;
}

export async function hashPassword(pw: string) {
  return argon2.hash(pw, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, pw: string) {
  return argon2.verify(hash, pw);
}

export async function clearSession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) await q(`delete from sessions where token_hash = $1`, [hashToken(token)]);
  reply.clearCookie(COOKIE, { path: "/" });
}

export { COOKIE };
