# Notifications are an explicit mode, not OS presence detection

Local runs mirror nothing by default. Notifications — an idle ping when a run
finishes, and a blocked ping when it parks for a tool approval or an `ask`
prompt — are gated by an explicit `/telegram notify` mode, persisted in the
shared access file so it applies to every omp session on the machine. We
deliberately do **not** infer presence from the operating system.

Modes:

- **away** — notify only while the user has stepped away; auto-cleared by the
  next interactive local keystroke (`InputEvent.source === "interactive"`), so a
  phone reply (`source: "extension"`) never counts as presence.
- **always** — notify regardless. For juggling several herdr sessions the user
  isn't actively watching, where a keystroke in one shouldn't silence the rest.
- **off** — nothing pings.

## Considered Options

- **OS HID idle time** — read seconds since last keyboard/mouse input (verified
  working on macOS via `ioreg -c IOHIDSystem` → `HIDIdleTime`) and treat "idle >
  N minutes at run-end" as away. Rejected: macOS-only; the bridge is otherwise
  platform-agnostic, and a portable fallback would still be needed.
- **Input-inactivity timer** — time since the last local prompt. Rejected: during
  a run the user is not typing anyway, so it cannot distinguish "away" from
  "watching it work" — ambiguous exactly when it matters.
- **Explicit mode (chosen)** — deterministic, portable, zero false positives. The
  `away` mode auto-clears on interactive input; `always` opts out of that
  auto-clear for the multi-session case the HID/inactivity heuristics get wrong.

## Consequences

- The retired boolean `away` flag migrates to `notifyMode: "away"` on first load,
  so existing state keeps working after the reframe.
- `away` is a property of the human at the machine, not of a single session:
  arming covers all sessions; any session's local keystroke disarms all of them.
  `always` is the escape hatch for actively working in one session while
  monitoring another — the case `away` deliberately does not support.
- Presence is only as accurate as the user remembering to arm it; the cost of
  forgetting is a missed phone update, not a broken session.
