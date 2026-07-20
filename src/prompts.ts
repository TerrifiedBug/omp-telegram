import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "./access";
import type { TgCallbackQuery, TgMessage } from "./api";
import type { TelegramCall } from "./control";
import { isAlive } from "./topics";

const PROMPT_TTL_MS = 5 * 60_000; // GC grace for orphaned answer artifacts (requests expire by owner-pid liveness)
const POLL_INTERVAL_MS = 200;

const OPTIONS_PER_PAGE = 8;

/**
 * Abort reason used when one ask surface is superseded because a sibling surface
 * (e.g. the terminal picker) was answered first. Lets {@link TelegramPromptController.ask}
 * distinguish "answered elsewhere" from a genuine task-stop abort when it closes
 * the Telegram message.
 */
export const PROMPT_SUPERSEDED = Symbol("prompt-superseded");
export interface PromptOption {
  label: string;
  description?: string;
}

export interface PromptQuestion {
  id: string;
  question: string;
  options: PromptOption[];
  multi?: boolean;
  recommended?: number;
}

export interface PromptTarget {
  responderId: string;
  chatId: string;
  chatType: string;
  threadId?: number;
}

export interface PromptAnswer {
  id: string;
  question: string;
  selectedOptions: string[];
  customInput?: string;
  /** Extra free-text the terminal picker lets the user attach alongside a selection. Telegram prompts don't collect it. */
  note?: string;
}

export type PromptOutcome =
  | { status: "answered"; answers: PromptAnswer[] }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "aborted" };

interface PromptRequest extends PromptTarget {
  version: 1;
  nonce: string;
  messageId: number;
  questions: PromptQuestion[];
  questionIndex: number;
  page: number;
  answers: PromptAnswer[];
  selectedIndices: number[];
  awaitingText: boolean;
  ownerPid: number;
}
interface PromptAnswerEnvelope {
  expiresAt: number;
  outcome: PromptOutcome;
}

type PromptAuthorization = (responderId: string, chatId: string, chatType: string) => boolean;

type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

function promptsDir(): string {
  return statePath("prompts");
}

function requestPath(nonce: string): string {
  return join(promptsDir(), `${nonce}.json`);
}

