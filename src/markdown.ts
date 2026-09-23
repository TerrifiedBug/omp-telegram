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
/** Conservative raw-source budget for Telegram rich messages. */
export const TELEGRAM_RICH_MAX_CHARS = 32768;
/** Headroom to reserve when a chunk will be MarkdownV2-escaped (escaping grows text). */
export const MARKDOWN_HEADROOM = 96;

/** Detect rich-only constructs without rewriting the source sent to Telegram. */
export function hasRichConstructs(markdown: string): boolean {
  let fenceChar = "";
  let fenceLength = 0;
  const visible: string[] = [];
  for (const line of markdown.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceLength) {
      if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLength && !fence[2].trim()) fenceLength = 0;
      visible.push("");
      continue;
    }
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      fenceChar = fence[1][0];
      fenceLength = fence[1].length;
      visible.push("");
      continue;
    }
    // Mask escaped punctuation, preserving cell content but not its syntax.
    visible.push(/^( {4}| {0,3}\t)/.test(line) ? "" : line.replace(/\\[!-/:-@[-`{-~]/g, "\0"));
  }

  const source = visible.join("\n");
  const ticks = [...source.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const closes: Array<number | undefined> = new Array(ticks.length);
  for (let i = ticks.length - 1; i >= 0; i--) {
    closes[i] = next.get(ticks[i][0].length);
    next.set(ticks[i][0].length, i);
  }
  const fragments: string[] = [];
  let offset = 0;
  for (let i = 0; i < ticks.length; i++) {
    const close = closes[i];
    if (close === undefined) continue; // unmatched backticks are literal
    const start = ticks[i].index;
    const end = ticks[close].index + ticks[close][0].length;
    fragments.push(source.slice(offset, start), source.slice(start, end).replace(/[^\n]/g, "\0"));
    offset = end;
    i = close;
  }
  fragments.push(source.slice(offset));
  const text = fragments.join("");
  if (/<(?:details|tg-emoji)(?:\s[^>]*|)>/i.test(text)) return true;
  for (const match of text.matchAll(/\$\$((?:(?!\$\$)[\s\S])+)\$\$/g)) {
    if (match[1].replace(/\0/g, "").trim()) return true;
  }
  let header: string[] | undefined;
  for (const line of text.split("\n")) {
    if (/^ {0,3}[-+*]\s+\[[ xX]\](?:\s|$)/.test(line)) return true;
    const trimmed = line.trim();
    const cells = trimmed.includes("|") ? trimmed.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()) : undefined;
    if (header && cells && cells.length === header.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return true;
    header = cells;
  }
  return false;
}

/** Escape every MarkdownV2 special character with a backslash. */
export function escapeMdV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Inline formatting for a single line: code/links/bold/italic preserved, the rest escaped. */
function inlineFormat(s: string): string {
  // Protect already-rendered MarkdownV2 fragments behind private-use sentinels so
  // the final escape pass leaves them untouched. The sentinels are picked from
  // private-use code points absent from this line, so literal text can never be
  // mistaken for a placeholder.
  const [open, close] = unusedSentinels(s);
  const placeholder = new RegExp(`${open}(\\d+)${close}`, "g");
  const stash: string[] = [];
  const expand = (text: string): string => text.replace(placeholder, (_m, n: string) => stash[Number(n)] ?? "");
  // Nested formatting (e.g. a link inside bold) stores a fragment that already
  // contains an earlier placeholder; expand it now so the single final restore
  // pass never leaves an inner placeholder behind (#82).
  const put = (rendered: string): string => `${open}${stash.push(expand(rendered)) - 1}${close}`;

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
  return expand(escapeMdV2(t));
}

/** Two private-use code points that do not occur in `s`. */
function unusedSentinels(s: string): [string, string] {
  const found: string[] = [];
  for (let code = 0xe000; found.length < 2; code++) {
    const c = String.fromCharCode(code);
    if (!s.includes(c)) found.push(c);
  }
  return [found[0], found[1]];
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

/** Width reserved for the `(i/n)` label prepended to every part of a split message. */
export const PART_LABEL_RESERVE = 16;

/**
 * Chunk like {@link chunk}, but when the message does not arrive in one piece
 * prepend `(i/n)` to every part so a reader can see the answer continues. The
 * text is re-split against a smaller budget so the label always fits.
 *
 * `priorParts` counts messages of the same answer already delivered (a stream
 * preview committed mid-turn), so the numbering spans the whole answer.
 */
export function chunkLabeled(text: string, limit: number, mode: "length" | "newline", priorParts = 0): string[] {
  const parts = chunk(text, limit, mode);
  if (parts.length <= 1 && priorParts === 0) return parts;
  const labelled = chunk(text, Math.max(1, limit - PART_LABEL_RESERVE), mode);
  const total = priorParts + labelled.length;
  return labelled.map((part, i) => `(${priorParts + i + 1}/${total})\n${part}`);
}
