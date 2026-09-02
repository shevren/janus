import { catalogInstall, catalogSearch, catalogTools } from "./catalog.js";
import { calc, convert, nowIn, searchWebHttp, wiki } from "./daily.js";
import { q, q1 } from "./db.js";
import { githubTools, runGithub } from "./github.js";
import { callMcp, mcpTools } from "./mcp.js";
import { activeProvider, complete, lookImage, type ChatMsg, type ToolSpec } from "./providers.js";
import * as box from "./sandbox.js";
import { config } from "./config.js";

const WRITE_ACTIONS = /send|email|delete|rm |purchase|pay|publish|drop |truncate|install/i;

function applyPatch(before: string, patch: string): string {
  if (!patch.includes("@@")) return patch;
  const lines = patch.split("\n");
  const out: string[] = [];
  const src = before.split("\n");
  let i = 0;
  for (const l of lines) {
    if (l.startsWith("@@")) continue;
    if (l.startsWith("---") || l.startsWith("+++")) continue;
    if (l.startsWith("+")) out.push(l.slice(1));
    else if (l.startsWith("-")) i++;
    else if (l.startsWith(" ")) { out.push(src[i] ?? l.slice(1)); i++; }
    else if (l.trim() === "") out.push("");
  }
  return out.join("\n");
}

export type Surface = "web" | "telegram";
export type AgentMode = "ask" | "plan" | "build";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; status: string; output?: string }
  | { type: "approval"; id: string; action: string; detail?: string }
  | { type: "mode"; mode: AgentMode }
  | { type: "takeover"; url: string }
  | { type: "done" };

export function parseMode(v: unknown): AgentMode {
  return v === "plan" || v === "build" ? v : "ask";
}

const PLAN_READ = new Set([
  "plan",
  "workspace_read",
  "search_file",
  "search_web",
  "analyze_image",
  "now",
  "calc",
  "convert",
  "wiki",
  "github_repos",
  "github_tree",
  "github_file",
  "github_search",
  "catalog_search",
]);

function planTool(): ToolSpec {
  return {
    name: "plan",
    description:
      "Write a short plan: one goal and numbered steps. Not a novel. Required in Plan mode before you stop. In Ask, call this when the job is a multi-step build or debug.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string" },
        steps: { type: "array", items: { type: "string" } },
      },
      required: ["goal", "steps"],
    },
  };
}

function computerTools(): ToolSpec[] {
  return [
    {
      name: "computer_open",
      description: "Open a URL in the shared computer browser.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "computer_click",
      description: "Click at viewport coordinates.",
      parameters: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
    },
    {
      name: "computer_type",
      description: "Type into the focused element. Never type passwords; request takeover instead.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "computer_key",
      description: "Press a keyboard key such as Enter, Tab, Escape, or ArrowDown.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    {
      name: "computer_scroll",
      description: "Scroll the page. Positive y is down.",
      parameters: { type: "object", properties: { y: { type: "number" } }, required: ["y"] },
    },
    {
      name: "computer_screenshot",
      description: "Capture the current computer screen.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "read_page",
      description: "Read visible text from the current browser page.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "compose_cut",
      description: "Write a photo/video cut spec under /workspace/cuts. Remotion export is a later queued job.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          clips: { type: "array", items: { type: "object" } },
        },
        required: ["name", "clips"],
      },
    },
  ];
}

