# omp-telegram

Use Telegram to chat with your omp sessions and start new ones from your phone.

Each top-level omp session gets its own Telegram topic; task subagents stay in
their parent session's topic. A separate **omp control** topic is where you run
commands like `/spawn`, `/sessions`, `/cleanup`, and `/status`.

## What you need

- [omp](https://github.com/can1357/oh-my-pi) 16.3.12 or newer
- [Bun](https://bun.sh/) 1.3 or newer
- A Telegram bot from [@BotFather](https://t.me/BotFather)
- [herdr](https://herdr.dev/) for `/spawn`, `/sessions`, and stale-topic auto-resume

Regular Telegram chat works without herdr.

## 1. Install

```bash
git clone https://github.com/TerrifiedBug/omp-telegram.git
cd omp-telegram
omp plugin link .
```

There is no build step and no runtime dependency install.

## 2. Create your Telegram bot

1. Open [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the bot token.
4. In **Bot Settings**, enable topics for private chats.

## 3. Start the bridge

Open omp and run:

```text
/telegram token <your-bot-token>
/telegram on
```

`/telegram on` keeps the bridge enabled for future omp sessions.

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

## Use it

Inside **omp control**:

```text
/spawn       Choose a herdr space and start another omp session
/sessions    See live, unattached, and stale sessions
/cleanup     Delete stale and duplicate topics after explicit confirmation
/status      Check the bridge
/help        Show Telegram commands
```

Inside an omp session topic:

- Send a normal message to talk to that session.
- Use `/stop` to stop its current task.
- Use `/compact [focus]` to compact that session's context.
- Use `/model`, `/switch`, and `/thinking` to change that session with inline pickers.
- When omp needs a choice, the bot shows single-select, multi-select, and **Other**
  controls directly in Telegram.
- Send photos or files as normal Telegram attachments.
- If its omp process was closed, send a normal message to queue it and resume the exact saved session in its original herdr space. Another omp session must still be running to poll Telegram.

Replies stream back while omp is working.

## If something looks wrong

- **No omp control topic:** enable private-chat topics in BotFather, then restart the omp session polling Telegram.
- **`/spawn` says herdr is unavailable:** start omp inside a herdr-managed pane.
- **A running session has no topic:** restart that omp session, then check `/sessions` again.
- **A stale topic will not resume:** topics created before auto-resume, or outside herdr, must be resumed locally once to record their session and herdr identity.
- **The bot stops responding:** keep at least one omp session running. Another live session takes over polling automatically.

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
