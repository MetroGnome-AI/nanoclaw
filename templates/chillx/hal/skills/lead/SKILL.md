---
name: lead
description: Create or enrich an ERPNext Lead from any source (call, SMS, email, web form, trade show, manual). Dedups by phone/email, tags equipment interest, and omits uncertain source/industry rather than guessing. Use when the user says "create a lead for X", "log this inquiry", "add X as a lead", or "new lead — X from Y interested in Z".
---

# Lead capture (bounded-judgment)

`lead.mjs` does the deterministic work — dedup, create-or-enrich, equipment
tagging, and an audit comment. This skill routes the user's natural-language
ask to the right invocation.

**Script path (v2 container):** `LEAD=/home/node/.claude/skills/chillx-scripts/scripts/lead.mjs`

## When to invoke

"create a lead for X", "log this inquiry as a lead", "add X (phone/email) as a lead", "new lead — Ray from EnergyX wants a 4-ton low profile", or capturing a lead off a call / SMS / email / web form / trade-show card.

## How to operate

1. **Gather** what the user actually gave: name, phone, email, company, equipment interest, source, notes. Do NOT invent the missing pieces.
2. **Dry-run first** to preview the dedup decision + payload + tags:
   `node $LEAD <flags> --dry-run`
3. **Review:** did it find an existing Lead (→ ENRICH) or will it CREATE? Are the equipment tags right? Is `source` correct — or correctly OMITTED? Any "existing Contact" warning?
4. **Run for real** (drop `--dry-run`).
5. **Report:** created/enriched `CRM-LEAD-YYYY-NNNNN`, field patch, tags applied, and any dedup/customer warning.

## Flags

`--name "Ray from EnergyX"` (parsed via parseCallerName) **or** `--first` / `--last`; `--phone`; `--email`; `--company`; `--title`; `--source`; `--interest "..."`; `--notes`; `--territory` (default United States); `--dry-run`.

## Hard rules

- **Source / industry: set ONLY when the inbound data determines it. NEVER guess.** ERPNext's Link validator rejects an invented value and blocks the whole insert.
- **Core contact fields (name): never fabricate.** `UNKNOWN CALLER` is an acceptable placeholder; a made-up name is not.
- **Dedup before create.** The script matches phone (digits / dashed / parenized) + email; never create a duplicate for a known contact. It enriches blanks only — never overwrites existing values.
- If the phone/email already belongs to a **Contact** (possible existing customer), the script warns — surface it; they may not be a new lead.

## Equipment tags

`--interest` free text → canonical CRM tags: `Chiller: Low Profile` / `Chiller: RTU` / `Chiller: Process` / `Chiller`, `Air Handler`, `Shell & Tube HX`, `Tank Section`, `Unit Heater`, `Pump`. Generic `Chiller` is dropped when a specific chiller type also matches. Extend via the `EQUIP_TAGS` table in `lead.mjs`.

## Composes with

- `chillx-scripts/scripts/lead.mjs` — the orchestrator. READS (dedup lookups) use the gateway-injected ERPNext credential, which is READ-ONLY (erp-read). WRITES (create/enrich/tags/comment) go through the erp-svc capability container at `http://host.docker.internal:8010` — the script needs NO ERPNext write credential. If erp-svc is down the script fails loudly; report that to Rob rather than trying to write ERPNext directly (direct writes 403 by design).
- `chillx-scripts/scripts/lib/phone.mjs` — phone normalization shared with dedup
