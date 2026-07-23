/**
 * scripts/lib/shipping/resolve-destination.mjs
 *
 * Single source of truth for "where is this going?" — used by BOTH quote.mjs
 * (needs city/state/zip) and ship.mjs (needs full street address + contact for
 * the FedEx label). Resolving destinations in one place stops the two scripts
 * from drifting apart.
 *
 * Resolves from any one of:
 *   { so: 'SO-XXXX' }        → ERPNext Sales Order
 *   { quote: 'Q-XXXX' }      → ERPNext Quotation
 *   { lead: 'CRM-LEAD-XXX' } → latest Quotation for that Lead (else the Lead's own city/state)
 *   { drupal: NNNN }         → ERPNext SO by po_no if imported; else Drupal directly
 *   { to: 'City,ST,ZIP' }    → literal address
 *
 * Options:
 *   billing: true    → use the BILLING address (customer_address) instead of shipping.
 *                      Default false (shipping). Will-call quotes use billing.
 *   residential: bool→ tag the address residential (label/accessorial behavior).
 *
 * Returns a normalized object:
 *   {
 *     soName,        // resolved SO name, or null (quote/lead/literal/un-imported-drupal)
 *     doc,           // the underlying SO/Quotation doc (null for literal/drupal-direct)
 *     company,       // customer / party name
 *     contact: { name, phone, email },
 *     address: { street1, street2, city, state, zip, country, residential },
 *     source,        // human label of where this resolved from
 *   }
 */
import { getDoc, getList } from './erp.mjs';

const COUNTRY_CODE_MAP = {
  'UNITED STATES': 'US', USA: 'US', 'U.S.A.': 'US', US: 'US',
  CANADA: 'CA', MEXICO: 'MX',
};
export function normalizeCountry(c) {
  if (!c) return 'US';
  const upper = String(c).toUpperCase().trim();
  if (COUNTRY_CODE_MAP[upper]) return COUNTRY_CODE_MAP[upper];
  if (upper.length === 2) return upper;
  return 'US';
}

