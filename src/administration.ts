import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Access, ensureStateDir, loadAccess, pairedOwnerId, statePath, updateAccess } from "./access";
import { TgError, tg } from "./api";
import { type ApplySettingResult, applySetting } from "./settings";

export interface BotIdentity {
  id?: number;
  username?: string;
  has_topics_enabled?: boolean;
  allows_users_to_create_topics?: boolean;
}

export type TokenTelegramCall = <T>(token: string, method: string, payload: Record<string, unknown>) => Promise<T>;

export interface AccessAdministrationHooks {
  getToken(): string;
  /** Refresh runtime state after a locked access.json mutation. */
  onAccessChanged(access: Access): void;
  /** Refresh token-bound runtime clients after administration persists a validated token. */
  onTokenChanged(token: string, me: BotIdentity): void | Promise<void>;
  /** Start the real bridge/poller; setup uses this before waiting for a pairing code. */
  start(ctx: ExtensionContext): void | Promise<void>;
  /** Delegate topic creation to the existing session-topic flow. */
  configureTopics(ctx: ExtensionContext, arg: string): void | Promise<void>;
  /** Run the existing full diagnostics and present its report. */
  doctor(ctx: ExtensionContext): void | Promise<void>;
  /** Reconcile the mounted tool set after the profile setting changes. */
  syncProfile(access: Access): void | Promise<void>;
  /** Refresh owner-scoped bot commands; previousOwnerId is set when removing the owner. */
  refreshCommands(previousOwnerId?: string): void;
  /** Test seam around Telegram; defaults to the real Bot API client. */
  callTelegram?: TokenTelegramCall;
  warn?: (message: string) => void;
}

type PairOutcome =
  | { state: "paired"; senderId: string; chatId: string }
  | { state: "missing" }
  | { state: "expired" }
  | { state: "owned"; ownerId?: string };

const defaultTelegramCall: TokenTelegramCall = <T>(token: string, method: string, payload: Record<string, unknown>) =>
  tg<T>(token, method, payload);

function tokenError(err: unknown, token: string): string {
  const detail = err instanceof TgError ? `${err.code} ${err.message}` : "request failed";
  return token ? detail.replaceAll(token, "[redacted]") : detail;
}

