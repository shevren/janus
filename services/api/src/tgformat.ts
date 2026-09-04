/** Pure Telegram formatting helpers (no I/O, unit-tested). */

const PH_OPEN = "⟦TG";
const PH_CLOSE = "⟧";

export function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/**
 * Scrub model output junk before delivery:
 * - leaked control tokens like <|open|>, <|close|>
 * - leading labels like "response", "output:", "Ответ:"
 * - filler ellipsis lines ("...", "…", "эээ")
 */
export function cleanResponse(src: string): string {
  let s = src.replace(/<\|[^|<>]{1,40}\|>/g, "");
  const lines = s.split("\n");
  while (lines.length && /^[\s.…\-–—]+$/.test(lines[0])) lines.shift();
  while (lines.length && /^[\s.…\-–—]+$/.test(lines[lines.length - 1])) lines.pop();
  s = lines.join("\n");
  s = s.replace(/^(?:response|output|answer|result|результат|ответ)(?:\s*[:\-–—]\s*|\s+(?=[^\s])|(?=[A-ZА-ЯЁ]))/i, "");
  s = s.replace(/[ \t]*\n{3,}/g, "\n\n");
  return s.trim();
}

/** Convert leftover Markdown into Telegram HTML before sanitizing. */
export function markdownToHtml(src: string): string {
  let s = src;
  // [text](https://url) -> <a href="url">text</a> (http/https only)
  s = s.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  // ```block``` -> <pre>block</pre> (before inline backticks)
  s = s.replace(/```\n?([\s\S]{1,2000}?)\n?```/g, "<pre>$1</pre>");
  // `code` -> <code>code</code> (single backticks, no newlines)
  s = s.replace(/`([^`\n]{1,300})`/g, "<code>$1</code>");
  // **bold** -> <b>bold</b>
  s = s.replace(/\*\*([^*\n]{1,300})\*\*/g, "<b>$1</b>");
  // __italic__ -> <i>italic</i>
  s = s.replace(/__([^_\n]{1,300})__/g, "<i>$1</i>");
  // ~~strike~~ -> <s>strike</s>
  s = s.replace(/~~([^~\n]{1,300})~~/g, "<s>$1</s>");
  return s;
}

// Telegram HTML subset only. Everything else becomes literal text, links
// limited to http(s). Model output is untrusted for parse_mode purposes.
export function sanitizeTgHtml(src: string): string {
  let s = markdownToHtml(src)
    .replace(/<\/?strong\b[^>]*>/gi, (t) => (t.startsWith("</") ? "</b>" : "<b>"))
    .replace(/<\/?em\b[^>]*>/gi, (t) => (t.startsWith("</") ? "</i>" : "<i>"))
    .replace(/<\/?(?:strike|del)\b[^>]*>/gi, (t) => (t.startsWith("</") ? "</s>" : "<s>"));
  const keep: string[] = [];
  const stash = (t: string) => {
    keep.push(t);
    return `${PH_OPEN}${keep.length - 1}${PH_CLOSE}`;
  };
  s = s.replace(/<\/?(?:b|i|u|s|code|pre|blockquote|tg-spoiler)\b[^>]*>/gi, stash);
  s = s.replace(/<a\b[^>]*href="(https?:\/\/[^"\s]+)"[^>]*>/gi, (_t, u: string) => stash(`<a href="${u}">`));
  s = s.replace(/<\/a>/gi, () => stash("</a>"));
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/⟦TG(\d+)⟧/g, (_s, n: string) => keep[Number(n)] ?? "");
  return s;
}

export function balancedHtml(s: string): boolean {
  for (const t of ["b", "i", "u", "s", "code", "pre", "blockquote", "tg-spoiler", "a"]) {
    const o = (s.match(new RegExp(`<${t}(\\s[^>]*)?>`, "g")) || []).length;
    const c = (s.match(new RegExp(`</${t}>`, "g")) || []).length;
    if (o !== c) return false;
  }
  return true;
}

export function chunksOf(s: string, n = 3900): string[] {
  if (s.length <= n) return [s];
  const parts = s.split(/\n\s*\n/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    const next = cur ? `${cur}\n\n${p}` : p;
    if (next.length > n && cur) {
      out.push(cur);
      cur = p;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length <= n ? [c] : (c.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) ?? [c])));
}
