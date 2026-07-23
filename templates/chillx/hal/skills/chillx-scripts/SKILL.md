---
name: chillx-scripts
description: Internal support bundle — shared CHILLX scripts and libraries used by the lead, docs, add-item, sales-analysis, and quote skills. Not directly user-invokable; do not trigger this skill on its own. Scripts live under this skill's scripts/ directory and are run with node.
---

# CHILLX shared script bundle (support — not a user-facing skill)

This folder carries the deterministic scripts the CHILLX wave-1 skills call,
ported from the v1 install. Nothing here is invoked directly by a user
request — the `lead`, `docs`, `add-item`, `sales-analysis`, and `quote`
skills reference these files by absolute path.

## Layout

```
scripts/
├── lead.mjs                  # lead skill orchestrator
├── docs.mjs                  # docs skill orchestrator
├── quote.mjs                 # quote skill orchestrator
└── lib/
    ├── phone.mjs             # phone normalization (shared with lead dedup)
    ├── intro/run-log.mjs     # append-only run log (~/.claude/projects/.../intro/)
    ├── docs/                 # profile.mjs (canonical profile), send.mjs, fill.mjs
    ├── shipping/             # erp.mjs (ERPNext client), fedex.mjs, echoship.mjs,
    │                         # resolve-destination.mjs, dims.mjs
    └── vendor/js-yaml.mjs    # vendored YAML parser (no python3 in container)
```

## Environment contract

- Env file: `CHILLX_ENV_FILE` || `/workspace/agent/.chillx-env` (loaded by the
  scripts themselves; absence is tolerated, `process.env` wins).
- `ERPNEXT_URL` is real; `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` are
  placeholders — the OneCLI gateway injects the real Authorization header at
  request time. Never ask for real keys.
- Business profile (read-only mount): `/workspace/extra/business-profile/`.

Run everything with `node`, e.g.:

```bash
node /home/node/.claude/skills/chillx-scripts/scripts/lead.mjs --dry-run ...
```
