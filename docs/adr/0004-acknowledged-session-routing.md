# Session routing fails closed and acknowledges handoff

A Telegram message addressed to a configured session topic follows only that
topic's route. Missing, dead, or changed ownership produces an explicit failure
or the separate owner-DM auto-resume flow. The poll-lock holder never treats that
message as input for its own local session.

Cross-process handoff uses a durable routed envelope. `writeRouted` assigns a
stable identity, checks active envelopes and the accepted ledger for duplicates,
and writes the message as `queued`. An original message, an edited revision, and
a callback each have distinct identity rules.

`watchRoute` claims the envelope and writes `inflight` before calling the session.
It records the identity in the accepted ledger and removes the envelope only
after the consumer promise resolves. A rejected handoff is retried up to three
attempts. If the consumer process exits after the `inflight` write, the envelope
becomes `uncertain` and is retained. Automatic replay is unsafe because the
session may already have submitted the turn to omp.

The user sees the same lifecycle through one Telegram status message that is
edited in place. `accepted` means the turn was submitted to omp. It makes no
claim about an agent response. By default only `failed` and `uncertain` create
that message; `deliveryStatus all` also shows `received`, `queued`, and
`accepted`.

## Considered options

- Fall back to the poll-lock holder's session when a topic route is missing.
  Rejected because a valid message could reach the wrong workspace and agent
  conversation.
- Delete an envelope when a watcher reads it. Rejected because a process exit
  during submission would lose the only durable copy.
- Replay every abandoned `inflight` envelope. Rejected because process death
  cannot distinguish a submitted turn from one that stopped just before
  submission.
- Keep a claimed and acknowledged handoff with deduplication. Chosen because it
  preserves a clear boundary between queued, accepted, failed, and uncertain
  delivery.

## Consequences

- A live foreign session can accept the message after the poller process exits.
- The last 256 accepted identities per route prevent recent Bot API redelivery
  from creating another user turn.
- Definitive submission failures can retry. Uncertain handoffs require inspection
  instead of automatic replay.
- Route ownership errors stay visible and never widen delivery to a local
  fallback.