function sharedTools(searchDesc: string): ToolSpec[] {
  return [
    {
      name: "search_web",
      description: searchDesc,
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "workspace_read",
      description: "Read a file from /workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      name: "workspace_read_many",
      description: "Read multiple files from /workspace. Comma-separated paths.",
      parameters: { type: "object", properties: { paths: { type: "string" } }, required: ["paths"] },
    },
    {
      name: "workspace_list",
      description: "List files under /workspace. Optional dir, empty for root.",
      parameters: { type: "object", properties: { dir: { type: "string" } } },
    },
    {
      name: "workspace_write",
      description: "Write a file under /workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "workspace_write_patch",
      description: "Apply a unified diff patch to a file under /workspace. Provide path and patch text.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, patch: { type: "string" } },
        required: ["path", "patch"],
      },
    },
    {
      name: "search_file",
      description: "Search file contents under /workspace.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "generate_image",
      description: "Generate an image via configured image API. Saves to /workspace and returns file path.",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    },
    {
      name: "render_latex",
      description: "Render LaTeX formula to PNG. Provide latex string. Saves to /workspace/formula.png.",
      parameters: { type: "object", properties: { latex: { type: "string" } }, required: ["latex"] },
    },
    {
      name: "make_presentation",
      description: "Create a PowerPoint presentation from markdown content. Saves to /workspace/presentation.pptx.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        required: ["title", "content"],
      },
    },
    {
      name: "edit_image",
      description: "Edit image with ImageMagick commands. Provide input path and operations. Saves output.",
      parameters: {
        type: "object",
        properties: { input: { type: "string" }, ops: { type: "string" } },
        required: ["input", "ops"],
      },
    },
    {
      name: "analyze_image",
      description: "Look at a workspace image, or the live screen if path is empty.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, prompt: { type: "string" } },
      },
    },
    {
      name: "shell",
      description: "Run a command in the computer workspace. Destructive commands need approval.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    {
      name: "now",
      description: "Current date and time in a timezone (IANA name, default UTC).",
      parameters: { type: "object", properties: { tz: { type: "string" } } },
    },
    {
      name: "calc",
      description: "Evaluate a numeric expression.",
      parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
    },
    {
      name: "convert",
      description: "Convert units or currency. Currency uses a live USD table.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["amount", "from", "to"],
      },
    },
    {
      name: "wiki",
      description: "Read a Wikipedia summary.",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    },
    {
      name: "remember",
      description: "Store a short fact for this bot.",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    },
    ...githubTools(),
    ...catalogTools(),
  ];
}

function builtins(surface: Surface): ToolSpec[] {
  if (surface === "telegram") {
    return [planTool(), ...sharedTools("Search the web over HTTP (DuckDuckGo HTML). Never use a browser from Telegram.")];
  }
  return [
    planTool(),
    ...computerTools(),
    ...sharedTools("Search the web in the shared browser and return page text."),
  ];
}

function toolsFor(surface: Surface, mode: AgentMode, mcp: ToolSpec[]): ToolSpec[] {
  const all = [...builtins(surface), ...mcp];
  if (mode !== "plan") return all;
  return all.filter((t) => PLAN_READ.has(t.name));
}

function formatPlan(args: Record<string, unknown>): string {
  const goal = String(args.goal ?? "").trim() || "(no goal)";
  const steps = Array.isArray(args.steps) ? args.steps.map((s) => String(s).trim()).filter(Boolean) : [];
  const body = steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "1. (no steps)";
  return `Plan: ${goal}\n${body}`;
}

async function skillPrompt(userId: string, botId: string) {
  const rows = await q<{ name: string; body: string }>(
    `select s.name, s.body from skills s
     join bot_skills b on b.skill_id = s.id
     where b.bot_id = $1 and s.enabled = true
     union
     select s.name, s.body from skills s where s.user_id = $2 and s.enabled = true
       and not exists (select 1 from bot_skills x where x.bot_id = $1)`,
    [botId, userId],
  );
  if (!rows.length) return "";
  return rows.map((s) => `## Skill: ${s.name}\n${s.body}`).join("\n\n");
}

function needsApproval(name: string, args: Record<string, unknown>): boolean {
  if (name === "plan") return true;
  if (name === "catalog_install") return true;
  if (name === "github_commit") return true;
  if (name === "github_issue" && args.title) return true;
  if (name === "github_pr" && args.title) return true;
  return WRITE_ACTIONS.test(`${name} ${JSON.stringify(args)}`);
}

