# Carried Patches

This fork maintains as few source modifications as possible. Every carried patch appears in the table below, including what changed, why, and its upstream status. On upstream catch-up, patches are re-applied from this documentation; they are never assumed to merge cleanly.

## Carried patches

| File | What it changes | Why | Upstream PR |
|------|-----------------|-----|------------|
| `src/reconcile-session.ts` (was `src/host-sweep.ts` before upstream 2.3.0 moved the constant) | Container idle-ceiling timeout is now configurable via the `NANOCLAW_IDLE_CEILING_MS` environment variable (integer milliseconds, default 30 minutes), read from either the process environment or the `.env` file. The validation accepts only positive integers; invalid or unset values fall back to the default. | The 30-minute hardcoded absolute idle ceiling is unsuitable for deployments where agents legitimately sit idle longer or should be reaped sooner. Making it tunable per-deployment enables production flexibility. | Not filed upstream; re-applied on the v2.4.0 catch-up 2026-09-24 |
| `src/delivery.ts`, `src/channels/adapter.ts`, `src/channels/channel-registry.ts` (the skill-installed `src/channels/whatsapp.ts` half is taken from the fork branch `per-agent-sender-label-channels`, rebased on upstream `channels`; on this fork's v2.4.0 tree the adapter's echo-label set is served from a cache refreshed asynchronously, because central-DB reads became async in 2.3.0 while upstream `channels` is still synchronous) | Per-agent sender label: delivery resolves the sending agent's label (container config `assistant_name`, else group name) and passes it as `OutboundMessage.senderLabel`; the WhatsApp adapter in shared mode prefixes outgoing text with that label instead of the install-wide `ASSISTANT_NAME`, and recognises any agent's label as a self-echo. | Several agents wired to one shared WhatsApp number were all labelled with the single `ASSISTANT_NAME`, so the reader could not tell which agent answered. | [nanocoai/nanoclaw#3509](https://github.com/nanocoai/nanoclaw/pull/3509) (trunk) + [#3510](https://github.com/nanocoai/nanoclaw/pull/3510) (`channels`) — branches `per-agent-sender-label`, `per-agent-sender-label-channels` on this fork; both rebased onto current upstream 2026-09-24 (lookups awaited after the 2.3.0 async DB seam) |

## Not in this fork

Deployment-side additions are configuration applied to an install, not fork
content, and none of them appear on this branch:

- Channel adapters and tools installed by upstream's own `/add-*` skills
  (for example a messaging channel adapter or a dashboard tool) — re-applied
  per deployment by running the skill.
- Container-image manifest additions (`container/cli-tools.json` entries and
  their guard tests) — re-applied per deployment from that deployment's
  configuration.
- Anything specific to one business (agent templates, personas, operational
  scripts) — lives in that business's own repository, never here.

## After an upstream catch-up

1. Fetch the upstream remote and merge or rebase this branch onto it.
2. Re-apply the carried patch above if the merge did not keep it (consult the
   table; the patch is small and self-contained).
3. Run the test suite.
4. Update the patch table if anything was upstreamed or newly carried.
