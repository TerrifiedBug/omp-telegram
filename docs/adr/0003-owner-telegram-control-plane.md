# Owner-only Telegram commands control herdr from the poll-lock holder

Telegram exposes a small control plane for the sole paired operator. In an
owner-DM topics setup, the bridge creates one persistent `omp control` topic;
global command results and interactive pickers live there instead of inside an
agent conversation. The poll-lock-holding omp process handles those commands
before session-topic routing: `/spawn` lists open herdr spaces and starts omp in
a new unfocused tab; `/sessions` compares herdr processes with Telegram topic
claims; `/cleanup` removes stale and same-process duplicate topics after explicit
confirmation while preserving live sibling sessions; `/status` reports bridge
health. `/stop` remains session-topic-local so it aborts the correct in-process
agent turn.

This control plane is distinct from omp slash-command or skill invocation.
Normal Telegram messages still become user turns, and skills still trigger from
natural language as decided in ADR 0001.

## Considered Options

- **Native inline keyboard in the existing bridge (chosen)** — the poll-lock
  holder already receives every Telegram update and can invoke herdr's JSON CLI.
  A short-lived picker lists spaces, confirms duplicate sessions, revalidates the
  selection, and consumes the confirmation before starting a process.
  The dedicated control topic gives those global interactions a stable home.
  Commands entered elsewhere are executed centrally, post their result in
  `omp control`, and leave a redirect notice at the origin.
- **Owner-DM stale-topic auto-resume (chosen)** — a normal message to a dead
  topic claim queues the message and restarts the exact saved omp session in its
  original herdr space. The poller keeps one in-flight resume per topic, so
  concurrent messages cannot create duplicate processes. This remains part of
  the owner control plane; configured groups cannot start local processes.
- **Telegram Mini App** — rejected because a short list and confirmation need no
  hosted frontend, web authentication, deployment, or additional state model.
  Reconsider only for large searchable catalogs or rich launch configuration.
- **Standalone always-on relay** — deferred. Existing sessions retry the poll
  lock every 30 seconds, so the bridge fails over while any omp process remains.
  A relay becomes worthwhile only if Telegram must cold-start herdr when zero omp
  sessions are alive.
- **Relay arbitrary omp slash commands** — rejected by ADR 0001. Control commands
  operate herdr/bridge state; they do not expand prompts or inject command text.

## Security

Exactly one paired Telegram user is the operator. Commands and callback queries
require both that user's ID and their private-chat ID; group policies never grant
control authority. Once paired, other DMs cannot mint pairing codes. Historical
multi-user access state fails closed until repaired locally.

Callback data is short-lived and contains only opaque picker coordinates. Every
callback is reauthorized, the Telegram message ID is matched, stale selections
are rejected, and confirmation state is deleted before `herdr tab create` or
`pane run`. Stale-topic resume similarly requires the paired owner's private DM
and revalidates the saved workspace label and terminal identities. Herdr receives
a single shell command built only from single-quoted local cwd/session metadata;
Telegram message text is spooled as data and never shell-interpolated.

## Consequences

- At least one omp session must remain alive to receive commands.
- `/spawn` into a space with a live omp session requires a second confirmation;
  the new process claims another Telegram topic.
- A restarted process first re-adopts the topic for its exact session identity;
  legacy entries retain the dead-cwd fallback until they are claimed once.
- The Telegram poller now requests both `message` and `callback_query` updates.
- The command menu is registered only for private chats.
- The control-topic ID persists in `access.json`; it is reused across poller and
  omp restarts and cleared when ownership transfers.
