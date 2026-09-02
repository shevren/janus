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

export async function searchWebHttp(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { "User-Agent": "janus" } });
  const html = await r.text();
  return `${url}\n\n${stripHtml(html).slice(0, 8000)}`;
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
