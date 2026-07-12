# Security policy

## Supported versions

Security fixes are provided for the latest released `0.1.x` version until a newer
release line replaces it.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting flow:

<https://github.com/TerrifiedBug/omp-telegram/security/advisories/new>

Include:

- the affected version or commit;
- the required Telegram access state (unpaired DM, paired owner, configured group);
- reproduction steps and impact;
- whether a bot token or other credential may have been exposed.

If a credential was exposed, revoke or rotate it immediately. A report is not a
reason to keep using a compromised token.

## Security model

One paired private-DM operator owns control commands. Configured groups can send
normal omp user prompts but never receive bridge-control authority. Because those
prompts retain the session's normal workspace and tool access, only trusted groups
and sender IDs should be configured.
