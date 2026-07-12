// Markdown → Telegram MarkdownV2 conversion and message chunking.
//
// Telegram caps a message at 4096 characters counted in UTF-16 code units,
// which is exactly what JavaScript's `String.length` returns — so `.length` is
// the correct measure throughout (a non-BMP emoji counts as 2, matching
// Telegram). Callers always fall back to plain text when Telegram rejects a
// MarkdownV2 parse (HTTP 400 "can't parse entities"), so a *lossy* conversion is
// acceptable here; a thrown exception is not — `mdToMarkdownV2` never throws.

/** Telegram's hard per-message character cap (UTF-16 units). */
export const TELEGRAM_MAX_CHARS = 4096;
/** Headroom to reserve when a chunk will be MarkdownV2-escaped (escaping grows text). */
export const MARKDOWN_HEADROOM = 96;

/** Escape every MarkdownV2 special character with a backslash. */
export function escapeMdV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Inline formatting for a single line: code/links/bold/italic preserved, the rest escaped. */
function inlineFormat(s: string): string {
  const stash: string[] = [];
  // Protect already-rendered MarkdownV2 fragments behind private-use sentinels so
  // the final escape pass leaves them untouched. 4 call sites, lockstep protocol.
  const put = (rendered: string): string => `\uE000${stash.push(rendered) - 1}\uE001`;

  let t = s;
  // Inline code — inside a code span only ` and \ are special.
  t = t.replace(/`([^`\n]+)`/g, (_m, code: string) => put("`" + code.replace(/[`\\]/g, "\\$&") + "`"));
  // Links [text](url) — escape text as normal, escape ) and \ in the URL.
  t = t.replace(/\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_m, text: string, url: string) =>
    put("[" + escapeMdV2(text) + "](" + url.replace(/[)\\]/g, "\\$&") + ")"),
  );
  // Bold **x** → *x*
  t = t.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => put("*" + escapeMdV2(inner) + "*"));
  // Italic _x_ (not inside a word) and *x* → _x_
  t = t.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, (_m, inner: string) => put("_" + escapeMdV2(inner) + "_"));
  t = t.replace(/\*([^*\n]+)\*/g, (_m, inner: string) => put("_" + escapeMdV2(inner) + "_"));
  // Escape everything that remains, then restore the protected fragments.
  t = escapeMdV2(t);
  return t.replace(/\uE000(\d+)\uE001/g, (_m, n: string) => stash[Number(n)] ?? "");
}

/**
 * Convert assistant-style GitHub markdown to Telegram MarkdownV2. Handles fenced
 * code blocks, inline code, bold, italic, links, and ATX headings; escapes the
 * rest. Never throws — any failure falls back to a fully-escaped plain rendering.
 */
export function mdToMarkdownV2(md: string): string {
  try {
    const lines = md.split("\n");
    const out: string[] = [];
    let inFence = false;
    let fenceLang = "";
    let buf: string[] = [];
    const flushFence = (): void => {
      const lang = fenceLang.replace(/[^a-zA-Z0-9+#_-]/g, "");
      const body = buf.join("\n").replace(/[`\\]/g, "\\$&");
      out.push("```" + lang + "\n" + body + "\n```");
      buf = [];
      fenceLang = "";
    };

    for (const line of lines) {
      const fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        if (inFence) {
          flushFence();
          inFence = false;
        } else {
          inFence = true;
          fenceLang = fence[1] ?? "";
        }
        continue;
      }
      if (inFence) {
        buf.push(line);
        continue;
      }
      const heading = /^\s*(#{1,6})\s+(.*\S)\s*$/.exec(line);
      if (heading) {
        out.push("*" + escapeMdV2(heading[2]) + "*");
        continue;
      }
      out.push(inlineFormat(line));
    }
    if (inFence) flushFence(); // unbalanced fence — close it so the send can't break
    return out.join("\n");
  } catch {
    return escapeMdV2(md);
  }
}

/** Base splitter: prefer paragraph, then line, then space breaks past limit/2, else hard cut. */
function splitToLimit(text: string, limit: number, mode: "length" | "newline"): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    if (mode === "newline") {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split text into Telegram-sized chunks. Ports the Claude plugin's chunker and
 * adds fence repair: if a boundary lands inside an open ``` block, the block is
 * closed at the chunk end and reopened at the next chunk start (language is
 * dropped on the reopened half). Empty input yields no chunks.
 */
export function chunk(text: string, limit: number, mode: "length" | "newline"): string[] {
  if (text.length === 0) return [];
  const raw = splitToLimit(text, Math.max(1, limit), mode);
  const out: string[] = [];
  let carryOpen = false;
  for (let piece of raw) {
    if (carryOpen) piece = "```\n" + piece;
    const fences = (piece.match(/```/g) ?? []).length;
    if (fences % 2 === 1) {
      piece = piece + "\n```";
      carryOpen = true;
    } else {
      carryOpen = false;
    }
    out.push(piece);
  }
  return out;
}
