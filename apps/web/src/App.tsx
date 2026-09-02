import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Pin, Plug, Send } from "lucide-react";
import { api, type AgentMode, type Bot, type Msg, type Provider } from "./api";
import { GitHubMark, GoogleMark, Mark } from "./mark";
import { toolIcon, toolLabel } from "./toolIcons";

type Me = { id: string; email: string; name: string };
type ChannelState = {
  github: { login: string; scopes: string } | null;
  telegram: { username: string | null } | null;
  telegramBot: string | null;
};
type SkillRow = { id: string; name: string; body: string; enabled: boolean };
type McpRow = { id: string; name: string; transport: string; enabled: boolean };

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  if (me === undefined) return null;
  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" /> : <Login onIn={() => location.reload()} />} />
      <Route path="/*" element={me ? <Shell me={me} /> : <Navigate to="/login" />} />
    </Routes>
  );
}

function Login({ onIn }: { onIn: () => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [err, setErr] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = JSON.stringify({
      email: fd.get("email"),
      password: fd.get("password"),
      name: fd.get("name") || "",
    });
    try {
      await api(mode === "in" ? "/api/auth/login" : "/api/auth/register", { method: "POST", body });
      onIn();
    } catch {
      setErr(mode === "in" ? "Wrong email or password." : "Could not create the account.");
    }
  }
  return (
    <div className="auth">
      <div className="auth-spacer">
        <Mark size={40} title="Janus" />
      </div>
      <div className="auth-form">
        <Mark size={40} title="Janus" />
        <h1>Janus</h1>
        <p className="note">Named agents. One computer. Work that finishes.</p>
        <form onSubmit={submit}>
          {mode === "up" && (
            <>
              <label>Name</label>
              <input name="name" autoComplete="name" />
            </>
          )}
          <label>Email</label>
          <input name="email" type="email" required autoComplete="email" />
          <label>Password</label>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
          />
          {err && <p className="note">{err}</p>}
          <div className="auth-actions">
            <button className="btn" type="submit">
              {mode === "in" ? "Continue" : "Create account"}
            </button>
            <button className="btn ghost" type="button" onClick={() => setMode(mode === "in" ? "up" : "in")}>
              {mode === "in" ? "Need an account" : "Have an account"}
            </button>
          </div>
        </form>
        <div className="oauth">
          <a href="/api/auth/github">
            <GitHubMark size={18} />
            GitHub
          </a>
          <a href="/api/auth/google">
            <GoogleMark size={18} />
            Google
          </a>
        </div>
      </div>
    </div>
  );
}

