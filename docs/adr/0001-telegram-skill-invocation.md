# Skills reach Telegram automatically; no slash-command relay

Telegram users invoke skills the same way local users do — by describing the
task in natural language. The bridge injects Telegram messages as ordinary user
turns, and skills are already listed in the session system prompt, so the model
auto-invokes a matching skill with no special syntax. We deliberately do **not**
relay `/skill:name`, enumerate skills in `setMyCommands`, or add `/skills`
discovery. Owner-only bridge/herdr control commands are a separate control plane
defined in ADR 0003; they never expand or inject omp commands.

## Considered Options

- **Slash-command relay** — parse `/name` from Telegram and expand it to the
  real skill/command prompt before injecting. Rejected: skills already
  auto-trigger, so it duplicates native behaviour; a `/`-command UX in a group
  chat invites confusion; and it only reaches skills anyway, since file/prompt
  commands (`expandSlashCommand`) and built-ins are not on the package's curated
  public API (`index.d.ts` re-exports only `loadSlashCommands as
  discoverSlashCommands` and `FileSlashCommand`).
- **Automatic only (chosen)** — rely on the system-prompt skill mechanism.

## Consequences

- `disable-model-invocation` skills (which never auto-trigger) are not reachable
  from Telegram. They are interactive/local by nature, so this is acceptable.
- If skills prove to under-trigger for Telegram messages in practice, the
  lightest fix is a one-line nudge in the injected `<telegram-message>` wrapper —
  not a command layer.
