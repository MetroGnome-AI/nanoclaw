/**
 * scripts/lib/shipping/erp.mjs
 *
 * Thin ERPNext client + small helpers used by the shipping discipline.
 */
import fs from 'node:fs';

const ENV = (() => {
  const e = {};
  // v2 container: env file lives in the agent group workspace (machine-local, not in git).
  let _t = '';
  try { _t = fs.readFileSync(process.env.CHILLX_ENV_FILE || '/workspace/agent/.chillx-env', 'utf-8'); } catch { /* rely on process.env */ }
  for (const line of _t.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    e[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  // process.env wins over the file so gateway/host-provided values take precedence.
  return { ...e, ...process.env };
})();

const BASE = ENV.ERPNEXT_URL;
const AUTH = `token ${ENV.ERPNEXT_API_KEY}:${ENV.ERPNEXT_API_SECRET}`;

async function req(method, path, body) {
  const url = `${BASE}${path}`;
  const headers = { Authorization: AUTH };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, {
    method,
    headers,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const txt = await r.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = { _raw: txt }; }
  if (!r.ok) {
    const err = new Error(`ERPNext ${method} ${path} → ${r.status}`);
    err.status = r.status;
    err.body = parsed;
    err.raw = txt;
    throw err;
  }
  return parsed;
}

export const erpGet = (path) => req('GET', path);
export const erpPost = (path, body) => req('POST', path, body);
export const erpPut = (path, body) => req('PUT', path, body);
export const erpDelete = (path) => req('DELETE', path);

export function encPath(name) { return encodeURIComponent(name); }

/**
 * Fetch a doc with the standard fields.
 */
export async function getDoc(doctype, name) {
  const r = await erpGet(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  return r.data;
}

/**
 * Run a frappe.client.get_list with proper urlencoded filters.
 */
export async function getList(doctype, filters, fields, order_by, limit_page_length = 20) {
  const q = new URLSearchParams({
    doctype,
    filters: JSON.stringify(filters || []),
    fields: JSON.stringify(fields || ['name']),
    limit_page_length: String(limit_page_length),
  });
  if (order_by) q.set('order_by', order_by);
  const r = await erpGet(`/api/method/frappe.client.get_list?${q}`);
  return r.message || [];
}

/**
 * Submit a doc by name (PUT docstatus:1).
 */
export async function submitDoc(doctype, name) {
  return erpPut(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, { docstatus: 1 });
}

/**
 * Call a Frappe server method (GET form). Used for make_delivery_note / make_sales_invoice.
 */
export async function callMethod(method, params = {}) {
  const q = new URLSearchParams(params);
  return erpGet(`/api/method/${method}?${q}`);
}

/**
 * Add a Comment doc to a reference.
 */
export async function addComment(reference_doctype, reference_name, html_content) {
  return erpPost('/api/resource/Comment', {
    comment_type: 'Comment',
    reference_doctype,
    reference_name,
    content: html_content,
  });
}