/** Parse ERPNext's HTML address string → parts. Fallback when no Address doc. */
export function parseAddressString(addrStr) {
  const lines = String(addrStr || '').replace(/<br\s*\/?>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
  const country = lines.pop() || '';
  const cityStateZip = lines.pop() || '';
  const m = cityStateZip.match(/^(.+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  return {
    street1: lines[0] || '',
    street2: lines[1] || '',
    city: m?.[1] || cityStateZip,
    state: m?.[2] || '',
    zip: m?.[3] || '',
    country,
  };
}

/** Load a structured Address doc → parts (overrides the HTML-string parse). */
async function addressFromDoc(addressName) {
  if (!addressName) return null;
  try {
    const a = await getDoc('Address', addressName);
    return {
      street1: a.address_line1 || '',
      street2: a.address_line2 || '',
      city: a.city || '',
      state: a.state || '',
      zip: a.pincode || '',
      country: a.country || '',
    };
  } catch {
    return null;
  }
}

async function contactFrom(contactName) {
  const contact = { name: '', phone: '', email: '' };
  if (!contactName) return contact;
  try {
    const c = await getDoc('Contact', contactName);
    contact.name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.full_name || '';
    contact.phone = c.phone_nos?.[0]?.phone || '';
    contact.email = c.email_ids?.[0]?.email_id || '';
  } catch {}
  return contact;
}

/** Resolve from an ERPNext SO/Quotation doc (shared by --so / --quote / --lead). */
async function fromErpDoc(doctype, name, { billing, residential }) {
  const doc = await getDoc(doctype, name);
  const addrName = billing
    ? doc.customer_address
    : doc.shipping_address_name || doc.customer_address;
  const structured = await addressFromDoc(addrName);
  const parsed = parseAddressString(billing ? doc.address_display : doc.shipping_address);
  const address = { ...parsed, ...(structured || {}) };
  address.country = normalizeCountry(address.country);
  address.residential = !!residential;
  return {
    soName: doctype === 'Sales Order' ? name : null,
    doc,
    company: doc.customer || doc.party_name || doc.customer_name,
    contact: await contactFrom(doc.contact_person),
    address,
    source: name,
  };
}

export async function resolveDestination(opts = {}) {
  const { billing = false, residential = false } = opts;

  if (opts.to) {
    const [city, state, zip] = String(opts.to).split(',').map(s => s.trim());
    return {
      soName: null, doc: null, company: '(direct)',
      contact: { name: '', phone: '', email: '' },
      address: { street1: '', street2: '', city, state, zip, country: 'US', residential: !!residential },
      source: `literal ${opts.to}`,
    };
  }

  if (opts.so) return fromErpDoc('Sales Order', opts.so, { billing, residential });
  if (opts.quote) return fromErpDoc('Quotation', opts.quote, { billing, residential });

  if (opts.lead) {
    // Prefer the lead's most-recent Quotation (has a proper address); else the Lead's own city/state.
    const q = await getList('Quotation', [['party_name', '=', opts.lead]], ['name'], 'creation desc', 1);
    if (q.length) {
      const r = await fromErpDoc('Quotation', q[0].name, { billing, residential });
      r.source = `${opts.lead} → ${q[0].name}`;
      return r;
    }
    const lead = await getDoc('Lead', opts.lead);
    return {
      soName: null, doc: lead, company: lead.company_name || lead.lead_name,
      contact: { name: lead.lead_name || '', phone: lead.mobile_no || lead.phone || '', email: lead.email_id || '' },
      address: { street1: lead.address_line1 || '', street2: lead.address_line2 || '', city: lead.city || '', state: lead.state || '', zip: lead.pincode || '', country: normalizeCountry(lead.country), residential: !!residential },
      source: opts.lead,
    };
  }

  if (opts.drupal) {
    const sos = await getList('Sales Order', [['po_no', '=', String(opts.drupal)]], ['name'], 'creation desc', 1);
    if (sos.length) {
      const r = await fromErpDoc('Sales Order', sos[0].name, { billing, residential });
      r.source = `Drupal ${opts.drupal} → ${sos[0].name}`;
      return r;
    }
    // Un-imported: query Drupal directly (shipping address).
    const DRUPAL = process.env.DRUPAL_URL.replace(/\/$/, '');
    const TOKEN = process.env.DRUPAL_SQL_TOKEN;
    const col = billing ? 'billing' : 'shipping';
    const sql = `SELECT a.commerce_customer_address_organisation_name org,
      TRIM(CONCAT(COALESCE(a.commerce_customer_address_first_name,''),' ',COALESCE(a.commerce_customer_address_last_name,''))) name,
      a.commerce_customer_address_thoroughfare street, a.commerce_customer_address_premise street2,
      a.commerce_customer_address_locality city, a.commerce_customer_address_administrative_area state,
      a.commerce_customer_address_postal_code zip
      FROM commerce_order o
      LEFT JOIN field_data_commerce_customer_${col} cs ON cs.entity_id=o.order_id AND cs.entity_type='commerce_order'
      LEFT JOIN field_data_commerce_customer_address a ON a.entity_id=cs.commerce_customer_${col}_profile_id AND a.entity_type='commerce_customer_profile'
      WHERE o.order_id=${parseInt(opts.drupal, 10)}`;
    const resp = await fetch(DRUPAL + '/ncsql.php', { method: 'POST', headers: { 'X-NC-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sql', sql }) });
    const row = ((await resp.json()).rows || [])[0];
    if (!row) throw new Error(`Drupal order ${opts.drupal} not found / no ${col} address`);
    return {
      soName: null, doc: null, company: row.org || `(Drupal ${opts.drupal})`,
      contact: { name: row.name || '', phone: '', email: '' },
      address: { street1: row.street || '', street2: row.street2 || '', city: row.city || '', state: row.state || '', zip: row.zip || '', country: 'US', residential: !!residential },
      source: `Drupal ${opts.drupal}`,
    };
  }

  throw new Error('Need a destination: { so | quote | lead | drupal | to }');
}
