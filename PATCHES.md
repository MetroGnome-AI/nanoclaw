# Carried Patches

This fork maintains as few source modifications as possible. Every carried patch appears in the table below, including what changed, why, and its upstream status. On upstream catch-up, patches are re-applied from this documentation; they are never assumed to merge cleanly.

## Carried patches

| File | What it changes | Why | Upstream PR |
|------|-----------------|-----|------------|
| `src/host-sweep.ts` | Container idle-ceiling timeout is now configurable via the `NANOCLAW_IDLE_CEILING_MS` environment variable (integer milliseconds, default 30 minutes), read from either the process environment or the `.env` file. The validation accepts only positive integers; invalid or unset values fall back to the default. | The 30-minute hardcoded absolute idle ceiling is unsuitable for deployments where agents legitimately sit idle longer or should be reaped sooner. Making it tunable per-deployment enables production flexibility. | Offered upstream (draft prepared, not yet filed) |
| `src/delivery.ts`, `src/channels/adapter.ts`, `src/channels/channel-registry.ts`, `src/channels/whatsapp.ts` | Per-agent sender label: delivery resolves the sending agent's label (container config `assistant_name`, else group name) and passes it as `OutboundMessage.senderLabel`; the WhatsApp adapter in shared mode prefixes outgoing text with that label instead of the install-wide `ASSISTANT_NAME`, and recognises any agent's label as a self-echo. | Several agents wired to one shared WhatsApp number were all labelled with the single `ASSISTANT_NAME`, so the reader could not tell which agent answered. | to open (MetroGnome-AI/nanoclaw → nanocoai/nanoclaw) |

## Not patches

The following additions are not patches to upstream source; they are re-applied after catch-up using the methods indicated.

### Skill-installed upstream code

These files are upstream's own code copied in by upstream's installer skills:

- `src/channels/whatsapp.ts` — WhatsApp channel adapter (upstream skill re-applied via `/add-whatsapp`; NOTE: also carries the sender-label patch above — re-apply it after the skill re-install)
- `src/channels/whatsapp-registration.test.ts` — WhatsApp adapter test (upstream skill re-applied)
- `src/channels/index.ts` (import line) — Channel registry entry (upstream skill re-applied)
- `tools/clidash/` (entire directory) — Dashboard tool with configuration, public assets, tests (upstream skill re-applied via `/add-clidash`)

Re-application: run the corresponding `/add-*` skill after the catch-up merge.

### Image and configuration additions

These are additive manifest entries done the way upstream skills do it; they do not modify upstream source:

- `.gitignore` — Entries for local artifacts
- `.gitleaksignore` — Gitleaks allowlist entries for external secrets
- `container/agent-runner/src/providers/gmail-allow-pattern.test.ts` — Gmail provider test
- `container/agent-runner/src/providers/gmail-dockerfile.test.ts` — Gmail Dockerfile test
- `container/cli-tools.json` — CLI tool manifest entries for the container image
- `package.json` — Dependencies for the host (pnpm workspace)
- `src/gcal-dockerfile.test.ts` — Google Calendar Dockerfile test

Re-application: re-apply from configuration (environment setup, provider skill runs, manifest declaration). Lock files (`pnpm-lock.yaml`) are regenerated automatically.

### Local additions

- `scripts/chillx-chat.ts` — A terminal chat client that sends a message to a wired agent group over the host's CLI-channel socket and reads replies until the stream goes quiet. It modifies no upstream file. Slated to move to the platform repository's agent-runtime component as a generic client, at which point it leaves this fork.

Re-application: retained as-is after catch-up; it has no upstream dependencies beyond the CLI channel socket path.

## Does not belong in this repository

The following are business-specific templates and operational scripts:

- `templates/chillx/` (entire directory) — Agent-group templates, skills, and operational logic specific to one business. These belong in that business's own repository, not in the shared runtime, and are removed from this fork once that repository is authoritative.

These two paths are the only remaining places a business name appears in this repository, and both are scheduled to leave it. The carried patch itself was reworded on 2026-08-17 to drop a business-specific marker comment, so the source diff offered upstream is generic.

## After an upstream catch-up

1. Fetch the upstream project's remote and merge or rebase this fork's default branch onto it. (`origin` here is the fork; upstream is a second remote — confirm which is which before merging.)
2. Rebase or re-apply the carried patch to `src/host-sweep.ts` (consult this table).
3. Re-run the installer skills (`/add-whatsapp`, `/add-clidash`, etc.) to restore skill-installed code.
4. Re-apply configuration additions (environment variables, manifest entries, guard tests).
5. Run the test suite: `pnpm test` (host) and `bun test` (container-runner).
