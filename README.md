<p align="center"><img src="assets/logo.svg" width="200" alt="Janus"></p>

<p align="center">
  <a href="https://github.com/shevren/janus/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/shevren/janus/ci.yml?label=ci&labelColor=0B0B0C&color=2C2C32&style=flat" alt="ci"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-0B0B0C?labelColor=0B0B0C&color=2C2C32" alt="license"></a>
  <a href="https://github.com/shevren/janus/stargazers"><img src="https://img.shields.io/github/stars/shevren/janus?label=stars&labelColor=0B0B0C&color=2C2C32&style=flat" alt="stars"></a>
  <a href="https://github.com/shevren/janus/network/members"><img src="https://img.shields.io/github/forks/shevren/janus?label=forks&labelColor=0B0B0C&color=2C2C32&style=flat" alt="forks"></a>
</p>

Your cloud computer on your phone. Agents with a shared computer. Send a job, take over when a human is needed.

One computer per account. Browser, workspace, and shell are shared across agents. Approvals pause writes.

## Capabilities

- Browser, files, shell with approval gates
- Search, page read, image look
- GitHub create repo, write files, deploy
- MCP servers and skills from chat
- Memory and routines

## Modes

**Ask** answers. **Plan** writes a short plan and waits. **Build** executes.

## Run

```bash
cp .env.example .env
docker compose -f deploy/compose.yml up --build
```

Local: `http://localhost:8788`. Server: set `PUBLIC_URL`.

## Telegram

One bot: **@JanusWorkBot**.

Link: Settings > Channels > Telegram > Link, press Start. Then mention `@JanusWorkBot` or use `/ask` `/plan` `/build` in groups. Without adding the bot, use inline mode.

See `services/api/src/telegram.ts`.

## License

Apache-2.0. See [LICENSE](LICENSE).
