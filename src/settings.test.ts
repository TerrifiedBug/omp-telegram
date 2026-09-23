import { describe, expect, test } from "bun:test";
import { defaultAccess } from "./access";
import { SETTINGS, SETTINGS_GRAMMAR, SETTING_HELP, applySetting } from "./settings";

describe("settings metadata", () => {
  test("keeps help, completions, accepted enum values, and validation coherent", () => {
    expect(Object.keys(SETTINGS_GRAMMAR)).toEqual(SETTINGS.map((setting) => setting.key));
    expect(Object.keys(SETTING_HELP)).toEqual(SETTINGS.map((setting) => setting.key));

    for (const setting of SETTINGS) {
      expect(SETTING_HELP[setting.key]).toBe(setting.description);
      if (!("values" in setting)) {
        expect(SETTINGS_GRAMMAR[setting.key]).toBeNull();
        continue;
      }
      expect(Object.keys(SETTINGS_GRAMMAR[setting.key] ?? {})).toEqual(setting.values);
      for (const value of setting.values) {
        expect(applySetting(defaultAccess(), setting.key, value)).toEqual({ ok: true, key: setting.key });
      }
      expect(applySetting(defaultAccess(), setting.key, "not-an-accepted-value").ok).toBe(false);
    }
  });

  test("invalid values leave the supplied access snapshot unchanged", () => {
    const access = { ...defaultAccess(), replyToMode: "all" as const, mentionPatterns: ["existing"] };
    const before = structuredClone(access);

    expect(applySetting(access, "replyToMode", "sometimes").ok).toBe(false);
    expect(applySetting(access, "mentionPatterns", "not json").ok).toBe(false);
    expect(applySetting(access, "textChunkLimit", "0").ok).toBe(false);
    expect(access).toEqual(before);
  });

  test("parses free-form values and preserves unrelated fields", () => {
    const access = { ...defaultAccess(), groups: { "-100": { requireMention: true, allowFrom: ["42"] } } };

    expect(applySetting(access, "textChunkLimit", "100.9")).toEqual({ ok: true, key: "textChunkLimit" });
    expect(applySetting(access, "mentionPatterns", '["bot",42]')).toEqual({ ok: true, key: "mentionPatterns" });
    expect(applySetting(access, "transcribeCommand", '["whisper-cli","-f","{file}"]')).toEqual({ ok: true, key: "transcribeCommand" });

    expect(access.textChunkLimit).toBe(100);
    expect(access.mentionPatterns).toEqual(["bot", "42"]);
    expect(access.transcribeCommand).toEqual(["whisper-cli", "-f", "{file}"]);
    expect(access.groups).toEqual({ "-100": { requireMention: true, allowFrom: ["42"] } });
  });
});
