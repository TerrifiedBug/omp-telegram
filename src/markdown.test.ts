import { test, expect, describe } from "bun:test";
import { escapeMdV2, mdToMarkdownV2, chunk, TELEGRAM_MAX_CHARS, MARKDOWN_HEADROOM } from "./markdown";

// The exact MarkdownV2 special set that escapeMdV2 must prefix with a backslash.
const SPECIALS = ["_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!", "\\"];

/** Count non-overlapping triple-backtick sequences — the fence-balance measure chunk() uses. */
const countFences = (s: string): number => (s.match(/```/g) ?? []).length;

describe("escapeMdV2", () => {
  test("escapes every MarkdownV2 special character with a backslash", () => {
    for (const c of SPECIALS) {
      // e.g. "." -> "\." and "\" -> "\\"
      expect(escapeMdV2(c)).toBe("\\" + c);
    }
  });

  test("leaves letters, digits, and spaces untouched", () => {
    expect(escapeMdV2("abc XYZ 0123 hello there")).toBe("abc XYZ 0123 hello there");
  });

  test("escapes a mixed string end to end (period and hyphen)", () => {
    expect(escapeMdV2("a.b-c")).toBe("a\\.b\\-c");
  });

  test("escapes only the special chars within surrounding prose", () => {
    // comma is NOT special; "!" is.
    expect(escapeMdV2("Hello, world!")).toBe("Hello, world\\!");
    expect(escapeMdV2("1+1=2.")).toBe("1\\+1\\=2\\.");
  });
});

describe("mdToMarkdownV2 correctness", () => {
  test("**bold** becomes *bold*", () => {
    expect(mdToMarkdownV2("**bold**")).toBe("*bold*");
  });

  test("_italic_ stays _italic_", () => {
    expect(mdToMarkdownV2("_it_")).toBe("_it_");
  });

  test("*italic* is normalized to _italic_", () => {
    expect(mdToMarkdownV2("*it*")).toBe("_it_");
  });

  test("ATX heading becomes bold", () => {
    expect(mdToMarkdownV2("## H")).toBe("*H*");
  });

  test("heading text is escaped inside the bold wrapper", () => {
    expect(mdToMarkdownV2("### Release v1.2!")).toBe("*Release v1\\.2\\!*");
  });

  test("inline code keeps a literal '.' (not escaped) inside the span", () => {
    const r = mdToMarkdownV2("`a.b`");
    expect(r).toBe("`a.b`");
    expect(r).not.toContain("\\.");
  });

  test("fenced code block escapes only backticks/backslashes in the body", () => {
    const r = mdToMarkdownV2("```\nfoo.bar `baz`\n```");
    expect(r.startsWith("```")).toBe(true);
    expect(r.endsWith("```")).toBe(true);
    expect(r).toContain("foo.bar"); // '.' stays literal in code body
    expect(r).not.toContain("foo\\.bar"); // '.' is NOT escaped
    expect(r).toContain("\\`baz\\`"); // backticks ARE escaped
  });

  test("plain-line specials are escaped via escapeMdV2", () => {
    expect(mdToMarkdownV2("a.b")).toBe("a\\.b");
  });

  test("markdown link keeps its structure", () => {
    expect(mdToMarkdownV2("[the label](https://example.com/p.q)")).toBe("[the label](https://example.com/p.q)");
  });
});

describe("mdToMarkdownV2 safety (never throws)", () => {
  const PATHOLOGICAL = [
    "",
    "```",
    "```js\ncode with no closing fence",
    "```\n```\n```",
    "***_*",
    "[a](",
    "]",
    "_*`~[](){}#+-=|.!>",
    SPECIALS.join(""),
    "a".repeat(50_000),
    "> quote\n# heading\n- item\n**b** _i_ `c`",
    "**unbalanced *nested _markers",
    "`unclosed inline code",
    "text with a lone ` backtick",
  ];

  test("returns a string without throwing on pathological input", () => {
    for (const input of PATHOLOGICAL) {
      expect(() => mdToMarkdownV2(input)).not.toThrow();
      expect(typeof mdToMarkdownV2(input)).toBe("string");
    }
  });

  test("auto-closes unbalanced fences so the output has an even fence count", () => {
    // If a fence were left open, Telegram would reject the pre-block; the converter
    // must always emit balanced (even) triple-backtick sequences.
    for (const input of ["```", "```js\ncode with no closing fence", "```\n```\n```"]) {
      expect(countFences(mdToMarkdownV2(input)) % 2).toBe(0);
    }
  });
});

