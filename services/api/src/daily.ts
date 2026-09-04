const UNITS: Record<string, { dim: string; toSi: number }> = {
  m: { dim: "length", toSi: 1 },
  km: { dim: "length", toSi: 1000 },
  cm: { dim: "length", toSi: 0.01 },
  mm: { dim: "length", toSi: 0.001 },
  mi: { dim: "length", toSi: 1609.344 },
  ft: { dim: "length", toSi: 0.3048 },
  in: { dim: "length", toSi: 0.0254 },
  kg: { dim: "mass", toSi: 1 },
  g: { dim: "mass", toSi: 0.001 },
  lb: { dim: "mass", toSi: 0.45359237 },
  oz: { dim: "mass", toSi: 0.028349523125 },
  c: { dim: "temp", toSi: 1 },
  f: { dim: "temp", toSi: 1 },
  k: { dim: "temp", toSi: 1 },
  l: { dim: "vol", toSi: 1 },
  ml: { dim: "vol", toSi: 0.001 },
  gal: { dim: "vol", toSi: 3.785411784 },
};

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

type WebResult = { title: string; url: string; snippet: string };

function decodeDdg(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m) return href.startsWith("//") ? `https:${href}` : href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

export function parseDdg(html: string): WebResult[] {
  const out: WebResult[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 8) {
    const url = decodeDdg(m[1]);
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com/i.test(url)) continue;
    const title = stripHtml(m[2]).slice(0, 200) || url;
    const tail = html.slice(m.index, m.index + 4000);
    const sm = tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = sm ? stripHtml(sm[1]).slice(0, 400) : "";
    if (out.some((r) => r.url === url)) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

export async function searchWebHttp(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Janus/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r.text();
    const results = parseDdg(html);
    if (!results.length) return `${url}\n\n${stripHtml(html).slice(0, 4000)}`;
    const lines = results.map(
      (res, i) => `${i + 1}. ${res.title}\n   URL: ${res.url}${res.snippet ? `\n   ${res.snippet}` : ""}`,
    );
    return `Results for "${query}" (${results.length}):\n${lines.join("\n")}\n\nCall read_pages with the full URLs of the best 2-4 sources to read them.`;
  } catch (e) {
    return `search failed: ${String(e).slice(0, 200)}`;
  }
}

function pageToText(html: string, base: string): { title: string; text: string } {
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? stripHtml(tm[1]).slice(0, 200) : base;
  const chunks: string[] = [];
  const re = /<(h1|h2|h3|p|li|td|th|blockquote|pre)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && chunks.join("\n").length < 6000) {
    const tag = m[1].toLowerCase();
    let inner = m[2];
    // keep links as text (url), drop the rest of markup
    inner = inner.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_s, href: string, text: string) => {
      const t = stripHtml(text).trim();
      const u = href.startsWith("http") ? href : href.startsWith("//") ? `https:${href}` : "";
      return t && u ? `${t} (${u})` : t;
    });
    const text = stripHtml(inner).trim();
    if (!text) continue;
    if (tag === "h1") chunks.push(`# ${text}`);
    else if (tag === "h2") chunks.push(`## ${text}`);
    else if (tag === "h3") chunks.push(`### ${text}`);
    else if (tag === "li") chunks.push(`- ${text}`);
    else chunks.push(text);
  }
  return { title, text: chunks.join("\n\n").slice(0, 5000) || stripHtml(html).slice(0, 2000) };
}

export async function fetchPages(urls: string[]): Promise<string> {
  const list = urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 4);
  if (!list.length) return "no valid http(s) urls";
  const parts = await Promise.all(
    list.map(async (u) => {
      try {
        const r = await fetch(u, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Janus/1.0)" },
          signal: AbortSignal.timeout(12000),
          redirect: "follow",
        });
        const ct = r.headers.get("content-type") ?? "";
        if (!r.ok) return `=== ${u}\n(unreachable: http ${r.status})`;
        if (!/text|html/i.test(ct)) return `=== ${u}\n(skip: ${ct || "non-text"} content)`;
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 400000) return `=== ${u}\n(skip: page too large)`;
        const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        const { title, text } = pageToText(html, u);
        return `=== ${title}\nURL: ${u}\n${text || "(empty page)"}`;
      } catch (e) {
        return `=== ${u}\n(unreachable: ${String(e).slice(0, 120)})`;
      }
    }),
  );
  return parts.join("\n\n");
}

export function nowIn(tz: string) {
  const zone = tz || "UTC";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date());
  } catch {
    return `unknown timezone ${zone}`;
  }
}

export function calc(expr: string) {
  const src = expr.replace(/[^0-9+\-*/().eE\s]/g, "");
  if (!src.trim()) return "empty";
  try {
    const n = Function(`"use strict"; return (${src})`)();
    if (typeof n !== "number" || !Number.isFinite(n)) return "not a number";
    return String(n);
  } catch {
    return "could not evaluate";
  }
}

function temp(v: number, from: string, to: string) {
  let c = v;
  if (from === "f") c = (v - 32) * (5 / 9);
  if (from === "k") c = v - 273.15;
  if (to === "c") return c;
  if (to === "f") return c * (9 / 5) + 32;
  if (to === "k") return c + 273.15;
  return c;
}

export async function convert(amount: number, from: string, to: string): Promise<string> {
  const a = from.toLowerCase();
  const b = to.toLowerCase();
  if (UNITS[a] && UNITS[b] && UNITS[a].dim === UNITS[b].dim) {
    if (UNITS[a].dim === "temp") return String(temp(amount, a, b));
    return String((amount * UNITS[a].toSi) / UNITS[b].toSi);
  }
  const r = await fetch("https://open.er-api.com/v6/latest/USD");
  const json = (await r.json()) as { rates?: Record<string, number> };
  const rates = json.rates ?? {};
  const fa = rates[a.toUpperCase()];
  const fb = rates[b.toUpperCase()];
  if (!fa || !fb) return `cannot convert ${from} to ${to}`;
  return String((amount / fa) * fb);
}

export async function wiki(title: string): Promise<string> {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, {
    headers: { "User-Agent": "janus" },
  });
  if (!r.ok) return `no wikipedia page for ${title}`;
  const j = (await r.json()) as { title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
  return `${j.title ?? title}\n${j.content_urls?.desktop?.page ?? ""}\n\n${j.extract ?? ""}`;
}
