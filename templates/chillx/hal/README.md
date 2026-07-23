# chillx/hal — HAL, the CHILLX infra/ops persona

NanoClaw v2 agent template for **HAL**, the internal infrastructure/operations
persona of CHILLX Chillers (Bertram, TX). Wave 1 of the CHILLX v1→v2 migration:
read/draft-heavy skills only, low blast radius.

Stamp with:

```bash
./bin/ncl groups create --template chillx/hal --name "HAL"
```

## What's inside

| Path | Purpose |
|------|---------|
| `context/instructions.md` | Persona: senior-ops voice (HAL 9000 delivery, none of the sinister traits), hard rules, capabilities. The "Dave" address convention is a clearly-marked standing gag — one paragraph, trivially removable. |
| `skills/lead/` | ERPNext Lead create/enrich (dedup, equipment tags) |
| `skills/docs/` | Business docs + canonical profile facts (see degradations) |
| `skills/add-item/` | New ERPNext Item + Item Prices with CHILLX defaults |
| `skills/sales-analysis/` | Chiller sales analysis (ERPNext source live) |
| `skills/quote/` | FedEx/EchoShip rate quotes (see degradations) |
| `skills/chillx-scripts/` | Shared script bundle the five skills call (`scripts/` + `lib/`), ported from v1 `/home/eggers/nanoclaw/scripts` with container-safe paths |

No `.mcp.json` — wave 1 needs no MCP servers.

## Wave 2 (deliberately NOT in this template)

`ship`, `dropship-po`, `closeout-po`, `helcim-invoice`, `paypal-invoice`,
`quote-to-invoice` — money/physical actions. Deferred until wave-1 credentials
and approval policies are proven in production.

## Credentials — how they reach the container

**No secrets live in this template, the group env, or chat context.** Per
`docs/templates.md` ("MCP servers and credentials"), credentials are held by
the OneCLI credentials proxy and injected into outbound HTTPS calls at the
proxy boundary, matched by API host, at request time.

Wave-1 wiring (done at install, machine-local):

1. OneCLI vault secret of type `generic`, host-pattern = the ERPNext host,
   header `Authorization`, value-format `token {value}`, value
   `<api_key>:<api_secret>`.
2. The stamped agent's OneCLI identity (identifier = agent group id, created
   by `ensureAgent()` at first spawn) must have `secretMode: all`.
3. `/workspace/agent/.chillx-env` (machine-local file in the group folder,
   gitignored) carries `ERPNEXT_URL` (not a secret) plus **placeholder**
   `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` so the v1-ported scripts can build a
   syntactically-valid Authorization header; the proxy replaces it with the
   real credential in flight (see `container/skills/onecli-gateway`).

## Post-stamp install steps (machine-local, not part of the template)

1. Allow the business-profile mount root in `~/.config/nanoclaw/mount-allowlist.json`:
   `/home/eggers/nanoclaw/data/business-profile` (read-only).
2. Add to the group's container config `additional_mounts`:
   `{"hostPath": "/home/eggers/nanoclaw/data/business-profile", "containerPath": "business-profile", "readonly": true}`
   → appears in-container at `/workspace/extra/business-profile` (chillx.yaml,
   label-vocabulary.yaml).
3. Write `groups/<folder>/.chillx-env` (see above).
4. Create the OneCLI secret + set the agent's secretMode to `all`.
5. Wire a channel: `./bin/ncl wirings create --messaging-group-id <mg> --agent-group-id <ag> --engage-mode pattern --engage-pattern "."`.

## Known degradations in this deployment (wave 1)

- **docs `send`** — unavailable (needs the Gmail client + credentials; wave 2).
  `profile` and `list-docs` are fully live. `fill` remains the v1 stub and
  additionally lacks `pdf-lib` in the container.
- **quote live rates** — FedEx/EchoShip credentials are not in the vault yet
  (wave 2); destination resolution via ERPNext works, rate calls will surface
  a gateway connect link. `--drupal` resolution needs Drupal creds (wave 2).
- **sales-analysis** — ERPNext only; Drupal/GDocs/GSheets sources unavailable.
- **gen-payment-instructions.mjs** — not shipped (money-adjacent; wave 2).

## Script porting notes (v1 → v2 container)

- `.env` reads → `CHILLX_ENV_FILE` || `/workspace/agent/.chillx-env`,
  tolerant of absence; `process.env` always wins over the file.
- Business profile path → `CHILLX_PROFILE`/`CHILLX_PROFILE_DIR` ||
  `/workspace/extra/business-profile/`.
- YAML parsing → vendored `js-yaml.mjs` (container has no python3/PyYAML).
- EchoShip shipment cache → `ECHOSHIP_CACHE` ||
  `/workspace/agent/data/echoship/shipments.json`.
- Gmail client import is lazy and fails with a clear wave-2 message.

## Future embodiment note (do NOT build yet)

If/when HAL gets an audible/TTS embodiment: deep, calm, deliberately-paced
male voice. Google Chirp3-HD is the candidate to audition. Text persona only
for now — no TTS wiring.
