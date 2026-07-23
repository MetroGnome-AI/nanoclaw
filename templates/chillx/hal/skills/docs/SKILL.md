---
name: docs
description: Send CHILLX business documents (W-9, COI, sales tax permit, voided check, formation cert) to vendors/customers; look up canonical business profile facts (EIN, sales tax permit#, bank ref, trade refs). Triggers on "send Acme our W-9", "send X the COI", "what's our EIN", "send Y the sales tax permit", "what's our sales tax exempt number", "what trade references should I list for the Samuel form". Enforces sensitive-data rules — wire/bank account info ONLY goes via attached PDF, never inline.
---

# Docs discipline (lock-execute)

Single entry point for CHILLX business documents and canonical facts. Sensitive
data (bank account, routing #) is locked into attached-PDF-only paths.

**Script path (v2 container):** `DOCS=/home/node/.claude/skills/chillx-scripts/scripts/docs.mjs`

> **Wave-1 deployment note:** the `send` submode (Gmail drafting) is
> UNAVAILABLE here — it needs the Gmail client + credentials (wave 2). If asked
> to send a document, look up what's requested with `profile`/`list-docs`,
> then tell the user drafting must happen on the host install for now.
> `fill` remains a stub. `profile` and `list-docs` are fully live (canonical
> profile is mounted read-only at `/workspace/extra/business-profile/`).

## When to invoke

- "What's our EIN" / "What's our sales tax exempt #" / "What's our routing number"
- "What trade references should I use for the Samuel-Son form"
- Any vendor/customer onboarding doc request ("send Acme our W-9" — see wave-1 note above)

NOT for: TX Form 01-339 generation (host-side `/tax-exemption`, not installed here).

## How to operate

1. **Declare:** "Entering lock-execute discipline (docs)."
2. **Identify the submode:**
   - `profile` — reading a canonical fact (LIVE)
   - `list-docs` — listing the alias vocabulary (LIVE)
   - `send` — Gmail drafting (wave 2 — do not attempt; explain)
3. **Run the script:**
   ```bash
   node $DOCS profile [field.path]
   node $DOCS list-docs
   ```
4. **Report** the value + its sensitivity tag.

## Submode: profile

Read-only access to the canonical business profile.

```bash
node $DOCS profile                          # full dump
node $DOCS profile entity.ein               # 26-2164147
node $DOCS profile entity.sales_tax_exempt_no
node $DOCS profile bank_reference           # full bank block
node $DOCS profile contacts.ap.email        # AP@ChillXChillers.com
node $DOCS profile officers                 # Robert + ownership
node $DOCS profile trade_references         # full pool
```

Sensitivity tag is shown in the output header: `signed-pdf-only` values (bank
account, routing #) must NEVER be pasted into an email body or chat bound for
an external party; `restricted` values only fill slots that explicitly ask.

## Submode: list-docs

Lists all known doc aliases grouped by category (w9, coi, sales-tax-permit,
tx-resale-cert, voided-check, ach-wire, check-instructions, formation,
ein-proof, 147c, dba, ...).

## Trade-reference picking (programmatic)

When filling a vendor onboarding form, use `pickTradeRefs(profile, vendorId, n, seed)`
from `chillx-scripts/scripts/lib/docs/profile.mjs`:

- `vendorId` — matches a key in `vendor_category_hints` (e.g., `samuel_son`, `pentair`, `hajoca`)
- `n` — number of refs (default 3)
- `seed` — pass the vendor name for stable rotation (same form → same picks)

Returns refs ranked by category-overlap and relationship strength. Auto-excludes
the vendor from its own reference list.

## Hard rules

- **DO NOT** put bank account or routing # in an email body or any external-bound text.
- **DO NOT** auto-send anything, ever.
- **DO NOT** modify the canonical profile (`/workspace/extra/business-profile/chillx.yaml` — it is mounted read-only for exactly this reason).
- **DO NOT** put officer home address in any slot that doesn't explicitly ask for "officer home address" / "principal residence". Default to Bertram for "physical address" slots.
- **DO NOT** invoke a subagent.

## Composes with

- `chillx-scripts/scripts/lib/docs/profile.mjs` — canonical profile loader + sensitivity enforcement
- `/workspace/extra/business-profile/chillx.yaml` — single source of truth (read-only mount)
- `chillx-scripts/scripts/lib/intro/run-log.mjs` — every run logged
