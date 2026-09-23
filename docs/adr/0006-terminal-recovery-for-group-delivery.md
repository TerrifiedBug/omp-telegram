# Group-hosted reply recovery stays in the local terminal

Before an automatic final reply is sent or edited, the bridge stores its parts in
a durable outbox. Each part is saved as `pending`, `inflight`, `sent`, `failed`,
or `uncertain` before and after Bot API attempts. Sent parts are skipped on
recovery, a fully sent record is removed, and the 50 most recently updated
records are retained.

A normal retry resends failed parts. It leaves `inflight` and `uncertain` parts
alone because Telegram may already have accepted them. The user must check the
chat and add `uncertain` to opt into that duplication risk.

The paired owner can run `/retry` inside an owner-DM session topic. A
forum-supergroup topic cannot carry owner authority, even when it is configured
as a prompt source. An undelivered reply for a group-hosted session is therefore
recoverable only from an omp terminal with
`/telegram retry <chat_id> [thread_id] [uncertain]`. The local failure notice
prints the exact command for that destination.

## Considered options

- Accept `/retry` from a group topic. Rejected because this would grant a group
  control authority that every other session command denies.
- Retry uncertain parts automatically. Rejected because a timeout or process
  exit can happen after Telegram accepted the message.
- Keep failed content only in memory. Rejected because a process restart would
  remove the reply and its recovery state.
- Use a durable outbox with destination-specific manual recovery. Chosen because
  confirmed parts stay idempotent and ambiguous delivery requires a deliberate
  decision.

## Consequences

- Automatic final replies survive process restarts while their outbox records
  remain among the 50 most recently updated entries.
- `/retry` is available in the paired owner's DM session topic.
- Group-hosted failures require terminal access and preserve the DM-only control
  boundary.
- Retrying with `uncertain` can duplicate a message that already arrived, so the
  command keeps that option explicit.
