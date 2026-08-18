# Carried Patches

This fork maintains as few source modifications as possible. Every carried patch appears in the table below, including what changed, why, and its upstream status. On upstream catch-up, patches are re-applied from this documentation; they are never assumed to merge cleanly.

## Carried patches

| File | What it changes | Why | Upstream PR |
|------|-----------------|-----|------------|
| `src/host-sweep.ts` | Container idle-ceiling timeout is now configurable via the `NANOCLAW_IDLE_CEILING_MS` environment variable (integer milliseconds, default 30 minutes), read from either the process environment or the `.env` file. The validation accepts only positive integers; invalid or unset values fall back to the default. | The 30-minute hardcoded absolute idle ceiling is unsuitable for deployments where agents legitimately sit idle longer or should be reaped sooner. Making it tunable per-deployment enables production flexibility. | Offered upstream (draft prepared, not yet filed) |

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
