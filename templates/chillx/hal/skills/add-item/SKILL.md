---
name: add-item
description: Add a new stock item to ERPNext with purchasing and selling prices. Looks up similar existing items for reference, applies ChillX defaults, creates Item + Item Price records. Triggers on "add item", "new item", "add product", "new part", "add to inventory".
---

# Add Item to ERPNext

Create a new Item in ERPNext with consistent defaults, supplier details, and buy/sell pricing. Always look at similar existing items first so the new entry matches established patterns.

**Environment (v2 container):** `source /workspace/agent/.chillx-env` before the curl calls below. `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` are placeholders — the gateway injects the real Authorization header at request time.

**Data-access doctrine (Phase B.1):** the gateway-injected ERPNext credential is **READ-ONLY** (erp-read) — direct POSTs to ERPNext return 403 by design. Reference lookups: query the **data mirror first** (`bun /home/node/.claude/skills/chillx-scripts/scripts/mirror-query.mjs`, tables `items` / `item_prices`, hourly-fresh); use live GETs only when freshness matters, and say which source you used. **Creation goes through erp-svc** (`POST http://host.docker.internal:8010/item`, bypass the proxy with `curl --noproxy '*'`), which holds the scoped write credential and audit-logs the request.

## Workflow

### 1. Gather information from the user

Required:
- **Item code** (model/part number)
- **Item name** (or enough to construct one)
- **Supplier** and supplier part number
- **Buy price** (cost) and **sell price**

Optional (have good defaults):
- Item group, brand, description, MOQ, lead time, safety stock, weight, warehouse

### 2. Find similar items for reference

Before creating anything, search for similar items. **Mirror first** (fast, fresh-within-an-hour):

```bash
MQ=/home/node/.claude/skills/chillx-scripts/scripts/mirror-query.mjs
bun $MQ "SELECT name, item_name, item_group, brand FROM items WHERE item_name LIKE '%SEARCH_TERM%' LIMIT 10"
bun $MQ "SELECT item_code, price_list, price_list_rate, currency FROM item_prices WHERE item_code='REFERENCE_CODE'"
```

Live ERPNext read (only if the mirror is too stale for the question):

```bash
source /workspace/agent/.chillx-env; curl -s -H "Authorization: token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}" \
  "${ERPNEXT_URL}/api/resource/Item?filters=[[\"item_name\",\"like\",\"%SEARCH_TERM%\"]]&fields=[\"name\",\"item_name\",\"item_group\",\"brand\"]&limit=10"
```

Pull full details on the closest match to use as a template for field values and naming conventions:

```bash
source /workspace/agent/.chillx-env; curl -s -H "Authorization: token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}" \
  "${ERPNEXT_URL}/api/resource/Item/ITEM_CODE" | python3 -m json.tool || true
# (no python3 in this container — pipe through `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s),null,2)))"` instead, or read raw)
```

Also check existing Item Prices for the reference item:

```bash
source /workspace/agent/.chillx-env; curl -s -H "Authorization: token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}" \
  "${ERPNEXT_URL}/api/resource/Item%20Price?filters=%5B%5B%22item_code%22%2C%22%3D%22%2C%22ITEM_CODE%22%5D%5D&fields=%5B%22item_code%22%2C%22price_list%22%2C%22price_list_rate%22%2C%22currency%22%5D"
```

Use the reference item to match: naming pattern, item group, brand, description style, and any field values the user didn't specify.

### 3. Verify the supplier exists

```bash
source /workspace/agent/.chillx-env; curl -s -H "Authorization: token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}" \
  "${ERPNEXT_URL}/api/resource/Supplier?filters=%5B%5B%22supplier_name%22%2C%22like%22%2C%22%25SUPPLIER_NAME%25%22%5D%5D&fields=%5B%22name%22%5D"
```

If the supplier doesn't exist, tell the user and ask if they want to create it before proceeding.

### 4. Show the user what will be created

Before creating, display a summary table:

| Field | Value |
|-------|-------|
| Item Code | ... |
| Item Name | ... |
| Item Group | ... |
| Brand | ... |
| UOM | Unit |
| Warehouse | Finished Goods - CX |
| Valuation Method | FIFO |
| Supplier | ... |
| Supplier Part # | ... |
| Buy Price | $... |
| Sell Price | $... |
| MOQ | ... |
| Lead Time | ... days |
| Safety Stock | ... |

Ask for confirmation before proceeding. If the user provided all details up front and expressed confidence, a brief confirmation is sufficient.

### 5. Create the Item + Item Prices (ONE erp-svc call)

Creation goes through the erp-svc capability container — NOT directly to
ERPNext (the agent's ERP credential is read-only; a direct POST 403s).

```bash
curl -s --noproxy '*' -X POST -H "Content-Type: application/json" -H "X-Caller: hal-agent/add-item" \
  http://host.docker.internal:8010/item \
  -d '{"item": ITEM_JSON, "prices": [
        {"price_list": "Standard Buying",  "price_list_rate": BUY_PRICE,  "currency": "USD"},
        {"price_list": "Standard Selling", "price_list_rate": SELL_PRICE, "currency": "USD"}
      ]}'
