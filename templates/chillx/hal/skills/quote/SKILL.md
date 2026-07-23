---
name: quote
description: Get a shipping rate quote (FedEx parcel OR EchoShip LTL) for an order or destination, in one command. Resolves the ship-to from an SO / Quotation / Drupal order (imported or not) or a literal address, auto-picks parcel-vs-LTL, derives freight class from density, and prints carrier options with net + customer-facing (×1.165) price. Triggers on "get me a FedEx quote for X", "EchoShip quote to Y", "what's shipping on this order", "quote freight for SO-XXXX / Drupal NNNN", "rate this to <city>".
---

# Shipping quote discipline (lock-execute + light bounded-judgment)

One command from "order/destination + dims" to a ranked rate table. Read-only —
never books, never writes ERPNext.

**Script path (v2 container):** `QUOTE=/home/node/.claude/skills/chillx-scripts/scripts/quote.mjs`

> **Wave-1 deployment note:** FedEx and EchoShip credentials are not yet in
> the vault (wave 2). Destination resolution from ERPNext works; live rate
> calls may return a 401 with a gateway connect link — surface the link
> verbatim on its own line and stop. `--drupal` resolution of un-imported
> orders also needs Drupal credentials (wave 2).

## When to invoke

"FedEx quote for X", "EchoShip/freight quote to Y", "rate this shipment", "what would shipping be on <order>", "quote SO-XXXX / Drupal NNNN / Q-XXXX".

## How to operate

1. **Declare:** "Entering quote discipline."
2. **Get dims + weight.** Required: `--dims LxWxH` (inches) and `--weight N` (lb). If the user didn't give them, ask once (don't guess box dims for a real quote).
3. **Run:**
   ```bash
   node $QUOTE <destination> --dims LxWxH --weight N [flags]
   ```
4. **Report** the ranked table (carrier, net, customer ×1.165, transit). Recommend the best value if asked.

## Destination (one required)

Resolved by the shared `lib/shipping/resolve-destination.mjs` (same resolver v1's ship.mjs uses — they can't drift apart):

| Flag | Resolves from |
|------|---------------|
| `--so SO-XXXX` | ERPNext Sales Order address |
| `--quote Q-XXXX` | ERPNext Quotation address |
| `--lead CRM-LEAD-XXX` | the Lead's latest Quotation (else the Lead's own city/state) |
| `--drupal NNNN` | ERPNext SO by po_no if imported; else queries Drupal directly (wave 2 here) |
| `--to "City,ST,ZIP"` | literal address |

Add `--billing` to use the **billing** address instead of shipping (will-call pickups go to the billing/home area).

**Dims auto-pull:** if `--dims`/`--weight` are omitted and the resolved doc's first line item (or its Item-master description) carries shipping dims, they're used automatically. Otherwise pass them explicitly.

## Flags

- `--fedex` | `--echo` — force mode (default: **auto** — LTL if weight ≥ 150 lb OR any dim > 48", else FedEx parcel)
- `--willcall` — **terminal / dock pickup: strips ALL accessorials** (no liftgate, residential, or notify). Use when the customer picks up at the carrier hub. ~1 in 10 quotes.
- `--billing` — quote to the billing address (default for will-call)
- `--lead CRM-LEAD-XXX` — resolve destination from a Lead
- `--nmfc NNNNN` — LTL NMFC number (default `114115`; use `114125` for chillers)
- `--class NN` — LTL freight class (default: density-derived; see table below)
- `--liftgate` — add LIFTGATEREQUIRED accessorial (ignored under `--willcall`)
- `--residential` — residential delivery (auto-adds RESIDENTIAL for LTL; flips FedEx to Home Delivery; ignored under `--willcall`)
- `--all` — FedEx: show Express tiers too (default shows Ground/Home Delivery only)
- `--markup N` — customer multiplier (default **1.165** = 15% margin + ~1.5% EchoInsure)
- `--pickup YYYY-MM-DD` — LTL pickup date (default: tomorrow)
- `--desc "..."` — LTL commodity description

### Will-call / nearest-hub quotes (the ~1-in-10 case)

A will-call quote is just `--willcall` (zero accessorials, dock-to-dock). You rate to the **customer's ZIP** — the carrier holds it at the terminal serving that ZIP and the customer picks up; you do NOT need the terminal's own ZIP for the rate. The exact terminal prints on the BOL at booking. Example:
```bash
node $QUOTE --lead CRM-LEAD-2026-00105 --billing --willcall --dims 42x48x50 --weight 145 --echo
```

## Locked defaults

- **Origin:** Bertram TX 78605 (always)
- **Markup:** ×1.165
- **Mode auto-pick:** LTL when weight ≥ 150 lb OR longest dim > 48"; else FedEx parcel
- **Freight class by density (PCF):** <1→400, 1-2→300, **2-4→250**, 4-6→175, 6-8→150, 8-10→125, 10-12→110, 12-15→100, 15-22.5→92.5, 22.5-30→85, ≥30→70. (5-Ton AHU ≈ 2.17 PCF → 250 ✓; chillers ≈ 6-10 PCF → 125-150.)
- **Default accessorial:** NOTIFYPRIORTODELIVERY
- **NMFC number:** 114115 (AHU/HX), 114125 (chillers)

## Hard rules

- **DO NOT** guess box dims for a real quote. Ask, or pull from the item master.
- **DO NOT** book anything — this is quote-only. Booking (`/ship`) is a wave-2 skill, not installed here.
- **DO NOT** invoke a subagent.
- Density + class are shown so the user can sanity-check the class before it goes on a customer quote.

## Composes with

- `chillx-scripts/scripts/quote.mjs` — the orchestrator
- `chillx-scripts/scripts/lib/shipping/echoship.mjs` — `getRates` (LTL)
- `chillx-scripts/scripts/lib/shipping/fedex.mjs` — `getRate` (parcel; endpoint `/rate/v1/rates/quotes`)
- `chillx-scripts/scripts/lib/intro/run-log.mjs` — every run logged
