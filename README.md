# omp-telegram

Use Telegram to chat with your omp sessions and start new ones from your phone.

Each top-level omp session gets its own Telegram topic; task subagents stay in
their parent session's topic. A separate **omp control** topic is where you run
commands like `/spawn`, `/sessions`, `/cleanup`, and `/status`.

## What you need

- [omp](https://github.com/can1357/oh-my-pi) 17.0.0 or newer
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

Open omp and run:

```text
/telegram token <your-bot-token>
/telegram on
```

`/telegram on` keeps the bridge enabled for future omp sessions.

With owner-DM topics enabled and no groups configured, `/telegram on` also
starts a laptop-wide Bun daemon. It keeps polling when every omp session is
closed, so a message to a saved session topic can resume that session. Other
configurations use a live omp session as the poller.

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

## Use it

Inside **omp control**:

```text
/spawn                         Choose a herdr space and start another omp session
/spawn new <branch> [space]    Create a worktree from a space and start omp
/spawn dir <absolute-path>     Create a herdr workspace and start omp
/sessions                      See live, unattached, and stale sessions
/cleanup                       Preview exited-session topics, then tap to delete (DM) or close (group); /cleanup go skips the tap
/status                        Check the bridge
/help                          Show Telegram commands
```

Inside an omp session topic:

- Send a normal message to talk to that session.
- Use `/stop` to stop its current task.
- Use `/compact [focus]` to compact that session's context.
- Use `/model` and `/thinking` to change that session with inline pickers.
- When omp needs a choice, the bot shows single-select, multi-select, and **Other**
  controls directly in Telegram.
- When omp waits more than two seconds for tool approval, the bot pings the
  active session topic. Approval still happens at the terminal.
- Send photos or files as normal Telegram attachments.
- Voice notes are saved as attachments. To append a local transcript to the
  agent prompt, configure a no-shell argv template:

  ```text
  /telegram set transcribeCommand ["whisper-cli","-f","{file}"]
  ```
- If its omp process was closed, send a normal message to queue it and resume
  the exact saved session in its original herdr space.

Replies stream back while omp is working.

## Away mode (answer local runs from your phone)

Runs you start at the terminal don't touch Telegram by default. When you're
stepping away, flip **away mode** so those runs reach your phone:

- `/away` — quick sticky toggle. Run it, then kick off your work and walk away;
  run it again when you're back.
- While away, any `ask` the agent raises is shown on **both** your terminal and
  Telegram at once — answer wherever you are, first one wins. Idle-completion
  pings go to Telegram too.
- Pick the destination once with `/telegram notify <chat_id>` (or turn on
  per-session `/telegram topics`). `/telegram notify away | always | off` is the
  full surface; `always` is the standing "mirror even at my desk" mode.

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
```