function Shell({ me }: { me: Me }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [tab, setTab] = useState<"thread" | "machine">("thread");
  const nav = useNavigate();
  const loc = useLocation();
  async function load() {
    setBots(await api<Bot[]>("/api/bots"));
  }
  useEffect(() => {
    load().catch(() => {});
  }, []);
  async function add() {
    const b = await api<Bot>("/api/bots", {
      method: "POST",
      body: JSON.stringify({ name: "New agent", title: "untitled", description: "" }),
    });
    await load();
    nav(`/b/${b.id}`);
  }
  const inBot = loc.pathname.startsWith("/b/");
  return (
    <div className={`shell ${inBot ? `${tab}-tab` : ""}`}>
      <aside className="roster">
        <div className="brand">
          <Mark size={28} title="Janus" />
          Janus
        </div>
        {bots.map((b) => (
          <Link key={b.id} className={`row ${loc.pathname === `/b/${b.id}` ? "active" : ""}`} to={`/b/${b.id}`}>
            {b.pinned ? <Pin className="pin" size={16} strokeWidth={1.5} /> : <span className="pin" />}
            <div className="name">{b.name}</div>
            <div className="title">{b.last_message?.slice(0, 72) || b.title || "idle"}</div>
          </Link>
        ))}
        <div className="roster-foot">
          <button className="btn ghost" onClick={add}>
            New agent
          </button>
          <p className="note">{me.email}</p>
          <Link to="/settings">Channels</Link>
          <button
            className="btn ghost"
            onClick={async () => {
              await api("/api/auth/logout", { method: "POST" });
              location.href = "/login";
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <Routes>
        <Route path="/" element={<Empty />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/b/:id" element={<Thread bots={bots} />} />
      </Routes>
      {inBot && (
        <div className="tabs">
          <button className={tab === "thread" ? "on" : ""} onClick={() => setTab("thread")}>
            Transcript
          </button>
          <button className={tab === "machine" ? "on" : ""} onClick={() => setTab("machine")}>
            Computer
          </button>
        </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <Mark size={48} title="Janus" />
      <h2>Pick an agent, or start one.</h2>
      <p className="note">They share one computer. A login on the machine is available to the whole roster.</p>
    </div>
  );
}

function Thread({ bots }: { bots: Bot[] }) {
  const { id } = useParams();
  const bot = bots.find((b) => b.id === id);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [live, setLive] = useState("");
  const [steps, setSteps] = useState<{ name: string; status: string; output?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [agentOnComputer, setAgentOnComputer] = useState(false);
  const [mode, setMode] = useState<AgentMode>(bot?.mode ?? "ask");
  const [pending, setPending] = useState<{ id: string; action: string; detail?: string }[]>([]);
  useEffect(() => {
    setMode(bot?.mode ?? "ask");
  }, [bot?.mode, id]);
  useEffect(() => {
    if (!id) return;
    api<Msg[]>(`/api/bots/${id}/messages`).then(setMsgs).catch(() => setMsgs([]));
    setLive("");
    setSteps([]);
    setPending([]);
  }, [id]);
  async function pickMode(next: AgentMode) {
    setMode(next);
    if (!id) return;
    await api(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ mode: next }) }).catch(() => {});
  }
  async function resolve(idAp: string, status: "allowed" | "denied") {
    await api(`/api/approvals/${idAp}`, { method: "POST", body: JSON.stringify({ status }) });
    setPending((p) => p.filter((x) => x.id !== idAp));
  }
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const text = String(fd.get("text") ?? "").trim();
    if (!text || !id) return;
    e.currentTarget.reset();
    setBusy(true);
    setSteps([]);
    setPending([]);
    setAgentOnComputer(false);
    setMsgs((m) => [...m, { id: "tmp", role: "user", content: text, created_at: new Date().toISOString() }]);
    const r = await fetch(`/api/bots/${id}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode }),
    });
    const reader = r.body?.getReader();
    const dec = new TextDecoder();
    let acc = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6)) as {
            type: string;
            text?: string;
            name?: string;
            status?: string;
            output?: string;
            id?: string;
            action?: string;
            detail?: string;
            mode?: AgentMode;
          };
          if (ev.type === "text" && ev.text) {
            acc += ev.text;
            setLive(acc);
          }
          if (ev.type === "mode" && ev.mode) setMode(ev.mode);
          if (ev.type === "approval" && ev.id) {
            setPending((p) => [...p, { id: ev.id!, action: ev.action ?? "action", detail: ev.detail }]);
          }
          if (ev.type === "tool" && ev.name) {
            if (ev.name.startsWith("computer_") || ev.name === "read_page" || ev.name === "search_web") {
              setAgentOnComputer(true);
            }
            setSteps((s) => {
              const next = [...s];
              const i = next.findIndex((x) => x.name === ev.name && x.status === "running");
              if (i >= 0) next[i] = { name: ev.name, status: ev.status ?? "ok", output: ev.output };
              else next.push({ name: ev.name, status: ev.status ?? "running", output: ev.output });
              return next;
            });
          }
          if (ev.type === "takeover") setAgentOnComputer(true);
          if (ev.type === "done") setAgentOnComputer(false);
        }
      }
    }
    setLive("");
    setBusy(false);
    setMsgs(await api<Msg[]>(`/api/bots/${id}/messages`));
  }
  const hint = mode === "plan" ? "Describe the job to plan" : mode === "build" ? "Execute" : "Give it a job";
  return (
    <>
      <section className="thread" key={id}>
        <div className="thread-head">
          <h2>{bot?.name ?? "-"}</h2>
          <div className="title">{bot?.title}</div>
          <div className="modes" role="tablist" aria-label="Mode">
            {(["ask", "plan", "build"] as AgentMode[]).map((m) => (
              <button key={m} type="button" role="tab" className={mode === m ? "on" : ""} onClick={() => pickMode(m)}>
                {m === "ask" ? "Ask" : m === "plan" ? "Plan" : "Build"}
              </button>
            ))}
          </div>
        </div>
        <div className="msgs">
          {msgs.map((m) => (
            <div key={m.id} className={`msg ${m.role === "user" ? "user" : "bot"}`}>
              {m.content}
            </div>
          ))}
          {live && <div className="msg bot">{live}</div>}
          {steps.length > 0 && (
            <ul className="steps">
              {steps.map((s, i) => {
                const Icon = toolIcon(s.name);
                return (
                  <li key={`${s.name}-${i}`}>
                    <Icon size={16} strokeWidth={1.5} />
                    <span>{toolLabel(s.name)}</span>
                    <span>{s.status}</span>
                    {s.output && <span className="out">{s.output}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {pending.map((g) => (
            <div className="gate" key={g.id}>
              <p>
                {g.detail || g.action}
              </p>
              <button className="btn" type="button" onClick={() => resolve(g.id, "allowed")}>
                Allow once
              </button>
              <button className="btn ghost" type="button" onClick={() => resolve(g.id, "denied")}>
                Deny
              </button>
            </div>
          ))}
        </div>
        <div className="composer">
          <form onSubmit={send}>
            <textarea name="text" rows={2} placeholder={busy ? "Working" : hint} disabled={busy} />
            <button className="btn" disabled={busy}>
              Send
            </button>
          </form>
        </div>
      </section>
      <Computer agentLocked={agentOnComputer && busy} />
    </>
  );
}

function Computer({ agentLocked }: { agentLocked: boolean }) {
  const [src, setSrc] = useState("/api/computer/screen.png");
  const [info, setInfo] = useState<{ status?: string; last_url?: string; takeover?: boolean }>({});
  const [userControl, setUserControl] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      setSrc(`/api/computer/screen.png?t=${Date.now()}`);
      api<{ status?: string; last_url?: string; takeover?: boolean }>("/api/computer")
        .then(setInfo)
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, []);
  const locked = (agentLocked || info.takeover) && !userControl;
  function click(e: React.MouseEvent<HTMLDivElement>) {
    if (locked) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 1280);
    const y = Math.round(((e.clientY - r.top) / r.height) * 800);
    api("/api/computer/input", { method: "POST", body: JSON.stringify({ type: "click", x, y }) }).catch(() => {});
  }
  async function takeOver() {
    setUserControl(true);
    await api("/api/computer/takeover", { method: "POST", body: JSON.stringify({ on: true }) });
  }
  async function giveBack() {
    setUserControl(false);
    await api("/api/computer/takeover", { method: "POST", body: JSON.stringify({ on: false }) });
  }
  return (
    <aside className="computer">
      <header>
        <span className="mono">{userControl ? "you" : locked ? "agent" : info.status ?? "idle"}</span>
        <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {info.last_url ?? "computer"}
        </span>
        {userControl && (
          <button className="btn ghost" onClick={giveBack}>
            Return control
          </button>
        )}
      </header>
      <div className={`screen-wrap ${userControl ? "live" : ""}`}>
        <div className="screen" onClick={click} style={{ backgroundImage: `url(${src})` }} />
        {locked && (
          <div className="lock">
            <button type="button" onClick={takeOver}>
              Take over
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function Settings() {
  const [models, setModels] = useState<Provider[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [mcp, setMcp] = useState<McpRow[]>([]);
  const [approvals, setApprovals] = useState<{ id: string; action: string; status: string }[]>([]);
  const [routines, setRoutines] = useState<{ id: string; name: string; cron_expr: string; enabled: boolean }[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [channels, setChannels] = useState<ChannelState | null>(null);
  const [tgLink, setTgLink] = useState("");
  const [dropGh, setDropGh] = useState(false);
  async function reload() {
    setModels(await api("/api/models"));
    setSkills(await api("/api/skills"));
    setMcp(await api("/api/mcp"));
    setApprovals(await api("/api/approvals"));
    setRoutines(await api("/api/routines"));
    setBots(await api("/api/bots"));
    setChannels(await api("/api/channels"));
  }
  useEffect(() => {
    reload().catch(() => {});
  }, []);
  return (
    <div className="settings">
      <div className="settings-head">
        <Mark size={28} title="Janus" />
        <h2>Settings</h2>
      </div>

      <section className="section">
        <h3>Channels</h3>
        <p className="note lede">
          Ask the agent in chat to install an MCP server or a skill. This page shows what is on. Paste is
          optional, under Advanced. Thread modes: Ask answers, Plan writes a short plan, Build executes.
        </p>
        <div className="channel">
          <GitHubMark size={20} />
          <div className="meta">
            <span>GitHub</span>
            <span className="note">
              {channels?.github ? `${channels.github.login} · ${channels.github.scopes || "repo"}` : "Not connected"}
            </span>
          </div>
          <div className="actions">
            {channels?.github ? (
              <button className="btn ghost" onClick={() => setDropGh(true)}>
                Disconnect
              </button>
            ) : (
              <a className="btn" href="/api/channels/github">
                Connect
              </a>
            )}
          </div>
        </div>
        {dropGh && (
          <div className="confirm">
            <p>Drops the repo token. Git tools stop until you connect again.</p>
            <button
              className="btn danger"
              onClick={async () => {
                await api("/api/channels/github", { method: "DELETE" });
                setDropGh(false);
                reload();
              }}
            >
              Disconnect GitHub
            </button>
            <button className="btn ghost" onClick={() => setDropGh(false)}>
              Keep
            </button>
          </div>
        )}
        <div className="channel">
          <Send size={20} strokeWidth={1.5} />
          <div className="meta">
            <span>Telegram</span>
            <span className="note">
              {channels?.telegram
                ? `@${channels.telegram.username || "linked"}`
                : channels?.telegramBot
                  ? `Instance bot @${channels.telegramBot}`
                  : "Bot token unset on this server"}
            </span>
          </div>
          <div className="actions">
            {channels?.telegram ? (
              <button
                className="btn ghost"
                onClick={async () => {
                  await api("/api/channels/telegram", { method: "DELETE" });
                  setTgLink("");
                  reload();
                }}
              >
                Disconnect
              </button>
            ) : (
              <button
                className="btn ghost"
                disabled={!channels?.telegramBot}
                onClick={async () => {
                  const r = await api<{ url: string }>("/api/channels/telegram/link", { method: "POST" });
                  setTgLink(r.url);
                }}
              >
                Link
              </button>
            )}
          </div>
        </div>
        {tgLink && (
          <p className="note tg-link mono">
            Open {tgLink} in Telegram. The agent there can install MCP and skills the same way.
          </p>
        )}
      </section>

      <section className="section">
        <h3>Models</h3>
        <p className="note lede">Keys stay encrypted on this server.</p>
        {models.map((m) => (
          <div className="line" key={m.id}>
            <div className="meta">
              <span>{m.name}</span>
              <span className="note mono">
                {m.kind} · {m.default_model}
              </span>
            </div>
            <div className="actions">
              <button
                className="btn ghost"
                onClick={async () => {
                  await api(`/api/models/${m.id}`, { method: "DELETE" });
                  reload();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <ModelForm onDone={reload} />
      </section>

      <section className="section">
        <h3>Skills</h3>
        <p className="note lede">Talk to the agent: “мне нужен скилл для учебы”. Enable or drop them here.</p>
        {skills.map((s) => (
          <div className="line" key={s.id}>
            <div className="meta">
              <span>{s.name}</span>
              <span className="note">{s.enabled ? "on" : "off"}</span>
            </div>
            <div className="actions">
              <button
                className="btn ghost"
                onClick={async () => {
                  await api(`/api/skills/${s.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !s.enabled }),
                  });
                  reload();
                }}
              >
                {s.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="btn ghost"
                onClick={async () => {
                  await api(`/api/skills/${s.id}`, { method: "DELETE" });
                  reload();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <details className="adv">
          <summary>Advanced. Paste a skill.</summary>
          <SkillForm onDone={reload} />
        </details>
      </section>

      <section className="section">
        <h3>MCP</h3>
        <p className="note lede">Ask in chat: “поставь playwright mcp”. No URL required.</p>
        {mcp.map((s) => (
          <div className="line" key={s.id}>
            <Plug size={16} strokeWidth={1.5} />
            <div className="meta">
              <span>{s.name}</span>
              <span className="note mono">
                {s.transport} · {s.enabled ? "on" : "off"}
              </span>
            </div>
            <div className="actions">
              <button
                className="btn ghost"
                onClick={async () => {
                  await api(`/api/mcp/${s.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !s.enabled }),
                  });
                  reload();
                }}
              >
                {s.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="btn ghost"
                onClick={async () => {
                  await api(`/api/mcp/${s.id}`, { method: "DELETE" });
                  reload();
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        ))}
        <details className="adv">
          <summary>Advanced. Paste a command or URL.</summary>
          <McpForm onDone={reload} />
        </details>
      </section>

      <section className="section">
        <h3>Approvals</h3>
        <p className="note lede">Plan, install, and Git writes pause here and in the thread. Allow once or Deny.</p>
        {approvals.map((a) => (
          <div className="line" key={a.id}>
            <div className="meta">
              <span className="mono">{a.action}</span>
              <span className="note">{a.status}</span>
            </div>
            {a.status === "pending" && (
              <div className="actions">
                <button
                  className="btn"
                  onClick={async () => {
                    await api(`/api/approvals/${a.id}`, { method: "POST", body: JSON.stringify({ status: "allowed" }) });
                    reload();
                  }}
                >
                  Allow once
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await api(`/api/approvals/${a.id}`, { method: "POST", body: JSON.stringify({ status: "denied" }) });
                    reload();
                  }}
                >
                  Deny
                </button>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="section">
        <h3>Routines</h3>
        {routines.map((r) => (
          <div className="line" key={r.id}>
            <div className="meta">
              <span>{r.name}</span>
              <span className="note mono">
                {r.cron_expr} · {r.enabled ? "on" : "paused"}
              </span>
            </div>
            <div className="actions">
              <button
                className="btn ghost"
                onClick={async () => {
                  await api(`/api/routines/${r.id}/toggle`, { method: "POST" });
                  reload();
                }}
              >
                Toggle
              </button>
            </div>
          </div>
        ))}
        <RoutineForm bots={bots} onDone={reload} />
      </section>
    </div>
  );
}

function ModelForm({ onDone }: { onDone: () => void }) {
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await api("/api/models", {
      method: "POST",
      body: JSON.stringify({
        kind: fd.get("kind"),
        name: fd.get("name"),
        base_url: fd.get("base_url") || undefined,
        api_key: fd.get("api_key"),
        default_model: fd.get("default_model"),
      }),
    });
    e.currentTarget.reset();
    onDone();
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>Kind</label>
      <select name="kind">
        <option value="openai">OpenAI (official)</option>
        <option value="anthropic">Anthropic (official)</option>
        <option value="google">Google (official)</option>
        <option value="compatible">OpenAI-compatible</option>
      </select>
      <label>Name</label>
      <input name="name" required placeholder="prod" />
      <label>Base URL</label>
      <input name="base_url" placeholder="https://api.openai.com/v1" />
      <label>API key</label>
      <input name="api_key" type="password" />
      <label>Default model</label>
      <input name="default_model" required placeholder="gpt-4.1" />
      <button className="btn" type="submit">
        Add provider
      </button>
    </form>
  );
}

function SkillForm({ onDone }: { onDone: () => void }) {
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await api("/api/skills", { method: "POST", body: JSON.stringify({ name: fd.get("name"), body: fd.get("body") }) });
    e.currentTarget.reset();
    onDone();
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>Name</label>
      <input name="name" required />
      <label>Body</label>
      <textarea name="body" rows={6} required placeholder={"When to use\nSteps\nWhat needs approval"} />
      <button className="btn" type="submit">
        Save skill
      </button>
    </form>
  );
}

function McpForm({ onDone }: { onDone: () => void }) {
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await api("/api/mcp", {
      method: "POST",
      body: JSON.stringify({
        name: fd.get("name"),
        transport: fd.get("transport"),
        command: fd.get("command") || undefined,
        url: fd.get("url") || undefined,
      }),
    });
    e.currentTarget.reset();
    onDone();
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>Name</label>
      <input name="name" required />
      <label>Transport</label>
      <select name="transport">
        <option value="stdio">stdio command</option>
        <option value="sse">SSE URL</option>
      </select>
      <label>Command</label>
      <input name="command" placeholder="npx -y @modelcontextprotocol/server-filesystem /data" />
      <label>URL</label>
      <input name="url" placeholder="https://example.com/sse" />
      <button className="btn" type="submit">
        Add server
      </button>
    </form>
  );
}

function RoutineForm({ bots, onDone }: { bots: Bot[]; onDone: () => void }) {
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await api("/api/routines", {
      method: "POST",
      body: JSON.stringify({
        bot_id: fd.get("bot_id"),
        name: fd.get("name"),
        cron_expr: fd.get("cron_expr"),
        instructions: fd.get("instructions"),
      }),
    });
    e.currentTarget.reset();
    onDone();
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>Bot</label>
      <select name="bot_id">
        {bots.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <label>Name</label>
      <input name="name" required />
      <label>Cron</label>
      <input name="cron_expr" required placeholder="0 8 * * 1-5" />
      <label>Instructions</label>
      <textarea name="instructions" rows={4} required />
      <button className="btn" type="submit">
        Create routine
      </button>
    </form>
  );
}