```

`ITEM_JSON` structure (same field conventions as before):

```json
{
  "item_code": "PART-NUMBER",
  "item_name": "Brand - Series/Line - Key Specs",
  "item_group": "GROUP",
  "stock_uom": "Unit",
  "purchase_uom": "Unit",
  "sales_uom": "Unit",
  "is_stock_item": 1,
  "is_purchase_item": 1,
  "is_sales_item": 1,
  "include_item_in_manufacturing": 1,
  "brand": "BRAND",
  "description": "<div><p>ITEM_NAME</p><p><br></p><p>PRODUCT_DESCRIPTION</p></div>",
  "valuation_method": "FIFO",
  "valuation_rate": BUY_PRICE,
  "standard_rate": SELL_PRICE,
  "default_material_request_type": "Purchase",
  "country_of_origin": "UNITED STATES",
  "end_of_life": "2099-12-31",
  "safety_stock": SAFETY_STOCK,
  "min_order_qty": MOQ,
  "lead_time_days": LEAD_TIME,
  "grant_commission": 0,
  "variant_based_on": "Item Attribute",
  "item_defaults": [
    {
      "company": "CHILLX CHILLERS",
      "default_warehouse": "Finished Goods - CX",
      "default_price_list": "Standard Buying",
      "income_account": "Sales - CX"
    }
  ],
  "uoms": [
    { "uom": "Unit", "conversion_factor": 1.0 }
  ],
  "supplier_items": [
    {
      "supplier": "SUPPLIER_NAME",
      "supplier_part_no": "SUPPLIER_PART_NO"
    }
  ]
}
```

### 6. Confirm

After all three documents are created, display a summary:

| Document | Status |
|----------|--------|
| Item [ITEM_CODE] | Created |
| Item Price (Buying) | $X.XX |
| Item Price (Selling) | $X.XX |

Include the margin percentage: `((sell - buy) / sell * 100)`.

## ChillX Defaults

These are applied automatically unless the user specifies otherwise:

| Field | Default |
|-------|---------|
| Company | CHILLX CHILLERS |
| Default Warehouse | Finished Goods - CX |
| Default Price List | Standard Buying |
| Income Account | Sales - CX |
| Stock UOM / Purchase UOM / Sales UOM | Unit |
| Valuation Method | FIFO |
| Country of Origin | UNITED STATES |
| End of Life | 2099-12-31 |
| Currency | USD |
| Grant Commission | 0 |
| Include in Manufacturing | 1 |
| Variant Based On | Item Attribute |

## Item Name Convention

Follow the pattern: `Brand - Series/Line - Key Distinguishing Specs`

Examples from existing items:
- `Penn - A421 - 120/240VAC Single-stage Temp Controller - Type 1 - w/ 2m Probe`
- `Penn - A421 - 24VAC Single-stage Temp Controller - Type 4X - w/ 2m Probe`
- `Penn - 450 Series - 24VAC Two-Stage Temp Controller (Without Probe)`
- `Penn - 550 Series - 24VAC Multi-Stage Control Module w/ LCD, 2 SPDT Relay, A2L Leak Detection`

## Optional Fields

Set these when the user provides them or when the reference item has them:

| Field | Notes |
|-------|-------|
| `weight_per_unit` / `weight_uom` | Weight in LBS |
| `image` | Product image URL (upload separately) |
| `delivered_by_supplier` | 1 if drop-shipped |
| `has_serial_no` | 1 if serial-tracked |
| `has_batch_no` | 1 if batch-tracked |
| `safety_stock` | Reorder threshold |
| `min_order_qty` | Minimum order quantity from supplier |
| `lead_time_days` | Supplier lead time |

## Error Handling

- If the item code already exists, ERPNext returns a `DuplicateEntryError`. Tell the user and ask if they want to update the existing item instead.
- If a supplier doesn't exist, offer to create it before proceeding.
- If an Item Price already exists for the same item + price list combination, it may create a duplicate. Check first with a list query.
