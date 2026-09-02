import { buildApp } from "./app.js";
import { config, ensureDirs } from "./config.js";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";
import { startScheduler } from "./scheduler.js";
import { registerTelegramWebhook } from "./telegram.js";

async function main() {
  if (!config.databaseUrl) {
    console.error("DATABASE_URL missing");
    process.exit(1);
  }
  ensureDirs();
  await pool.query("select 1");
  await migrate();
  const app = await buildApp();
  startScheduler();
  await app.listen({ port: config.port, host: config.listen });
  await registerTelegramWebhook().catch((e) => console.error("telegram webhook", e));
  console.log(`janus ${config.listen}:${config.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
