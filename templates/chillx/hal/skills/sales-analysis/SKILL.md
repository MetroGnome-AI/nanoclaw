---
name: sales-analysis
description: Analyze ChillX chiller sales across all sources (ERPNext, Drupal, GDocs, GSheets) with classification by chiller type, capacity, low temp, and power supply. Generate cross-source sales reports for ad-hoc business questions like "what 5 ton chillers did we sell in Q1?" or "how many low-profile units shipped to Texas?". Triggers on "sales analysis", "chiller sales report", "sales by capacity", "what did we sell", "sales breakdown".
---

# Cross-Source Chiller Sales Analysis

Builds and queries a unified chiller sales dataset with classification columns
so the data can be sliced by chiller characteristics — type, capacity, low temp
option, power supply phase/voltage.

**Environment (v2 container):** `source /workspace/agent/.chillx-env` before
the ERPNext curl calls. Auth is injected by the gateway.

> **Wave-1 deployment note:** only the **ERPNext** source is live here.
> Drupal, Google Docs, and Google Sheets sources are unavailable in this
> deployment (wave 2) — state that clearly in any report so partial coverage
> is never mistaken for the full picture. Save outputs under
> `/workspace/agent/reports/`.

## Output

A single CSV at `/workspace/agent/reports/chiller-sales-all-sources.csv` with these columns:

```
Source,Order ID,Order Date,Ship Date,Customer Name,Business Name,Qty,Item Code,Item Name,Item Rate,Order Total,Duplicate,Chiller Type,Capacity,Low Temp,Power Supply
```

| Column | Notes |
|--------|-------|
| `Source` | `ERP-SI`, `ERP-SO` (Drupal/GDocs/GSheets: wave 2) |
| `Order ID` | SO-YYYY-XXXXX, SI-YYYY-XXXXX |
| `Order Date` | Date the order was placed |
| `Ship Date` | Date shipped (when known) |
| `Customer Name` | Person or contact name |
| `Business Name` | Company name (often same as Customer Name) |
| `Qty` | Number of units ordered |
| `Item Code` | ERPNext item code (e.g. CXVA060CRS3CR) |
| `Item Name` | Full item description |
| `Item Rate` | Per-unit price |
| `Order Total` | Order grand total (including freight, options) |
| `Duplicate` | `1` if this row appears to be a duplicate from another source |
| `Chiller Type` | Compact, Low Profile, Process Chiller, Pond Loop, RTU, Tank Section, Tower, Vertical, Not a Chiller |
| `Capacity` | 1 Ton ... 25 Ton |
| `Low Temp` | `LT` if the low-temp option was added, blank otherwise |
| `Power Supply` | e.g. `208/230V 1-Phase`, `208/230V 3-Phase`, `460V 3-Phase` |

## Classification logic

**Chiller Type from Item Code prefix:**

| Prefix | Type |
|--------|------|
| `CXVA` | Low Profile (Vertical Air-cooled) |
| `CXPA` | Process Chiller (P-series Air-cooled) |
| `CXCA` | Compact (C-series Air-cooled) |
| `CXLW` | Pond Loop (Loop Water) |
| `CXTS` | Tank Section |
| `CXEA` | Vertical (E-series Air-cooled) |
| `CXAH` / `AHS-DB` / `GHAILGD` | Air Handler / Heat Exchanger / Accessory (Not a Chiller) |
| `SC*`, `FP*`, `2STG`, `INS`, `ALR`, `EXP`, `EXT`, `LT`, `JMG*` | Accessory / Option (Not a Chiller) |

**Capacity from Item Code (3-digit number indicates BTU/hr × 100, divide by 12 for tons):**

- `036` → 3 Ton
- `048` → 4 Ton
- `060` → 5 Ton
- `072` → 6 Ton
- `090` → 7.5 Ton
- `120` → 10 Ton
- `150` → 12.5 Ton
- `180` → 15 Ton
- `192` → 16 Ton
- `240` → 20 Ton
- `300` → 25 Ton

**Power Supply from Item Code suffix:**

- `S1` → 208/230V 1-Phase
- `S3` → 208/230V 3-Phase
- `S4` → 460V 3-Phase
- `D3` → 208/230V 3-Phase Dual-Circuit
- `D4` → 460V 3-Phase Dual-Circuit

**Low Temp:** Item codes ending in `-P` are Process variant (not necessarily LT). The LT option is a separate line item (`LT`) on the order — set the `Low Temp` column to `LT` if that line is present.

## Workflow

### 1. Determine the date range and filters

Examples:
- "All chiller sales" → no date filter, all rows
- "Q1 2026 chiller sales" → date range 2026-01-01 to 2026-03-31
- "5 ton sales in 2025" → date range, then filter by Capacity = `5 Ton`

### 2. Pull from ERPNext (Sales Invoices and Sales Orders)

```bash
source /workspace/agent/.chillx-env
# Get all submitted SIs in the date range
curl -s "$ERPNEXT_URL/api/resource/Sales Invoice" \
  -H "Authorization: token $ERPNEXT_API_KEY:$ERPNEXT_API_SECRET" \
  --data-urlencode 'filters=[["docstatus","=",1],["posting_date",">=","2026-01-01"]]' \
  --data-urlencode 'fields=["name","customer_name","grand_total","posting_date"]' \
  --data-urlencode 'limit_page_length=500' -G
```

For each SI/SO, fetch the full doc and walk the `items[]` array.

### 3. Classify each row

Apply the prefix/suffix lookup tables above to extract Chiller Type, Capacity, Power Supply, Low Temp.

### 4. Deduplicate

The same order may appear in multiple sources (e.g. ERP-SO + ERP-SI for the same order). Mark duplicates by:
- Same Order ID across sources (prefer the most-recent / highest-fidelity source)
- Same customer + same date + same item code + same total (within $1)

Set `Duplicate=1` on the lower-priority duplicate row. Keep both rows in the output for traceability.

### 5. Save outputs

```bash
/workspace/agent/reports/chiller-sales-all-sources.csv   # CSV (primary)
/workspace/agent/reports/chiller-sales-all-sources.tsv   # TSV (for pasting into spreadsheets)
```

## Common queries on the dataset

Once the CSV is built, filter with `awk`/`node` (no `mlr`/`csvkit` in this container) — or just load the CSV and compute directly.

## When to regenerate

- Before any sales analysis question that needs fresh data
- After a major data import
- Before quarterly business review meetings
