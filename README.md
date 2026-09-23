# omp-telegram

Use Telegram to chat with your omp sessions and start new ones from your phone.

Each top-level omp session gets its own Telegram topic; task subagents stay in
their parent session's topic. A separate **omp control** topic is where you run
commands like `/spawn`, `/sessions`, `/cleanup`, and `/status`.

## What you need

- [omp](https://github.com/can1357/oh-my-pi) 18.1.16 or newer
- [Bun](https://bun.sh/) 1.3 or newer
- A Telegram bot from [@BotFather](https://t.me/BotFather)
- [herdr](https://herdr.dev/) for `/spawn`, `/sessions`, and stale-topic auto-resume

Regular Telegram chat works without herdr.

## 1. Install

```bash
omp plugin install omp-telegram
```

There is no build step and no runtime dependency install.

## 2. Create your Telegram bot

1. Open [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the bot token.
4. In **Bot Settings**, enable topics for private chats, and turn **off**
   "allow users to create topics". The bot creates one topic per omp session
   itself; leaving user creation on means a command like `/spawn` typed outside
   an existing topic makes Telegram spin up a throwaway topic to hold it. If it
   is left on, `/status` and `/telegram doctor` flag it.

## 3. Start the bridge

Run the guided setup in an interactive omp terminal:

```text
/telegram setup
```

Setup validates the configured token or asks for a new one, enables the bridge,
walks through owner pairing, offers session topics when the bot supports them,
and finishes with diagnostics.

If setup completes, continue at [Use it](#use-it). The remaining numbered steps
show the manual path.

To configure it manually, run:

```text
/telegram token <your-bot-token>
/telegram on
```

`/telegram on` keeps the bridge enabled for future omp sessions. With owner-DM
topics enabled and no groups configured, it also starts a laptop-wide Bun
daemon. The daemon keeps polling when every omp session is closed, so a message
to a saved session topic can resume that session. Other configurations use a
live omp session as the poller.

## 4. Pair your Telegram account

1. Send any normal message to your new bot.
2. The bot replies with a short pairing code.
3. Back in omp, run:

```text
/telegram pair <code>
```

Only one Telegram account can own the bridge.

## 5. Turn on session topics

In omp, run:

```text
/telegram topics on
```

The bot creates:

- **omp control** — bridge commands live here.
- One topic for each omp session — chat with that session here.

Restart any omp sessions that were already running before you enabled topics so
they can claim their own topic.

Topics persist and are re-adopted on restart. To tidy them automatically instead,
run `/telegram topics tidy on` — each session's topic is deleted (DM host) or
closed and reopened on re-adoption (group host) when it exits. Sweep leftovers from
crashed sessions with `/cleanup`.

Messages inside a session topic still route to that topic's session. A private
DM outside a topic goes to a persisted DM-owner session. The first enabled
session claims ownership, and a resumed session reclaims it by session file.
Run `/telegram own [status|clear]` to manage the owner. Set
`OMP_TELEGRAM_DM_OWNER=1` in a fleet or conductor session to force its claim at
each start. If the saved owner is not running, the bot refuses the DM and names
the required recovery action.

## Use it

Inside **omp control**:

```text
/spawn                         Choose a herdr space and start another omp session
/spawn new <branch> [space]    Create a worktree from a space and start omp
/spawn dir <absolute-path>     Create a herdr workspace and start omp
/sessions                      See sessions and open a session card
/cleanup                       Preview exited-session topics, then tap to delete (DM) or close (group); /cleanup go skips the tap
/status                        Check the bridge
/help                          Show Telegram commands
```

Inside an owner-DM session topic, the paired owner can:

- Send a normal message to talk to that session.
- Use `/session` to see its state, model, thinking level, context use, pending
  message state, and last activity. Its Refresh, Stop, Model, Thinking, and
  Compact buttons act on that exact live session.
- Use `/stop` to stop its current task.
- Use `/compact [focus]` to compact that session's context.
- Use `/model` and `/thinking` to change that session with inline pickers.
- Use `/retry` to resend failed reply parts.
  `/retry uncertain` also resends parts that Telegram may already have accepted,
  so it can duplicate a message.
- When omp needs a choice, the bot shows single-select, multi-select, and
  **Other** controls directly in Telegram.
- Send photos or files as normal Telegram attachments. Photo albums arrive as
  one omp request. If an attachment cannot be processed, the bot posts a
  visible failure notice and still submits any usable text or caption.
- Replies include quoted context from the Telegram message you answered.
- Voice notes are saved as attachments. With transcription configured, a voice
  note can also answer a pending free-text question. Configure a no-shell argv
  template with:

  ```text
  /telegram set transcribeCommand ["whisper-cli","-f","{file}"]
  ```
- If its omp process was closed, send a normal message to queue it and resume
  the exact saved session in its original herdr space.

If a message can't reach omp, the bridge replies to it with `failed` and the
reason. `uncertain` means the session stopped during handoff and the turn may
already have reached omp. The bridge never retries an uncertain handoff on its
own, because that could duplicate the user turn.

When delivery works, the bot reacts 👀 once omp takes your message and switches
to 👍 when a reply reaches the chat. Telegram doesn't let bots react with a
check mark, so 👍 stands in. Run `/telegram set deliveryStatus failures` to
turn the reactions off. A config that already sets `ackReaction` keeps that
emoji instead.

To see progress on every message, run `/telegram set deliveryStatus all`. Each
message then gets one status reply that the bridge edits in place: `received`
when the bridge sees it, `queued` when it enters session routing, and
`accepted` when omp takes the user turn, before any agent reply.

Automatic final replies use a durable, 50-record outbox. Failed parts remain
available for `/retry` while their record is retained. Run `/retry` in the
owner's DM session topic. A group cannot grant control authority, so recover a
group-hosted topic locally with
`/telegram retry <chat_id> [thread_id] [uncertain]`.

Replies stream back while omp is working unless the host uses the headless
profile described below.

## Away mode (answer local runs from your phone)

Runs you start at the terminal don't touch Telegram by default. When you're
stepping away, flip **away mode** so those runs reach your phone:

- `/away` — quick toggle. Run it, then kick off your work and walk away; it
  auto-clears when you next type a prompt at the terminal (or run it again).
- While away, any `ask` the agent raises is shown on **both** your terminal and
  Telegram at once — answer wherever you are, first one wins. Idle-completion
  pings go to Telegram too.
- Pick the destination once with `/telegram notify <chat_id>` (or turn on
  per-session `/telegram topics`). `/telegram notify away | always | off` is the
  full surface; `always` is the standing "mirror even at my desk" mode.

## Headless hosts

On a machine nobody sits at — a scheduler, or a fleet orchestrator whose runs are
cron ticks — the laptop defaults are backwards: every turn of a long task arrives
as its own message, and each run's closing text gets posted when it goes idle.
One key switches all of that:

```text
/telegram set profile daemon
```

Assistant text then never auto-relays: it reaches Telegram only when the agent
calls `telegram_send` or `telegram_ask`, so an answer is one message and internal
working text stays on the host. `telegram_ask` is also kept mounted and pointed at
you on every turn, including scheduled ones, so a run that needs a decision can
always reach you. Tool-approval and blocked-input pings still fire — those mean
something needs a human. `/telegram status` shows the profile and the output mode
actually in force.

## If something looks wrong

- Start with `/telegram doctor`. It checks token validity, webhook conflicts,
  daemon and poll-lock state, state-file permissions, optional binaries, and
  herdr reachability without printing the bot token.
- **No omp control topic:** enable private-chat topics in BotFather, then run
  `/telegram daemon restart`.
- **`/spawn` says herdr is unavailable:** run omp inside a herdr-managed pane;
  `/spawn dir` can create a workspace from any existing herdr session.
- **A running session has no topic:** restart that omp session, then check
  `/sessions` again.
- **A stale topic will not resume:** legacy topics and sessions started outside
  herdr must be resumed locally once to record their session and herdr identity.
- **The bot stops responding:** run `/telegram doctor`, then
  `/telegram daemon restart`. A session poller takes over when the daemon is
  disabled or unavailable.

## Security

Treat every permitted Telegram sender as an omp user with the session's normal
workspace and tool access. Only configure trusted groups, prefer group sender
allowlists, and never use `--no-mention` in a public or untrusted group.

Downloaded attachments are limited to 20 MiB each, expire after 7 days, and are
pruned oldest-first when the inbox exceeds 250 MiB.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## More

The full command reference, group setup, security model, state files, streaming
behavior, and design notes are in the **[complete guide](docs/guide.md)**.

Architecture decisions live in [`docs/adr/`](docs/adr/).

## Development

```bash
bun install --frozen-lockfile
bun run check
bun run check:host -- 18.1.16
bun run check:host -- latest
bun run smoke:package
```

CI runs the locked dependency check, host compatibility against the minimum and
latest omp versions, and a smoke check against the packed npm artifact.
