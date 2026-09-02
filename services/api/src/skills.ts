import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { q, q1 } from "./db.js";

const STUDY = `When explaining school or university work, show steps.
Cite sources when you searched. Do not impersonate the student
in a graded upload. Quiz only if asked.`;

const DAILY = `Help with time, units, money, search, and short facts.
Prefer now, convert, calc, wiki, and search_web before guessing.`;

export function bundledSkills(): { name: string; body: string }[] {
  const dir = config.skillsDir;
  const out: { name: string; body: string }[] = [];
  const seen = new Set<string>();
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      out.push({ name, body: fs.readFileSync(file, "utf8") });
      seen.add(name);
    }
  } catch {
    /* missing dir */
  }
  if (!seen.has("study")) out.push({ name: "study", body: STUDY });
  if (!seen.has("daily")) out.push({ name: "daily", body: DAILY });
  return out;
}

export async function seedDefaultSkills(userId: string) {
  const existing = await q1(`select 1 from skills where user_id = $1 limit 1`, [userId]);
  if (existing) return;
  const map = new Map(bundledSkills().map((s) => [s.name, s.body]));
  await q(`insert into skills (user_id, name, body) values ($1, 'study', $2)`, [userId, map.get("study") ?? STUDY]);
  await q(`insert into skills (user_id, name, body) values ($1, 'daily', $2)`, [userId, map.get("daily") ?? DAILY]);
}
