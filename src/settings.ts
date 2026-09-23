import type { Access } from "./access";

export type SettingsCompletionNode = Record<string, null> | null;

export interface SettingSpec {
  key: keyof Access;
  description: string;
  values?: readonly string[];
  apply(access: Access, value: string): string | undefined;
}

/**
 * Single source of truth for `/telegram set`: accepted enum values, completion
 * grammar, help text, validation, and mutation all derive from this table.
 */
export const SETTINGS = [
  {
    key: "ackReaction",
    description: "emoji reaction on received messages",
    apply(access, value) {
      access.ackReaction = value || undefined;
      return undefined;
    },
  },
  {
    key: "deliveryStatus",
    description: "delivery receipts: reactions (default; 👀 seen, 👍 replied) | failures (only problems) | all (status reply with progress)",
    values: ["reactions", "failures", "all"],
    apply(access, value) {
      access.deliveryStatus = value === "all" || value === "reactions" || value === "failures" ? value : undefined;
      return undefined;
    },
  },
  {
    key: "replyToMode",
    description: "thread replies: off | first | all",
    values: ["off", "first", "all"],
    apply(access, value) {
      access.replyToMode = value as Access["replyToMode"];
      return undefined;
    },
  },
  {
    key: "textChunkLimit",
    description: "max characters per message (1-4096)",
    apply(access, value) {
      const limit = Number(value);
      if (!Number.isFinite(limit) || limit < 1 || limit > 4096) return "textChunkLimit: 1..4096";
      access.textChunkLimit = Math.floor(limit);
      return undefined;
    },
  },
  {
    key: "chunkMode",
    description: "split long output on length | newline",
    values: ["length", "newline"],
    apply(access, value) {
      access.chunkMode = value as Access["chunkMode"];
      return undefined;
    },
  },
  {
    key: "mentionPatterns",
    description: "JSON array of mention regexes",
    apply(access, value) {
      try {
        const patterns: unknown = JSON.parse(value);
        if (!Array.isArray(patterns)) throw new Error("not an array");
        access.mentionPatterns = patterns.map(String);
        return undefined;
      } catch {
        return 'mentionPatterns: JSON array, e.g. ["\\\\bbot\\\\b"]';
      }
    },
  },
  {
    key: "deliverAs",
    description: "steer | followUp delivery",
    values: ["steer", "followUp"],
    apply(access, value) {
      access.deliverAs = value as Access["deliverAs"];
      return undefined;
    },
  },
  {
    key: "streaming",
    description: "output: true (stream) | false (per-turn) | final (one message) | explicit (tool calls only)",
    values: ["true", "false", "final", "explicit"],
    apply(access, value) {
      access.streaming = value === "final" || value === "explicit" ? value : value === "true";
      return undefined;
    },
  },
  {
    key: "richMessages",
    description: "formatting: auto (rich constructs) | on (prefer rich) | off (MarkdownV2)",
    values: ["auto", "on", "off"],
    apply(access, value) {
      access.richMessages = value as Access["richMessages"];
      return undefined;
    },
  },
  {
    key: "profile",
    description: "daemon (headless: explicit output + always-on telegram_ask) | default",
    values: ["daemon", "default"],
    apply(access, value) {
      access.profile = value === "daemon" ? "daemon" : undefined;
      return undefined;
    },
  },
  {
    key: "transcribeCommand",
    description: "JSON argv for voice transcription",
    apply(access, value) {
      if (!value) {
        access.transcribeCommand = undefined;
        return undefined;
      }
      try {
        const command: unknown = JSON.parse(value);
        if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === "string")) {
          throw new Error("not a command");
        }
        access.transcribeCommand = command;
        return undefined;
      } catch {
        return 'transcribeCommand: JSON argv array, e.g. ["whisper-cli","-f","{file}"] (empty value clears)';
      }
    },
  },
] as const satisfies readonly SettingSpec[];

export const SETTINGS_GRAMMAR: Record<string, SettingsCompletionNode> = Object.fromEntries(
  SETTINGS.map((setting) => [
    setting.key,
    "values" in setting ? Object.fromEntries(setting.values.map((value) => [value, null])) : null,
  ]),
);

export const SETTING_HELP: Record<string, string> = Object.fromEntries(
  SETTINGS.map((setting) => [setting.key, setting.description]),
);

export type SettingKey = (typeof SETTINGS)[number]["key"];

export type ApplySettingResult = { ok: true; key: SettingKey } | { ok: false; message: string };

/** Validate and apply one setting to the caller's fresh Access snapshot. */
export function applySetting(access: Access, key: string | undefined, value: string): ApplySettingResult {
  const setting = SETTINGS.find((candidate) => candidate.key === key);
  if (!setting) {
    return { ok: false, message: `set: unknown key "${key ?? ""}". Keys: ${SETTINGS.map((candidate) => candidate.key).join(", ")}` };
  }
  if ("values" in setting && !setting.values.some((accepted: string) => accepted === value)) {
    return { ok: false, message: `${setting.key}: ${setting.values.join(" | ")}` };
  }
  const error = setting.apply(access, value);
  return error ? { ok: false, message: error } : { ok: true, key: setting.key };
}
