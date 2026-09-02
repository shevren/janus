<p align="center"><img src="assets/logo.svg?v=4" width="200" alt="Janus"></p>

<p align="center">
  <a href="https://github.com/shevren/janus/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/shevren/janus/ci.yml?label=ci&labelColor=0B0B0C&color=2C2C32&style=flat" alt="ci"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-0B0B0C?labelColor=0B0B0C&color=2C2C32" alt="license"></a>
  <a href="https://github.com/shevren/janus/stargazers"><img src="https://img.shields.io/github/stars/shevren/janus?label=stars&labelColor=0B0B0C&color=2C2C32&style=flat" alt="stars"></a>
  <a href="https://github.com/shevren/janus/network/members"><img src="https://img.shields.io/github/forks/shevren/janus?label=forks&labelColor=0B0B0C&color=2C2C32&style=flat" alt="forks"></a>
</p>

Your cloud computer on your phone.

Janus runs a computer you control from the web or Telegram. Each agent shares the same browser, workspace, and shell. Send a job, take over when a human is needed.

- Browser, files, and shell with approval gates
- Web search, page read, and image look
- GitHub read and write after approval
- MCP servers and skills installed from chat
- Memory and scheduled routines

## Modes

**Ask** for answers. **Plan** for a short numbered plan that waits for Allow. **Build** to execute.

## Run

```bash
cp .env.example .env
docker compose -f deploy/compose.yml up --build
```

Open `http://localhost:8788`.

For a server, set `PUBLIC_URL` to the public origin and ensure DNS points there.

## Telegram

One bot for everyone: **@JanusWorkBot**.

Link it once: Settings > Channels > Telegram > Link, open the bot link, press Start. The bot attaches to your Janus account.

After that, in any group you are in, type `@JanusWorkBot` followed by your request, or use `/ask` `/plan` `/build` if the bot is in the group. The request is handled on your private computer, not the group server.

Without adding the bot to a group: use inline mode. Type `@JanusWorkBot <your request>` in any chat, pick the result, and the answer appears as your message via the bot.

With the bot in a group: add it, disable privacy in BotFather, then `/ask` is auto-deleted after processing and the answer is posted.

See `services/api/src/telegram.ts` for the implementation. Inline, business, and userbot options are documented there.

## Layout

- `apps/web` web app
- `apps/android` phone shell
- `services/api` auth, bots, models, agent, sandbox
- `packages/tokens` design tokens
- `deploy` compose and nginx

## License

Apache-2.0. See [LICENSE](LICENSE).