function persistToken(token: string): void {
  ensureStateDir();
  const file = statePath(".env");
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, `TELEGRAM_BOT_TOKEN=${token}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Local-only access, token, settings, and setup command handler. */
export class AccessAdministration {
  readonly #hooks: AccessAdministrationHooks;
  readonly #callTelegram: TokenTelegramCall;
  readonly #warn: (message: string) => void;

  constructor(hooks: AccessAdministrationHooks) {
    this.#hooks = hooks;
    this.#callTelegram = hooks.callTelegram ?? defaultTelegramCall;
    this.#warn = hooks.warn ?? (() => undefined);
  }

  /** Return true when this module owns the local `/telegram` subcommand. */
  async handle(sub: string, args: string[], ctx: ExtensionContext): Promise<boolean> {
    try {
      switch (sub) {
        case "token":
          await this.#token(ctx, args.join(" "));
          return true;
        case "pair":
          await this.#pair(ctx, args.join(" "));
          return true;
        case "deny":
          this.#deny(ctx, args.join(" "));
          return true;
        case "allow":
          this.#allow(ctx, args.join(" "));
          return true;
        case "remove":
          this.#remove(ctx, args.join(" "));
          return true;
        case "policy":
          this.#policy(ctx, args.join(" "));
          return true;
        case "group":
          this.#group(ctx, args);
          return true;
        case "set":
          await this.#set(ctx, args);
          return true;
        case "setup":
          await this.#setup(ctx);
          return true;
        default:
          return false;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const token = this.#hooks.getToken();
      const safeDetail = token ? detail.replaceAll(token, "[redacted]") : detail;
      ctx.ui.notify(`telegram: could not update local configuration — ${safeDetail}`, "error");
      return true;
    }
  }

  async #validateToken(token: string): Promise<BotIdentity> {
    if (/[\r\n]/.test(token)) throw new Error("invalid token");
    return this.#callTelegram<BotIdentity>(token, "getMe", {});
  }

  async #token(ctx: ExtensionContext, raw: string): Promise<void> {
    const token = raw.trim();
    if (!token) {
      ctx.ui.notify("usage: /telegram token <bot-token>", "warning");
      return;
    }
    let me: BotIdentity;
    try {
      me = await this.#validateToken(token);
    } catch (err) {
      ctx.ui.notify(`telegram: token rejected — ${tokenError(err, token)}`, "error");
      return;
    }
    persistToken(token);
    try {
      await this.#hooks.onTokenChanged(token, me);
    } catch {
      ctx.ui.notify("telegram: token was saved, but the running bridge could not refresh it", "error");
      return;
    }
    ctx.ui.notify(`telegram: @${me.username ?? "bot"} ok — run /telegram on to start`, "info");
  }

  async #pair(ctx: ExtensionContext, raw: string): Promise<PairOutcome> {
    const code = raw.trim().toLowerCase();
    const outcomeRef: { current: PairOutcome } = { current: { state: "missing" } };
    const access = updateAccess((fresh) => {
      const entry = fresh.pending[code];
      if (!entry) return;
      if (entry.expiresAt <= Date.now()) {
        delete fresh.pending[code];
        outcomeRef.current = { state: "expired" };
        return;
      }
      const ownerId = pairedOwnerId(fresh);
      if (fresh.allowFrom.length > 0 && ownerId !== entry.senderId) {
        outcomeRef.current = { state: "owned", ownerId };
        return;
      }
      if (!ownerId) fresh.controlThreadId = undefined;
      fresh.allowFrom = [entry.senderId];
      fresh.pending = {};
      outcomeRef.current = { state: "paired", senderId: entry.senderId, chatId: entry.chatId };
    }, this.#warn);
    const outcome = outcomeRef.current;

    if (outcome.state === "missing") {
      ctx.ui.notify(`telegram: no pending code "${code}"`, "warning");
      return outcome;
    }
    if (outcome.state === "expired") {
      this.#hooks.onAccessChanged(access);
      ctx.ui.notify(`telegram: pairing code "${code}" expired — send the bot another message`, "warning");
      return outcome;
    }
    if (outcome.state === "owned") {
      ctx.ui.notify(`telegram: owner already paired (${outcome.ownerId ?? "ambiguous access state"}) — remove locally before pairing another`, "error");
      return outcome;
    }

    this.#hooks.onAccessChanged(access);
    this.#hooks.refreshCommands();
    ctx.ui.notify(`telegram: paired owner ${outcome.senderId}`, "info");
    const token = this.#hooks.getToken();
    if (token) {
      await this.#callTelegram(token, "sendMessage", {
        chat_id: outcome.chatId,
        text: "Paired. Normal messages now reach omp; use /spawn to start sessions in herdr spaces.",
      }).catch(() => undefined);
    }
    return outcome;
  }

  #deny(ctx: ExtensionContext, raw: string): void {
    const code = raw.trim().toLowerCase();
    let found = false;
    const access = updateAccess((fresh) => {
      if (!fresh.pending[code]) return;
      found = true;
      delete fresh.pending[code];
    }, this.#warn);
    if (!found) {
      ctx.ui.notify(`telegram: no pending code "${code}"`, "warning");
      return;
    }
    this.#hooks.onAccessChanged(access);
    ctx.ui.notify(`telegram: denied ${code}`, "info");
  }

  #allow(ctx: ExtensionContext, raw: string): void {
    const id = raw.trim();
    if (!id) {
      ctx.ui.notify("usage: /telegram allow <user-id>", "warning");
      return;
    }
    let rejection: string | undefined;
    const access = updateAccess((fresh) => {
      const ownerId = pairedOwnerId(fresh);
      if (fresh.allowFrom.length > 0 && ownerId !== id) {
        rejection = ownerId ?? "ambiguous access state";
        return;
      }
      if (!ownerId) fresh.controlThreadId = undefined;
      fresh.allowFrom = [id];
      fresh.pending = {};
    }, this.#warn);
    if (rejection) {
      ctx.ui.notify(`telegram: owner already paired (${rejection}) — remove locally before allowing another`, "error");
      return;
    }
    this.#hooks.onAccessChanged(access);
    this.#hooks.refreshCommands();
    ctx.ui.notify(`telegram: owner = ${id}`, "info");
  }

  #remove(ctx: ExtensionContext, raw: string): void {
    const id = raw.trim();
    let removedOwner = false;
    const access = updateAccess((fresh) => {
      removedOwner = pairedOwnerId(fresh) === id;
      fresh.allowFrom = fresh.allowFrom.filter((candidate) => candidate !== id);
      if (fresh.topicsChat === id) fresh.topicsChat = undefined;
      if (fresh.notifyChat === id) fresh.notifyChat = undefined;
      if (removedOwner) fresh.controlThreadId = undefined;
    }, this.#warn);
    this.#hooks.onAccessChanged(access);
    this.#hooks.refreshCommands(removedOwner ? id : undefined);
    ctx.ui.notify(`telegram: removed ${id}`, "info");
  }

  #policy(ctx: ExtensionContext, raw: string): void {
    const policy = raw.trim();
    if (policy !== "pairing" && policy !== "allowlist" && policy !== "disabled") {
      ctx.ui.notify("policy: pairing | allowlist | disabled", "warning");
      return;
    }
    const access = updateAccess((fresh) => {
      fresh.dmPolicy = policy;
    }, this.#warn);
    this.#hooks.onAccessChanged(access);
    ctx.ui.notify(`telegram: dmPolicy = ${policy}`, "info");
  }

  #group(ctx: ExtensionContext, parts: string[]): void {
    const [action, id, ...flags] = parts;
    if ((action !== "add" && action !== "rm") || !id) {
      ctx.ui.notify("usage: /telegram group add <id> [--no-mention] [--allow a,b] | group rm <id>", "warning");
      return;
    }
    const requireMention = !flags.includes("--no-mention");
    const allowIndex = flags.indexOf("--allow");
    const allowFrom = allowIndex >= 0 && flags[allowIndex + 1]
      ? flags[allowIndex + 1].split(",").map((sender) => sender.trim()).filter(Boolean)
      : [];
    const access = updateAccess((fresh) => {
      if (action === "add") fresh.groups[id] = { requireMention, allowFrom };
      else delete fresh.groups[id];
    }, this.#warn);
    this.#hooks.onAccessChanged(access);
    ctx.ui.notify(
      action === "add"
        ? `telegram: group ${id} added (requireMention: ${requireMention}, allowFrom: ${allowFrom.length})`
        : `telegram: group ${id} removed`,
      "info",
    );
  }

  async #set(ctx: ExtensionContext, parts: string[]): Promise<void> {
    const [key, ...rest] = parts;
    const value = rest.join(" ");
    const resultRef: { current: ApplySettingResult } = { current: { ok: false, message: "set: invalid setting" } };
    const access = updateAccess((fresh) => {
      resultRef.current = applySetting(fresh, key, value);
    }, this.#warn);
    const result = resultRef.current;
    if (!result.ok) {
      ctx.ui.notify(result.message, "warning");
      return;
    }
    this.#hooks.onAccessChanged(access);
    if (result.key === "profile") await this.#hooks.syncProfile(access);
    ctx.ui.notify(`telegram: set ${result.key}`, "info");
  }

  async #setup(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("telegram: setup requires an interactive terminal", "warning");
      return;
    }

    let token = this.#hooks.getToken().trim();
    let me: BotIdentity | undefined;
    if (token) {
      try {
        const existing = await this.#validateToken(token);
        const reuse = await ctx.ui.confirm(
          "Telegram setup",
          `Use the configured token for @${existing.username ?? "bot"}? Choose No to enter another token.`,
        );
        if (reuse) me = existing;
        else token = "";
      } catch {
        ctx.ui.notify("telegram: the configured token is invalid; enter a replacement", "warning");
        token = "";
      }
    }

    while (!me) {
      const entered = await ctx.ui.input("Telegram bot token", "Paste the token from @BotFather");
      if (entered === undefined) return this.#cancelSetup(ctx);
      token = entered.trim();
      if (!token) {
        ctx.ui.notify("telegram: a bot token is required", "warning");
        continue;
      }
      try {
        me = await this.#validateToken(token);
      } catch (err) {
        ctx.ui.notify(`telegram: token rejected — ${tokenError(err, token)}`, "error");
      }
    }
    persistToken(token);

    try {
      await this.#hooks.onTokenChanged(token, me);
    } catch {
      ctx.ui.notify("telegram: token was saved, but the running bridge could not refresh it", "error");
      return;
    }
    this.#explainTopics(ctx, me);

    let access = loadAccess(this.#warn);
    if (!pairedOwnerId(access) && access.dmPolicy !== "pairing") {
      const enablePairing = await ctx.ui.confirm(
        "Enable pairing",
        `Direct-message policy is ${access.dmPolicy}. Switch it to pairing so setup can approve this owner?`,
      );
      if (!enablePairing) return this.#cancelSetup(ctx);
      access = updateAccess((fresh) => {
        if (!pairedOwnerId(fresh)) fresh.dmPolicy = "pairing";
      }, this.#warn);
      this.#hooks.onAccessChanged(access);
    }

    access = updateAccess((fresh) => {
      fresh.enabled = true;
    }, this.#warn);
    this.#hooks.onAccessChanged(access);
    await this.#hooks.start(ctx);

    let ownerId = pairedOwnerId(loadAccess(this.#warn));
    while (!ownerId) {
      ctx.ui.notify(`telegram: send @${me.username ?? "your bot"} a private message, then enter the pairing code shown in its reply`, "info");
      const code = await ctx.ui.input("Pair Telegram owner", "Six-character pairing code");
      if (code === undefined) return this.#cancelSetup(ctx);
      const outcome = await this.#pair(ctx, code);
      if (outcome.state === "paired") ownerId = outcome.senderId;
      else if (outcome.state === "owned") {
        ctx.ui.notify("telegram: setup stopped because a different owner is now paired", "error");
        return;
      }
    }
    ctx.ui.notify(`telegram: owner ${ownerId} verified`, "info");

    if (me.has_topics_enabled) {
      const topicChoice = await ctx.ui.select("Session topics", [
        { label: "Enable session topics", description: "Give each omp session its own Telegram topic" },
        { label: "Keep topics off", description: "Use the owner DM without per-session topics" },
      ]);
      if (topicChoice === undefined) return this.#cancelSetup(ctx);
      if (topicChoice === "Enable session topics") await this.#hooks.configureTopics(ctx, "on");
    }
    await this.#hooks.doctor(ctx);
  }

  #explainTopics(ctx: ExtensionContext, me: BotIdentity): void {
    if (me.has_topics_enabled === false) {
      ctx.ui.notify("telegram: DM session topics are off. Enable Topics for this bot in @BotFather before turning session topics on.", "warning");
    } else if (me.has_topics_enabled === undefined) {
      ctx.ui.notify("telegram: could not confirm DM topic support. Check that Topics are enabled for this bot in @BotFather.", "warning");
    } else {
      ctx.ui.notify("telegram: BotFather reports DM session topics are enabled", "info");
    }
    if (me.allows_users_to_create_topics) {
      ctx.ui.notify("telegram: in @BotFather, disable user-created topics so bridge commands cannot open stray DM topics", "warning");
    }
  }

  #cancelSetup(ctx: ExtensionContext): void {
    ctx.ui.notify("telegram: setup cancelled", "info");
  }
}
