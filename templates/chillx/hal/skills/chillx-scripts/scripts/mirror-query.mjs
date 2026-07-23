#!/usr/bin/env bun
/**
 * mirror-query.mjs — query the CHILLX data-mirror (Phase B.1 doctrine: data
 * questions hit the mirror FIRST; live ERPNext GETs only when freshness is
 * critical — and say which source you used).
 *
 * The mirror is a read-only SQLite snapshot of ERPNext core doctypes +
 * Drupal commerce, rebuilt hourly at :20 on the host. Mounted at
 * /workspace/extra/chillx-mirror/mirror.db (read-only).
 *
 * RUN WITH BUN (bun:sqlite — NOT node):
 *   bun mirror-query.mjs --tables
 *   bun mirror-query.mjs --schema sales_orders
 *   bun mirror-query.mjs "SELECT status, COUNT(*) n FROM sales_orders GROUP BY status"
 *   bun mirror-query.mjs --json "SELECT ..."        # JSON rows instead of table
 *   bun mirror-query.mjs --limit 500 "SELECT ..."   # default row cap 200
 *
 * Tables: items, item_prices, item_groups, bins, warehouses, customers,
 * customer_groups, contacts, addresses, leads, quotations, sales_orders,
 * sales_invoices, payment_entries, delivery_notes, boms, serial_nos,
 * communications, todos, + child tables (sales_order_items, sales_invoice_items,
 * delivery_note_items, quotation_items, payment_entry_references, bom_items),
 * + drupal_commerce_orders, drupal_commerce_line_items, drupal_order_statuses.
 * Freshness/meta: _mirror_meta (rows, refreshed_at per table).
 */
import { Database } from 'bun:sqlite';

const DB_PATH = process.env.MIRROR_DB || '/workspace/extra/chillx-mirror/mirror.db';

const argv = process.argv.slice(2);
let json = false;
let limit = 200;
let mode = 'sql';
let arg = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') json = true;
  else if (a === '--limit') limit = Number(argv[++i]) || limit;
  else if (a === '--tables') mode = 'tables';
  else if (a === '--schema') { mode = 'schema'; arg = argv[++i] || ''; }
  else arg = a;
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.error(`Cannot open mirror at ${DB_PATH}: ${e.message}`);
  console.error('Is the chillx-mirror mount present? Fall back to a live ERPNext GET and say so.');
  process.exit(2);
}

// Freshness banner — always show how stale the snapshot is.
try {
  const m = db.query('SELECT MAX(refreshed_at) AS at, SUM(rows) AS total FROM _mirror_meta').get();
  const ageMin = Math.round((Date.now() - Date.parse(m.at)) / 60000);
  console.log(`# mirror refreshed_at=${m.at} (${ageMin} min ago), ${m.total} rows total`);
} catch { /* meta missing — still usable */ }

function printRows(rows) {
  if (json) { console.log(JSON.stringify(rows, null, 1)); return; }
  if (rows.length === 0) { console.log('(no rows)'); return; }
  const cols = Object.keys(rows[0]);
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map((c) => r[c] ?? '').join('\t'));
}

if (mode === 'tables') {
  printRows(db.query(
    "SELECT m.name AS table_name, IFNULL(mm.rows,'') AS rows FROM sqlite_master m LEFT JOIN _mirror_meta mm ON mm.table_name=m.name WHERE m.type='table' ORDER BY m.name",
  ).all());
} else if (mode === 'schema') {
  printRows(db.query(`PRAGMA table_info("${arg.replace(/"/g, '""')}")`).all());
} else {
  if (!arg) { console.error('Usage: bun mirror-query.mjs [--json] [--limit N] "<SELECT ...>" | --tables | --schema <table>'); process.exit(1); }
  const rows = db.query(arg).all();
  const shown = rows.slice(0, limit);
  printRows(shown);
  if (rows.length > shown.length) console.log(`… ${rows.length - shown.length} more rows truncated (raise with --limit)`);
}
