# Telegram Bridge

Connects one paired Telegram operator to one or more omp coding sessions:
messages become user turns, and assistant output streams back into session topics.

## Language

**Bridge**:
The running Telegram transport and router shared by omp sessions.
_Avoid_: bot, integration, plugin

**Inbound**:
A Telegram message flowing into the omp session as a user turn.
_Avoid_: incoming

**Outbound**:
Assistant output flowing from the session back to a Telegram chat.
_Avoid_: outgoing, response

**Active chat**:
A Telegram chat currently mirroring the assistant's output. A chat becomes
active when it sends an inbound message and stops being active when the run
goes idle.
_Avoid_: current chat, live chat

**Notify chat**:
The chat that receives a notification when a local run goes idle. Distinct from
an active chat.
_Avoid_: alert chat

**Telegram-initiated run**:
An agent run whose first message came from Telegram.
_Avoid_: remote run

**Local run**:
An agent run started by the user typing directly in the omp session.
_Avoid_: laptop run, direct run

**Skill**:
A capability the model invokes on its own from natural language, because it is
listed in the session's system prompt. Reaches the model over Telegram with no
special syntax.
_Avoid_: command

**Slash command**:
An explicit-only instruction (`/name`) — prompt/file commands and built-ins —
that never auto-triggers and must be typed and expanded to take effect.
_Avoid_: skill

**Paired operator**:
The sole Telegram user whose private DM can send control commands and own
session topics. Group chat permissions never confer operator authority.
_Avoid_: admin, allowed user

**Control command**:
An owner-only Telegram bot command such as `/spawn` or `/sessions` that operates
the bridge or herdr. It is handled by the poll-lock holder and never injected as
an omp user turn. Distinct from an omp slash command.
_Avoid_: slash-command relay

**Control topic**:
The single persistent `omp control` thread where global control-command results
and interactive pickers live. It belongs to the paired operator, not an omp
session.
_Avoid_: session topic, project topic

**Herdr space**:
An open project context that may contain zero or more omp sessions.
_Avoid_: session, thread

**Omp session**:
One running omp agent process. Concurrent sessions in one herdr space remain
independent and receive distinct topics.
_Avoid_: space, topic

**Session topic**:
The Telegram thread claimed by an omp session. A restarted session in the same
directory can re-adopt a stale session topic for continuity.
_Avoid_: control topic, space, session

**Topic**:
A Telegram forum thread. Qualify it as a control topic or session topic when
the distinction matters.
_Avoid_: space, session

**Away**:
A state the user sets to signal they have stepped away from the machine. While
away, the result of a local run is delivered to Telegram instead of only
appearing on screen. Cleared by returning to the keyboard or turning it off.
_Avoid_: AFK, absent