function modePrompt(surface: Surface, mode: AgentMode): string {
  const lines = [
    "You are a general agent for this person: daily life (search, study, time, units, chat) and software work (workspace files, GitHub, shell, skills, MCP). You are not a chatbot wrapper. You do the work.",
    surface === "telegram"
      ? "This turn is Telegram. You have no computer_* tools, no read_page, no compose_cut. search_web is HTTP only."
      : "You work on a shared computer: browser, /workspace files, and a shell. Prefer read_page after computer_open.",
  ];
  if (mode === "plan") {
    lines.push(
      "Mode: Plan. Inspect with read-only tools if needed, then call plan with a goal and numbered steps. Do not mutate files, git, or installs. After the user allows the plan, stop and wait for Build.",
    );
  } else if (mode === "build") {
    lines.push(
      "Mode: Build. Execute. Follow the last accepted Plan in this conversation if one exists. Do not re-plan unless the goal changed. Writes still pause for Allow once.",
    );
  } else {
    lines.push(
      "Mode: Ask. Answer. Use tools when they help. If the job is a multi-step build or debug, call plan (or tell them to switch to Plan). Do not start a large mutation unasked.",
    );
  }
  return lines.join("\n");
}

export async function runAgent(opts: {
  userId: string;
  botId: string;
  conversationId: string;
  text: string;
  surface?: Surface;
  mode?: AgentMode;
  emit: (e: AgentEvent) => void;
}) {
  const surface: Surface = opts.surface ?? "web";
  const mode: AgentMode = parseMode(opts.mode);
  const bot = await q1<{ name: string; title: string; description: string }>(
    `select name, title, description from bots where id = $1 and user_id = $2`,
    [opts.botId, opts.userId],
  );
  const provider = await activeProvider(opts.userId);
  if (!provider) {
    opts.emit({ type: "text", text: "No model provider is configured. Add a key under Models." });
    opts.emit({ type: "done" });
    return;
  }
  const history = await q<{ role: string; content: string }>(
    `select role, content from messages where conversation_id = $1 order by created_at asc`,
    [opts.conversationId],
  );
  const skills = await skillPrompt(opts.userId, opts.botId);
  const memories = await q<{ content: string }>(
    `select content from memories where bot_id = $1 order by created_at desc limit 20`,
    [opts.botId],
  );
  let mcp = await mcpTools(opts.userId);
  let tools: ToolSpec[] = toolsFor(surface, mode, mcp);

  const system = [
    `You are ${bot?.name ?? "a Janus bot"}, ${bot?.title ?? "an agent"}.`,
    bot?.description ?? "",
    modePrompt(surface, mode),
    "Never ask the user to paste an MCP URL or a skill file. If they want a server or skill, catalog_search, propose a match, then catalog_install. You are the installer. Settings is for enable, disable, and disconnect.",
    "Do not run remote install scripts or curl|bash. Prefer mcp.json, SKILL.md, or an npx MCP package.",
    "Never ask for a password in chat. If a site needs a human (login, 2FA, captcha, Cloudflare challenge), call computer_screenshot and stop for takeover.",
    "Do not send, delete, pay, publish, or install without an approval gate. Those tools will pause.",
    skills,
    memories.length ? `Known facts:\n${memories.map((m) => `- ${m.content}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: ChatMsg[] = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role as ChatMsg["role"], content: m.content })),
  ];

  await q(`insert into messages (conversation_id, role, content) values ($1, 'user', $2)`, [
    opts.conversationId,
    opts.text,
  ]);
  messages.push({ role: "user", content: opts.text });
  opts.emit({ type: "mode", mode });

  let assistantText = "";
  let held = false;
  const maxSteps = mode === "build" ? 24 : mode === "plan" ? 8 : 12;
  try {
    for (let step = 0; step < maxSteps; step++) {
      const out = await complete(provider, messages, tools);
      if (out.text) {
        assistantText += out.text;
        opts.emit({ type: "text", text: out.text });
      }
      if (!out.toolCalls.length) break;
      messages.push({ role: "assistant", content: out.text || "" });
      let stopAfterPlan = false;
      for (const call of out.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }
        if (needsApproval(call.name, args)) {
          const detail = call.name === "plan" ? formatPlan(args) : undefined;
          const ap = await q1<{ id: string }>(
            `insert into approvals (user_id, bot_id, action, payload) values ($1, $2, $3, $4) returning id`,
            [opts.userId, opts.botId, call.name, JSON.stringify(args)],
          );
          if (detail) opts.emit({ type: "text", text: detail });
          opts.emit({ type: "approval", id: ap!.id, action: call.name, detail });
          const ok = await waitApproval(ap!.id);
          if (!ok) {
            messages.push({ role: "tool", name: call.id, content: "denied by user" });
            opts.emit({ type: "tool", name: call.name, status: "denied" });
            continue;
          }
        }
        opts.emit({ type: "tool", name: call.name, status: "running" });
        const result = await runTool({
          userId: opts.userId,
          botId: opts.botId,
          surface,
          name: call.name,
          args,
          mcp,
        });
        if (result.takeover) {
          held = true;
          opts.emit({ type: "takeover", url: result.takeover });
        }
        opts.emit({ type: "tool", name: call.name, status: "ok", output: result.output.slice(0, 4000) });
        messages.push({ role: "tool", name: call.id, content: result.output });
        if (call.name === "catalog_install") {
          mcp = await mcpTools(opts.userId);
          tools = toolsFor(surface, mode, mcp);
        }
        if (call.name === "plan") {
          stopAfterPlan = mode !== "build";
        }
        if (result.takeover) {
          assistantText += assistantText ? "\nNeeds you on the computer." : "Needs you on the computer.";
          opts.emit({ type: "text", text: "Needs you on the computer." });
          return;
        }
      }
      if (stopAfterPlan) break;
    }
  } finally {
    if (!held) await box.setDriver(opts.userId, "idle").catch(() => {});
    await q(`insert into messages (conversation_id, role, content) values ($1, 'assistant', $2)`, [
      opts.conversationId,
      assistantText || (mode === "plan" ? "(plan ready)" : "(done)"),
    ]);
    opts.emit({ type: "done" });
  }
}

