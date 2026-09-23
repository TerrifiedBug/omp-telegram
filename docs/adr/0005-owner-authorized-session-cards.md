# Session cards carry owner authority to one exact session

`/session` opens a status card for the live omp session attached to an owner-DM
session topic. `/sessions` adds a button for each published live session,
including those whose topics are hosted in a configured group. The card shows
runtime state, session identity, directory, model, thinking level, context use,
pending-message state, and last activity. It provides Refresh, Stop, Model,
Thinking, and Compact actions.

Only the paired owner can open or use a session card. The controller binds each
card to its Telegram message, owner, process, session ID, destination chat, and
topic. Every action reloads access and the live session snapshot before it acts.
The receiving session checks the owner and exact route again before dispatching
the synthetic command.

A configured group grants prompt delivery and prompt-answer authority. It holds
no operator authority. A group-hosted session is controlled from the owner's
private DM through `/sessions`; ordinary group commands and callbacks cannot
stop it or change its model, thinking level, or context.

## Considered options

- Allow session commands in the configured group. Rejected because every group
  member allowed to send prompts would gain process control.
- Bind a card only to a process ID. Rejected because a stale card could address a
  replacement process or a different resumed conversation.
- Store an owner-authorized binding and revalidate it at each hop. Chosen because
  the card can survive poller handoff while stale or transferred ownership fails
  closed.

## Consequences

- Session list pickers expire after five minutes. An opened card remains usable
  only while the exact session and route stay live.
- Session status publications edit bound cards in place. Refresh reads the same
  durable snapshot explicitly.
- Stop, Model, Thinking, and Compact enter the existing session command path
  instead of adding a second control implementation.
- Removing the owner, changing the target route, stopping the process, or
  replacing the session invalidates the card.
