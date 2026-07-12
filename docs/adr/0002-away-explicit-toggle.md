# "Away" is an explicit laptop-wide toggle, not OS presence detection

When the user steps away from the machine, local-run results are delivered to
Telegram. Presence is signalled by an explicit `away` toggle (`/telegram away`),
persisted in the shared access file so it applies to every omp session on the
machine, and auto-cleared by the next interactive local keystroke. We
deliberately do **not** infer presence from the operating system.

## Considered Options

- **OS HID idle time** — read seconds since last keyboard/mouse input (verified
  working on macOS via `ioreg -c IOHIDSystem` → `HIDIdleTime`) and treat "idle >
  N minutes at run-end" as away. Rejected: macOS-only; the bridge is otherwise
  platform-agnostic, and a portable fallback would still be needed.
- **Input-inactivity timer** — time since the last local prompt. Rejected: during
  a run the user is not typing anyway, so it cannot distinguish "away" from
  "watching it work" — ambiguous exactly when it matters.
- **Explicit toggle (chosen)** — deterministic, portable, zero false positives.
  Auto-clear keys on `InputEvent.source === "interactive"`, so a phone reply
  (which arrives as `source: "extension"`) never counts as presence.

## Consequences

- Away is a property of the human at the machine, not of a single session:
  arming covers all sessions; any session's local keystroke disarms all of them.
  Actively working in one session while monitoring another on the phone is
  therefore *not* supported — that would be a separate per-session feature.
- Presence is only as accurate as the user remembering to arm it; the cost of
  forgetting is a missed phone update, not a broken session.
