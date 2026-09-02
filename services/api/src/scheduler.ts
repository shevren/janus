import { CronExpressionParser } from "cron-parser";
import { q } from "./db.js";
import { runAgent } from "./agent.js";

export function startScheduler() {
  setInterval(() => {
    tick().catch(() => {});
  }, 30_000);
}

async function tick() {
  const rows = await q<{
    id: string;
    bot_id: string;
    cron_expr: string;
    timezone: string;
    instructions: string;
    last_run_at: string | null;
  }>(`select r.*, b.user_id from routines r join bots b on b.id = r.bot_id where r.enabled = true`);
  const now = new Date();
  for (const r of rows as Array<(typeof rows)[0] & { user_id: string }>) {
    try {
      const expr = CronExpressionParser.parse(r.cron_expr, {
        tz: r.timezone,
        currentDate: r.last_run_at ?? new Date(0),
      });
      const next = expr.next().toDate();
      if (next > now) continue;
      const conv = await q<{ id: string }>(
        `insert into conversations (user_id, bot_id)
         values ($1, $2) on conflict (user_id, bot_id) do update set bot_id = excluded.bot_id
         returning id`,
        [r.user_id, r.bot_id],
      );
      await q(`update routines set last_run_at = now() where id = $1`, [r.id]);
      await runAgent({
        userId: r.user_id,
        botId: r.bot_id,
        conversationId: conv[0].id,
        text: r.instructions,
        emit: () => {},
        surface: "web",
        mode: "build",
      });
    } catch {
      // skip bad cron
    }
  }
}