function answerPath(nonce: string): string {
  return join(promptsDir(), `${nonce}.answer.json`);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(promptsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function remove(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

function clip(text: string, max: number): string {
  const clean = text.replace(/[\r\n]+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function callback(nonce: string, action: string, value?: number): string {
  return `qa:${nonce}:${action}${value == null ? "" : `:${value}`}`;
}

function currentQuestion(request: PromptRequest): PromptQuestion {
  const question = request.questions[request.questionIndex];
  if (!question) throw new Error("Telegram prompt question index is invalid");
  return question;
}

function render(request: PromptRequest): { text: string; reply_markup: InlineKeyboard } {
  const question = currentQuestion(request);
  const lines = request.questions.length > 1 ? [`Question ${request.questionIndex + 1}/${request.questions.length}`] : [];
  lines.push(question.question.trim());
  const pageCount = Math.max(1, Math.ceil(question.options.length / OPTIONS_PER_PAGE));
  const page = Math.max(0, Math.min(request.page, pageCount - 1));
  const optionStart = page * OPTIONS_PER_PAGE;
  const visibleOptions = question.options.slice(optionStart, optionStart + OPTIONS_PER_PAGE);
  if (visibleOptions.some((option) => option.description?.trim())) {
    lines.push("");
    visibleOptions.forEach((option, offset) => {
      const index = optionStart + offset;
      const recommended = index === question.recommended ? " (recommended)" : "";
      lines.push(`${index + 1}. ${option.label}${recommended}${option.description?.trim() ? ` — ${option.description.trim()}` : ""}`);
    });
  }

  if (request.awaitingText) {
    lines.push("", question.options.length === 0 ? "Reply with your answer as the next message, or /cancel." : "Send your custom answer as the next message, or /cancel.");
    const textNav: Array<{ text: string; callback_data: string }> = [];
    if (request.questionIndex > 0) textNav.push({ text: "Back", callback_data: callback(request.nonce, "b") });
    textNav.push({ text: "Cancel", callback_data: callback(request.nonce, "x") });
    return {
      text: clip(lines.join("\n"), 4000),
      reply_markup: { inline_keyboard: [textNav] },
    };
  }

  const rows = visibleOptions.map((option, offset) => {
    const index = optionStart + offset;
    const checked = request.selectedIndices.includes(index);
    const marker = question.multi ? (checked ? "☑ " : "☐ ") : "";
    return [{ text: clip(`${marker}${option.label}`, 60), callback_data: callback(request.nonce, question.multi ? "t" : "s", index) }];
  });
  rows.push([{ text: "Other — type your own", callback_data: callback(request.nonce, "o") }]);
  if (question.multi) rows.push([{ text: "Done", callback_data: callback(request.nonce, "d") }]);
  if (pageCount > 1) {
    const pages: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) pages.push({ text: "Previous", callback_data: callback(request.nonce, "p", page - 1) });
    if (page + 1 < pageCount) pages.push({ text: "Next", callback_data: callback(request.nonce, "p", page + 1) });
    rows.push(pages);
  }
  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (request.questionIndex > 0) navigation.push({ text: "Back", callback_data: callback(request.nonce, "b") });
  navigation.push({ text: "Cancel", callback_data: callback(request.nonce, "x") });
  rows.push(navigation);
  return { text: clip(lines.join("\n"), 4000), reply_markup: { inline_keyboard: rows } };
}

function sameThread(message: Pick<TgMessage, "is_topic_message" | "message_thread_id">, threadId: number | undefined): boolean {
  return (message.is_topic_message ? message.message_thread_id : undefined) === threadId;
}

function formatOutcome(outcome: PromptOutcome): string {
  if (outcome.status === "answered") return "Answered.";
  if (outcome.status === "cancelled") return "Question cancelled.";
  if (outcome.status === "expired") return "Question expired.";
  return "Question cancelled because the task stopped.";
}

export function formatPromptResult(outcome: PromptOutcome): string {
  if (outcome.status !== "answered") return formatOutcome(outcome);
  if (outcome.answers.length === 1) {
    const answer = outcome.answers[0];
    const lines: string[] = [];
    if (answer.selectedOptions.length > 0) lines.push(`User selected: ${answer.selectedOptions.join(", ")}`);
    if (answer.customInput != null) lines.push(`User provided custom input: ${answer.customInput}`);
    if (answer.note != null) lines.push(`User added a note: ${answer.note}`);
    return lines.join("\n");
  }
  return `User answers:\n${outcome.answers
    .map((answer) => {
      const values = [...answer.selectedOptions, ...(answer.customInput == null ? [] : [answer.customInput])];
      const noteSuffix = answer.note == null ? "" : ` (note: ${answer.note})`;
      return `- ${answer.id}: ${values.join(", ")}${noteSuffix}`;
    })
    .join("\n")}`;
}

async function waitForPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, POLL_INTERVAL_MS);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class TelegramPromptController {
  readonly #call: TelegramCall;
  readonly #authorize: PromptAuthorization;
  readonly #now: () => number;
  readonly #nonce: () => string;
  readonly #waitForPoll: (signal?: AbortSignal) => Promise<void>;
  readonly #alive: (pid: number) => boolean;
  readonly #pid: number;

  constructor(options: {
    callTelegram: TelegramCall;
    authorize: PromptAuthorization;
    now?: () => number;
    nonce?: () => string;
    waitForPoll?: (signal?: AbortSignal) => Promise<void>;
    alive?: (pid: number) => boolean;
    pid?: number;
  }) {
    this.#call = options.callTelegram;
    this.#authorize = options.authorize;
    this.#now = options.now ?? Date.now;
    this.#nonce = options.nonce ?? (() => randomBytes(8).toString("base64url"));
    this.#waitForPoll = options.waitForPoll ?? waitForPoll;
    this.#alive = options.alive ?? isAlive;
    this.#pid = options.pid ?? process.pid;
  }

  async ask(
    target: PromptTarget,
    questions: PromptQuestion[],
    signal?: AbortSignal,
    opts?: { supersededText?: string },
  ): Promise<PromptOutcome> {
    if (!this.#authorize(target.responderId, target.chatId, target.chatType)) {
      throw new Error("The originating Telegram user is no longer authorized");
    }
    await this.pruneExpired();
    if (await this.#hasPending(target)) throw new Error("Another Telegram question is already pending in this topic");
    if (questions.length === 0) throw new Error("Telegram questions must not be empty");
    const nonce = this.#nonce();
    const request: PromptRequest = {
      version: 1,
      nonce,
      ...target,
      page: 0,
      messageId: 0,
      questions,
      questionIndex: 0,
      answers: [],
      selectedIndices: [],
      awaitingText: questions[0].options.length === 0,
      ownerPid: this.#pid,
    };
    const first = render(request);
    const sent = await this.#call<TgMessage>("sendMessage", {
      chat_id: target.chatId,
      ...(target.threadId != null ? { message_thread_id: target.threadId } : {}),
      text: first.text,
      reply_markup: first.reply_markup,
    });
    request.messageId = sent.message_id;
    await atomicJson(requestPath(nonce), request);

    let outcome: PromptOutcome;
    try {
      outcome = await this.#wait(nonce, signal);
    } finally {
      await remove(requestPath(nonce));
    }
    if (outcome.status === "expired" || outcome.status === "aborted") {
      const superseded = outcome.status === "aborted" && signal?.reason === PROMPT_SUPERSEDED && opts?.supersededText;
      await this.#edit(request, superseded ? opts.supersededText! : formatOutcome(outcome), { inline_keyboard: [] });
    }
    await remove(answerPath(nonce));
    return outcome;
  }

  async handleCallback(query: TgCallbackQuery): Promise<boolean> {
    const match = /^qa:([A-Za-z0-9_-]+):([a-z])(?::(\d+))?$/.exec(query.data ?? "");
    if (!match) return false;
    const [, nonce, action, rawValue] = match;
    const request = await readJson<PromptRequest>(requestPath(nonce));
    const message = query.message;
    if (
      !request ||
      !message ||
      !this.#alive(request.ownerPid) ||
      String(query.from.id) !== request.responderId ||
      String(message.chat.id) !== request.chatId ||
      message.message_id !== request.messageId ||
      !sameThread(message, request.threadId) ||
      !this.#authorize(request.responderId, request.chatId, message.chat.type)
    ) {
      await this.#answerCallback(query.id, "This question expired or belongs to another user.", true);
      return true;
    }

    if (action === "x") {
      await this.#finish(request, { status: "cancelled" });
      await this.#answerCallback(query.id);
      await this.#edit(request, formatOutcome({ status: "cancelled" }), { inline_keyboard: [] });
      return true;
    }
    if (action === "b" && request.questionIndex > 0) {
      request.questionIndex -= 1;
      request.page = 0;
      request.answers = request.answers.slice(0, request.questionIndex);
      request.selectedIndices = [];
      request.awaitingText = request.questions[request.questionIndex].options.length === 0;
      await atomicJson(requestPath(request.nonce), request);
      await this.#answerCallback(query.id);
      await this.#render(request);
      return true;
    }
    if (action === "p") {
      const page = Number.parseInt(rawValue ?? "", 10);
      const pageCount = Math.max(1, Math.ceil(currentQuestion(request).options.length / OPTIONS_PER_PAGE));
      if (!Number.isInteger(page) || page < 0 || page >= pageCount) return this.#invalidCallback(query.id);
      request.page = page;
      await atomicJson(requestPath(request.nonce), request);
      await this.#answerCallback(query.id);
      await this.#render(request);
      return true;
    }
    if (action === "o") {
      request.awaitingText = true;
      await atomicJson(requestPath(request.nonce), request);
      await this.#answerCallback(query.id, "Send your answer as the next message.");
      await this.#render(request);
      return true;
    }

    const question = currentQuestion(request);
    const index = Number.parseInt(rawValue ?? "", 10);
    if (action === "t") {
      if (!question.multi || !question.options[index]) return this.#invalidCallback(query.id);
      request.selectedIndices = request.selectedIndices.includes(index)
        ? request.selectedIndices.filter((selected) => selected !== index)
        : [...request.selectedIndices, index].sort((a, b) => a - b);
      await atomicJson(requestPath(request.nonce), request);
      await this.#answerCallback(query.id);
      await this.#render(request);
      return true;
    }
    if (action === "d") {
      if (!question.multi || request.selectedIndices.length === 0) {
        await this.#answerCallback(query.id, "Select at least one option, choose Other, or cancel.", true);
        return true;
      }
      await this.#answerCallback(query.id);
      await this.#completeQuestion(request, request.selectedIndices.map((selected) => question.options[selected]!.label));
      return true;
    }
    if (action === "s") {
      const option = question.options[index];
      if (question.multi || !option) return this.#invalidCallback(query.id);
      await this.#answerCallback(query.id);
      await this.#completeQuestion(request, [option.label]);
      return true;
    }

    return this.#invalidCallback(query.id);
  }

  async handleMessage(message: TgMessage): Promise<boolean> {
    const responderId = String(message.from?.id ?? "");
    const chatId = String(message.chat.id);
    if (!responderId || !this.#authorize(responderId, chatId, message.chat.type)) return false;
    let names: string[];
    try {
      names = await readdir(promptsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || name.endsWith(".answer.json") || name.includes(".tmp-")) continue;
      const request = await readJson<PromptRequest>(join(promptsDir(), name));
      if (
        !request ||
        !request.awaitingText ||
        !this.#alive(request.ownerPid) ||
        request.responderId !== responderId ||
        request.chatId !== chatId ||
        !sameThread(message, request.threadId)
      ) {
        continue;
      }
      // Mirror bridge's parseBotCommand: /cancel (and /cancel@bot) closes the prompt, while any
      // other bot command must reach the bridge dispatcher rather than be captured as a free-text
      // answer, so /stop and friends keep working while a prompt is awaiting text. A slash-prefixed
      // non-command (e.g. an "/absolute/path" answer) does not match and is captured normally.
      const slashCommand = /^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s|$)/.exec((message.text ?? "").trim());
      if (slashCommand) {
        if (slashCommand[1].toLowerCase() === "cancel") {
          await this.#finish(request, { status: "cancelled" });
          await this.#edit(request, formatOutcome({ status: "cancelled" }), { inline_keyboard: [] });
          return true;
        }
        return false;
      }
      const customInput = (message.text ?? message.caption ?? "").trim();
      if (!customInput) return true;
      const question = currentQuestion(request);
      const selected = request.selectedIndices.map((index) => question.options[index]!.label);
      await this.#completeQuestion(request, selected, customInput);
      return true;
    }
    return false;
  }

  async pruneExpired(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(promptsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
      const path = join(promptsDir(), name);
      // Answer artifacts GC by wall clock; live requests GC by owner-pid liveness
      // so a prompt never expires while its owning process is still waiting on it.
      if (name.endsWith(".answer.json")) {
        const answer = await readJson<PromptAnswerEnvelope>(path);
        if (!answer || answer.expiresAt > this.#now()) continue;
      } else {
        const request = await readJson<PromptRequest>(path);
        if (!request || this.#alive(request.ownerPid)) continue;
      }
      await remove(path);
      removed += 1;
    }
    return removed;
  }

  async #completeQuestion(request: PromptRequest, selectedOptions: string[], customInput?: string): Promise<void> {
    const question = currentQuestion(request);
    request.answers[request.questionIndex] = {
      id: question.id,
      question: question.question,
      selectedOptions,
      ...(customInput == null ? {} : { customInput }),
    };
    if (request.questionIndex + 1 < request.questions.length) {
      request.questionIndex += 1;
      request.page = 0;
      request.selectedIndices = [];
      request.awaitingText = request.questions[request.questionIndex].options.length === 0;
      await atomicJson(requestPath(request.nonce), request);
      await this.#render(request);
      return;
    }
    await this.#finish(request, { status: "answered", answers: request.answers });
    await this.#edit(request, formatPromptResult({ status: "answered", answers: request.answers }), { inline_keyboard: [] });
  }

  async #finish(request: PromptRequest, outcome: PromptOutcome): Promise<void> {
    await atomicJson(answerPath(request.nonce), { expiresAt: this.#now() + PROMPT_TTL_MS, outcome } satisfies PromptAnswerEnvelope);
    await remove(requestPath(request.nonce));
  }

  async #wait(nonce: string, signal?: AbortSignal): Promise<PromptOutcome> {
    // No wall-clock deadline: while this process is alive and waiting, the prompt
    // stays answerable (like the terminal picker). It settles only on an answer,
    // or when the parent turn aborts.
    for (;;) {
      if (signal?.aborted) return { status: "aborted" };
      const answer = await readJson<PromptAnswerEnvelope>(answerPath(nonce));
      if (answer) return answer.outcome;
      await this.#waitForPoll(signal);
    }
  }

  async #hasPending(target: PromptTarget): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(promptsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".answer.json") || name.includes(".tmp-")) continue;
      const request = await readJson<PromptRequest>(join(promptsDir(), name));
      if (
        request &&
        this.#alive(request.ownerPid) &&
        request.responderId === target.responderId &&
        request.chatId === target.chatId &&
        request.threadId === target.threadId
      ) {
        return true;
      }
    }
    return false;
  }

  async #render(request: PromptRequest): Promise<void> {
    const rendered = render(request);
    await this.#edit(request, rendered.text, rendered.reply_markup);
  }

  async #edit(request: PromptRequest, text: string, replyMarkup: InlineKeyboard): Promise<void> {
    await this.#call("editMessageText", {
      chat_id: request.chatId,
      message_id: request.messageId,
      text,
      reply_markup: replyMarkup,
    }).catch(() => undefined);
  }

  async #answerCallback(id: string, text?: string, showAlert = false): Promise<void> {
    await this.#call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    }).catch(() => undefined);
  }

  async #invalidCallback(id: string): Promise<true> {
    await this.#answerCallback(id, "That option is no longer available.", true);
    return true;
  }
}
