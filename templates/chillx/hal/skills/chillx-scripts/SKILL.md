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
├── lead.mjs                  # lead skill orchestrator (WRITES via erp-svc)
├── docs.mjs                  # docs skill orchestrator
├── quote.mjs                 # quote skill orchestrator
├── mirror-query.mjs          # data-mirror SQL query tool (RUN WITH BUN)
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
- **The injected ERPNext credential is READ-ONLY (erp-read).** Direct writes
  to ERPNext return 403 by design. All writes go through erp-svc (below).
- Business profile (read-only mount): `/workspace/extra/business-profile/`.

## Data mirror (READ path — use FIRST for data questions)

`/workspace/extra/chillx-mirror/mirror.db` is a read-only SQLite snapshot of
ERPNext core doctypes (items, customers, leads, quotations, sales_orders,
sales_invoices, payment_entries, delivery_notes, boms, serial_nos, bins,
contacts, addresses, communications, todos + child tables like
sales_order_items) and Drupal commerce (drupal_commerce_orders,
drupal_commerce_line_items, drupal_order_statuses). Rebuilt hourly at :20.

```bash
bun /home/node/.claude/skills/chillx-scripts/scripts/mirror-query.mjs --tables
bun /home/node/.claude/skills/chillx-scripts/scripts/mirror-query.mjs \
  "SELECT status, COUNT(*) n FROM sales_orders WHERE docstatus=1 GROUP BY status"
```

Rules (data-access doctrine, Phase B.1):
- Data questions hit the **mirror FIRST** — it is fast and fresh-within-an-hour.
- Use a **live ERPNext GET** only when freshness is critical (e.g. "did the
  payment just land?"), and prefer narrow queries.
- **Always state which source you used** (mirror + its refreshed_at, or live).
- Run mirror-query with `bun` (it uses bun:sqlite), not `node`.

## erp-svc (WRITE path — capability service)

ERPNext writes go through the erp-svc capability container
(`http://host.docker.internal:8010`, bypass the gateway proxy — node:http in
scripts, or `curl --noproxy '*'` by hand). It holds the scoped erp-sales
credential and audit-logs every request. Endpoints: `POST /lead`,
`POST /item`, `GET /health`. Anything else is rejected 404.

Run everything with `node`, e.g.:

```bash
node /home/node/.claude/skills/chillx-scripts/scripts/lead.mjs --dry-run ...
```