describe("chunk", () => {
  test("empty input yields no chunks", () => {
    expect(chunk("", 100, "newline")).toEqual([]);
    expect(chunk("", 100, "length")).toEqual([]);
  });

  test("input at or under the limit is returned as a single chunk", () => {
    expect(chunk("hello", 100, "length")).toEqual(["hello"]);
    // exact-limit input is not split
    expect(chunk("x".repeat(20), 20, "length")).toEqual(["x".repeat(20)]);
    expect(chunk("x".repeat(20), 20, "newline")).toEqual(["x".repeat(20)]);
  });

  test("length mode hard-cuts at the limit when one char over", () => {
    expect(chunk("x".repeat(21), 20, "length")).toEqual(["x".repeat(20), "x"]);
  });

  test("newline mode prefers a paragraph break (\\n\\n) over a line break", () => {
    // "\n\n" at index 11 (>10) is preferred even though a later single "\n" sits at 17.
    const text = "a".repeat(11) + "\n\n" + "aaaa" + "\n" + "a".repeat(16);
    const chunks = chunk(text, 20, "newline");
    expect(chunks[0]).toBe("a".repeat(11));
  });

  test("newline mode prefers a line break (\\n) over a space", () => {
    // "\n" at index 11 (>10) is preferred even though a later space sits at 16.
    const text = "a".repeat(11) + "\n" + "aaaa" + " " + "a".repeat(16);
    const chunks = chunk(text, 20, "newline");
    expect(chunks[0]).toBe("a".repeat(11));
  });

  test("newline mode falls back to a space break", () => {
    const text = "a".repeat(18) + " " + "b".repeat(14);
    const chunks = chunk(text, 20, "newline");
    expect(chunks[0]).toBe("a".repeat(18));
  });

  test("newline mode hard-cuts when no break is available", () => {
    const chunks = chunk("x".repeat(25), 10, "newline");
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
  });
});

describe("chunk fence repair invariant", () => {
  const FENCE_SPLITS: Array<{ name: string; text: string; limit: number; mode: "length" | "newline" }> = [
    {
      name: "long single code block, length mode",
      text: "```js\n" + "a".repeat(200) + "\n```",
      limit: 50,
      mode: "length",
    },
    {
      name: "code block with many body lines, newline mode",
      text: "```\n" + Array.from({ length: 30 }, (_, i) => "line" + i).join("\n") + "\n```",
      limit: 40,
      mode: "newline",
    },
    {
      name: "prose, then fenced block, then prose, length mode",
      text: "intro paragraph before the code sample\n```py\n" + "b".repeat(120) + "\n```\ntrailing prose after the block",
      limit: 45,
      mode: "length",
    },
  ];

  test("every chunk of a forced fence split has an even triple-backtick count", () => {
    for (const { name, text, limit, mode } of FENCE_SPLITS) {
      const chunks = chunk(text, limit, mode);
      expect(chunks.length).toBeGreaterThanOrEqual(2); // genuinely split (not vacuous)
      for (const c of chunks) {
        expect(countFences(c) % 2, name).toBe(0);
      }
    }
  });

  test("a mid-fence split closes the chunk and reopens on the next", () => {
    const text = "```js\n" + "a".repeat(200) + "\n```";
    const chunks = chunk(text, 50, "length");
    expect(chunks.length).toBeGreaterThanOrEqual(3); // fence spans multiple chunks
    expect(chunks[0].endsWith("```")).toBe(true); // closed at the boundary
    expect(chunks[1].startsWith("```")).toBe(true); // reopened after it
    // an interior chunk is a self-contained (reopened + reclosed) fence fragment
    expect(chunks[1].startsWith("```") && chunks[1].endsWith("```")).toBe(true);
    for (const c of chunks) expect(countFences(c) % 2).toBe(0);
  });
});

describe("constants", () => {
  test("MARKDOWN_HEADROOM fits within the Telegram cap", () => {
    expect(MARKDOWN_HEADROOM).toBeGreaterThan(0);
    expect(MARKDOWN_HEADROOM).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("chunk treats TELEGRAM_MAX_CHARS as the real split boundary", () => {
    expect(chunk("x".repeat(TELEGRAM_MAX_CHARS), TELEGRAM_MAX_CHARS, "length")).toEqual(["x".repeat(TELEGRAM_MAX_CHARS)]);
    expect(chunk("x".repeat(TELEGRAM_MAX_CHARS + 1), TELEGRAM_MAX_CHARS, "length").length).toBe(2);
  });
});