async function waitApproval(id: string) {
  for (let i = 0; i < 600; i++) {
    const row = await q1<{ status: string }>(`select status from approvals where id = $1`, [id]);
    if (row?.status === "allowed") return true;
    if (row?.status === "denied") return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function drive(
  userId: string,
  activity: string,
  fn: () => Promise<{ output: string; takeover?: string }>,
) {
  await box.waitIfUserDriving(userId);
  await box.setDriver(userId, "agent", activity);
  return fn();
}

async function runTool(opts: {
  userId: string;
  botId: string;
  surface: Surface;
  name: string;
  args: Record<string, unknown>;
  mcp: { name: string }[];
}): Promise<{ output: string; takeover?: string }> {
  const { userId, name, args, mcp, surface } = opts;
  try {
    if (name === "plan") {
      return { output: `${formatPlan(args)}\nAllowed. Switch to Build to execute, or keep going if you are already in Build.` };
    }
    if (name === "computer_open") {
      return drive(userId, name, async () => {
        await box.browse(userId, String(args.url ?? ""));
        const slot = await box.getSlot(userId);
        const title = await slot.page.title();
        const url = slot.page.url();
        if (box.isChallenge(title, url)) {
          return { output: `Human challenge at ${url}`, takeover: url };
        }
        return { output: `opened ${url} (${title})` };
      });
    }
    if (name === "computer_click") {
      return drive(userId, name, async () => {
        await box.clickAt(userId, Number(args.x), Number(args.y));
        return { output: "clicked" };
      });
    }
    if (name === "computer_type") {
      return drive(userId, name, async () => {
        await box.typeText(userId, String(args.text ?? ""));
        return { output: "typed" };
      });
    }
    if (name === "computer_key") {
      return drive(userId, name, async () => {
        await box.keyPress(userId, String(args.key ?? "Enter"));
        return { output: "key" };
      });
    }
    if (name === "computer_scroll") {
      return drive(userId, name, async () => {
        await box.scroll(userId, Number(args.y ?? 400));
        return { output: "scrolled" };
      });
    }
    if (name === "computer_screenshot") {
      return drive(userId, name, async () => {
        await box.snapshot(userId);
        const slot = await box.getSlot(userId);
        const title = await slot.page.title();
        const url = slot.page.url();
        if (box.isChallenge(title, url)) {
          return { output: `Human challenge at ${url}`, takeover: url };
        }
        return { output: `screen ${url}` };
      });
    }
    if (name === "read_page") {
      return drive(userId, name, async () => {
        const page = await box.pageText(userId);
        if (page.challenge) {
          return { output: `Human challenge at ${page.url}`, takeover: page.url };
        }
        return { output: `${page.title}\n${page.url}\n\n${page.text}` };
      });
    }
    if (name === "search_web") {
      if (surface === "telegram") {
        return { output: await searchWebHttp(String(args.query ?? "")) };
      }
      return drive(userId, name, async () => {
        const page = await box.searchWeb(userId, String(args.query ?? ""));
        if (page.challenge) {
          return { output: `Human challenge at ${page.url}`, takeover: page.url };
        }
        return { output: `${page.title}\n${page.url}\n\n${page.text}` };
      });
    }
    if (name === "workspace_read") {
      return { output: box.readFile(userId, String(args.path)) };
    }
    if (name === "workspace_read_many") {
      const raw = String(args.paths ?? "");
      const paths = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const out = paths.map((p) => `--- ${p} ---\n${box.readFile(userId, p)}`).join("\n\n");
      return { output: out || "(no files)" };
    }
    if (name === "workspace_list") {
      const dir = String(args.dir ?? "").trim();
      return { output: box.listFiles(userId, dir) };
    }
    if (name === "workspace_write") {
      box.writeFile(userId, String(args.path), String(args.content ?? ""));
      return { output: "wrote" };
    }
    if (name === "workspace_write_patch") {
      const p = String(args.path);
      const patch = String(args.patch ?? "");
      const before = box.readFile(userId, p);
      const after = applyPatch(before, patch);
      box.writeFile(userId, p, after);
      return { output: `patched ${p}` };
    }
    if (name === "search_file") {
      return { output: box.searchFiles(userId, String(args.query ?? "")) };
    }
    if (name === "generate_image") {
      const prompt = String(args.prompt ?? "");
      if (!config.imageModelApiKey || !config.imageModelBaseUrl) {
        return { output: "Image API not configured. Set IMAGE_MODEL_API_KEY and IMAGE_MODEL_BASE_URL." };
      }
      try {
        const res = await fetch(`${config.imageModelBaseUrl}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.imageModelApiKey}` },
          body: JSON.stringify({ model: config.imageModel, prompt, n: 1, size: "1024x1024" }),
        });
        const data = await res.json();
        const url = data.data?.[0]?.url;
        if (url) {
          const img = await fetch(url);
          const buf = Buffer.from(await img.arrayBuffer());
          box.writeBytes(userId, `images/${Date.now()}.png`, buf);
          return { output: `Image generated: /workspace/images/${Date.now()}.png` };
        }
        return { output: "Image generation failed: no URL" };
      } catch (e) {
        return { output: `Image generation error: ${String(e)}` };
      }
    }
    if (name === "render_latex") {
      const latex = String(args.latex ?? "");
      if (!latex.trim()) return { output: "No latex provided" };
      const safe = latex.replace(/'/g, "'\\''").replace(/"/g, '\\"');
      const out = await box.shell(userId, `cd /workspace && cat > formula.tex <<'EOF'
\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\[
${safe}
\\]
\\end{document}
EOF
pdflatex -interaction=nonstopmode -output-directory=/workspace formula.tex 2>&1 | tail -20`);
      if (out.includes("formula.pdf")) {
        await box.shell(userId, "cd /workspace && convert -density 300 -background white -alpha remove formula.pdf formula.png 2>&1");
        return { output: "LaTeX rendered: /workspace/formula.png" };
      }
      return { output: "LaTeX render failed: " + out.slice(-200) };
    }
    if (name === "make_presentation") {
      const title = String(args.title ?? "Presentation");
      const content = String(args.content ?? "");
      const md = `---\ntitle: ${title.replace(/"/g, '\\"')}\n---\n\n${content}`;
      box.writeFile(userId, "presentation.md", md);
      const out = await box.shell(userId, "cd /workspace && pandoc -t pptx -o presentation.pptx presentation.md 2>&1");
      if (out.includes("presentation.pptx") || !out.includes("Error")) {
        return { output: "Presentation created: /workspace/presentation.pptx" };
      }
      return { output: "Presentation failed: " + out.slice(-200) };
    }
    if (name === "edit_image") {
      const input = String(args.input ?? "");
      const ops = String(args.ops ?? "");
      if (!input.includes("/workspace/")) {
        return { output: "Input must be a workspace path like /workspace/inbox/photo.png" };
      }
      const output = input.replace(/\.(png|jpg|jpeg|gif)$/i, "_edited.$1");
      const safeOps = ops.replace(/"/g, '\\"');
      const out = await box.shell(userId, `cd /workspace && convert "${input.replace("/workspace/", "")}" ${safeOps} "${output.replace("/workspace/", "")}" 2>&1`);
      return { output: out.includes(output.split("/").pop() ?? "") ? `Image edited: ${output}` : `Edit failed: ${out.slice(-200)}` };
    }
    if (name === "analyze_image") {
      const provider = await activeProvider(userId);
      if (!provider) return { output: "No model provider is configured." };
      const rel = String(args.path ?? "").trim();
      const buf = rel ? box.readBytes(userId, rel) : await box.snapshot(userId);
      const mime = rel ? box.imageMime(rel) : "image/png";
      const text = await lookImage(provider, buf, mime, String(args.prompt ?? ""));
      return { output: text || "(empty look)" };
    }
    if (name === "compose_cut") {
      const nameHint = String(args.name ?? "cut").replace(/[^\w.-]+/g, "-");
      const spec = {
        name: nameHint,
        clips: args.clips ?? [],
        created_at: new Date().toISOString(),
      };
      const rel = `cuts/${nameHint}.json`;
      box.writeFile(userId, rel, JSON.stringify(spec, null, 2));
      return { output: `wrote /workspace/${rel}. Remotion render is queued later so it does not fight the browser.` };
    }
    if (name === "shell") {
      return { output: await box.shell(userId, String(args.command ?? "")) };
    }
    if (name === "now") {
      return { output: nowIn(String(args.tz ?? "UTC")) };
    }
    if (name === "calc") {
      return { output: calc(String(args.expr ?? "")) };
    }
    if (name === "convert") {
      return { output: await convert(Number(args.amount), String(args.from ?? ""), String(args.to ?? "")) };
    }
    if (name === "wiki") {
      return { output: await wiki(String(args.title ?? "")) };
    }
    if (name === "remember") {
      await q(`insert into memories (bot_id, content) values ($1, $2)`, [opts.botId, String(args.content ?? "")]);
      return { output: "remembered" };
    }
    if (name === "catalog_search") {
      const kind = String(args.kind ?? "any");
      const k = kind === "mcp" || kind === "skill" ? kind : "any";
      return { output: await catalogSearch(userId, String(args.query ?? ""), k) };
    }
    if (name === "catalog_install") {
      return { output: await catalogInstall(userId, args) };
    }
    if (name.startsWith("github_")) {
      return { output: await runGithub(userId, name, args) };
    }
    if (mcp.some((t) => t.name === name) || name.startsWith("mcp_")) {
      return { output: await callMcp(userId, name, args) };
    }
    return { output: `unknown tool ${name}` };
  } catch (e) {
    return { output: String(e) };
  }
}
