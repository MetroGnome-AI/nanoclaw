/**
 * scripts/lib/shipping/echoship.mjs — host-side EchoShip REST API client.
 *
 * Ports the parts of container/agent-runner/src/echoship-mcp.ts that the
 * shipping orchestrator needs to call directly:
 *   - listShipments({ from, to, limit })
 *   - getShipment(id)
 *   - getDocuments(id)            — returns array of { type, name, downloadUrl, contentType }
 *   - downloadDocument(url, savePath)
 *
 * Auth: HTTP Basic with ECHOSHIP_USER + ECHOSHIP_API_KEY (from .env).
 * Base URL: https://restapi.echo.com/v2
 *
 * Per memory `feedback_echoship_shipment_id_is_bol` — the shipment_id IS the BOL number.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = 'https://restapi.echo.com/v2';

function getAuthHeader() {
  const user = process.env.ECHOSHIP_USER;
  const key = process.env.ECHOSHIP_API_KEY;
  if (!user || !key) {
    throw new Error('ECHOSHIP_USER and ECHOSHIP_API_KEY must be set (source .env)');
  }
  return `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`;
}

async function echoFetch(method, path, body = null) {
  const headers = { Authorization: getAuthHeader(), Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Echo API ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

/** Verify API connectivity. */
export async function ping() {
  return echoFetch('GET', '/ping');
}

/**
 * Get LTL freight rates from Echo's REST v2 quoting engine.
 *
 * IMPORTANT — the REST tier uses PascalCase, flat layout. Verified shape from
 * past successful calls in session 111dda44 (Apr 2026):
 *   Mode, PickUpDate ('MM/dd/yyyy'), Origin{City,State,PostalCode,CountryCode},
 *   Destination{City,State,PostalCode,CountryCode},
 *   PalletQuantity, UnitOfWeight ('LB'),
 *   Items[{ Description, NmfcNumber, NmfcSub, NmfcClass, Weight, Length, Width, Height,
 *           HandlingUnitType ('PALLETS'), HandlingUnitQuantity, Quantity, Stackable }],
 *   Accessorials?: string[]
 *
 * Returns Echo's response with a top-level `Rates` array. Each entry: CarrierName,
 * CarrierSCAC, TotalCharge, CarrierTransitDays, CarrierGuarantee.
 *
 * @param params Friendly camelCase input — transformed to PascalCase wire shape internally.
 *   mode='LTL', pickupDate (YYYY-MM-DD or MM/dd/yyyy),
 *   origin: { zip, city, state, country='US' },
 *   destination: { zip, city, state, country='US' },
 *   palletQuantity (default 1), unitOfWeight (default 'LB'),
 *   items: [{ description, nmfcNumber, nmfcSub, nmfcClass, weight,
 *             length?, width?, height?, quantity?=1,
 *             handlingUnitType?='PALLETS', handlingUnitQuantity?=1, stackable?=false }],
 *   accessorials?: string[]   (e.g. ['NOTIFYPRIORTODELIVERY', 'LIFTGATEREQUIRED', 'RESIDENTIAL'])
 */
export async function getRates(params) {
  if (!params?.origin?.zip || !params?.destination?.zip) {
    throw new Error('getRates: origin.zip and destination.zip required');
  }
  if (!params.items?.length) throw new Error('getRates: at least one item required');

  const toUsDate = (d) => {
    if (!d) return null;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
    return d;
  };

  const Items = params.items.map((it) => ({
    Description: it.description ?? '',
    ...(it.nmfcNumber ? { NmfcNumber: String(it.nmfcNumber).split('-')[0] } : {}),
    ...(it.nmfcSub
      ? { NmfcSub: it.nmfcSub }
      : it.nmfcNumber && String(it.nmfcNumber).includes('-')
        ? { NmfcSub: String(it.nmfcNumber).split('-')[1] }
        : {}),
    NmfcClass: String(it.nmfcClass ?? it.freightClass ?? ''),
    Weight: Number(it.weight),
    ...(it.length ? { Length: Number(it.length) } : {}),
    ...(it.width ? { Width: Number(it.width) } : {}),
    ...(it.height ? { Height: Number(it.height) } : {}),
    HandlingUnitType: it.handlingUnitType ?? 'PALLETS',
    HandlingUnitQuantity: Number(it.handlingUnitQuantity ?? 1),
    Quantity: Number(it.quantity ?? 1),
    Stackable: it.stackable ?? false,
  }));

  const body = {
    Mode: params.mode ?? 'LTL',
    PickUpDate: toUsDate(params.pickupDate),
    OriginCity: params.origin.city,
    OriginState: params.origin.state,
    OriginPostalCode: params.origin.zip,
    OriginCountryCode: params.origin.country ?? 'US',
    DestinationCity: params.destination.city,
    DestinationState: params.destination.state,
    DestinationPostalCode: params.destination.zip,
    DestinationCountryCode: params.destination.country ?? 'US',
    PalletQuantity: params.palletQuantity ?? 1,
    UnitOfWeight: params.unitOfWeight ?? 'LB',
    Items,
    ...(params.accessorials?.length ? { Accessorials: params.accessorials } : {}),
  };
  return echoFetch('POST', '/rates', body);
}

/**
 * Listing is NOT POSSIBLE on the REST API v2 tier we have.
 *
 * Per `project_echoship_api_capabilities` (verified 2026-04-24): /shipments/list,
 * /shipments/search, /shipments/recent all return opaque BadRequest for every
 * param combination tried. Re-verified 2026-06-05 against the SwaggerHub spec —
 * the documented Customer API is OAuth+Quotes only; the Basic-Auth /shipments
 * tier (which is what we use) is undocumented publicly and listing is locked.
 *
 * Canonical path to find a recent BOL/shipment ID:
 *   1. ASK THE USER (BOL # = shipment_id; they always have it from booking)
 *   2. Or Gmail search `from:echo.com newer_than:14d`
 *
 * Do NOT brute-force endpoint paths. This function is a guarded stub.
 */
export async function listShipments() {
  throw new Error(
    'EchoShip listing not available on REST API v2. Ask the user for the BOL # (which IS the shipment_id), or Gmail-search "from:echo.com newer_than:14d".'
  );
}

/** Get a single shipment by ID (= BOL number). */
export async function getShipment(id) {
  return echoFetch('GET', `/shipments/${encodeURIComponent(id)}`);
}

/**
 * Normalize a raw getShipment() response (PascalCase, Stops[]/Items[]) into the
 * flat camelCase record the rest of our tooling expects. Shields callers from
 * EchoShip's wire shape (the thing that cost a raw-dump round-trip on 2026-06-17).
 */
export function normalizeShipment(s) {
  if (!s || typeof s !== 'object') return null;
  const stops = s.Stops || [];
  const pick = stops.find((p) => (p.StopType || '').toUpperCase() === 'PICK') || stops[0] || {};
  const drop = stops.find((p) => (p.StopType || '').toUpperCase() === 'DROP') || stops[stops.length - 1] || {};
  const loc = (st) => ({
    name: st.LocationName || '',
    street1: st.AddressLine1 || '', street2: st.AddressLine2 || '',
    city: st.City || '', state: st.StateProvince || '',
    zip: st.PostalCode || '', country: st.CountryCode || '',
    contact: st.ContactName || '', phone: st.ContactPhone || '',
  });
  const items = (s.Items || []).map((it) => ({
    description: it.Description || '',
    class: it.NmfcClass || '', nmfc: it.NmfcNumber || '',
    weight: it.Weight ?? null,
    handlingUnitType: it.HandlingUnitType || '', handlingUnits: it.HandlingUnitQuantity ?? null,
  }));
  return {
    bol: s.BolNumber || String(s.ShipmentId ?? ''),
    shipmentId: s.ShipmentId ?? null,
    status: s.ShipmentStatus || '', mode: s.ShipmentMode || '', carrier: s.CarrierName || '',
    orderNumber: s.OrderNumber || '', poNumber: s.PoNumber || '', proNumber: s.ProNumber || '',
    origin: loc(pick), destination: loc(drop),
    pickupDate: s.PickUpDate || s.RequestedPickUpDate || '',
    deliveryDate: s.DeliveryDate || '', estDeliveryDate: s.EstimatedDeliveryDate || '',
    totalCost: s.TotalCost ?? null, totalWeight: s.TotalWeight ?? null,
    items,
  };
}

/** Get documents for a shipment — BOL, label, POD, etc. */
export async function getDocuments(id) {
  return echoFetch('GET', `/shipments/${encodeURIComponent(id)}/documents`);
}

/**
 * Download the BOL PDF for a shipment to savePath. Uses the
 * /shipments/{id}/document?type=bol&format=pdf endpoint directly — the
 * documents-LIST Href points at a JPEG and is often empty pre-PRO, so don't
 * rely on it. Verified 2026-06-18: returns application/pdf for booked shipments.
 * Returns { savedPath, bytes }.
 */
export async function downloadBol(id, savePath) {
  const res = await fetch(`${BASE}/shipments/${encodeURIComponent(id)}/document?type=bol&format=pdf`, {
    headers: { Authorization: getAuthHeader(), Accept: 'application/pdf' },
  });
  if (!res.ok) throw new Error(`BOL download ${id} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`BOL ${id} did not return a PDF (got "${buf.slice(0, 16).toString('latin1')}")`);
  }
  const dir = dirname(savePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(savePath, buf);
  return { savedPath: savePath, bytes: buf.length };
}

/** Get tracking history. */
export async function getTracking(id) {
  return echoFetch('GET', `/shipments/${encodeURIComponent(id)}/tracking`);
}

/**
 * Download a document by its downloadUrl from the documents response.
 * Saves to savePath. Returns { savedPath, contentType, bytes }.
 */
export async function downloadDocument(downloadUrl, savePath) {
  const res = await fetch(downloadUrl, { headers: { Authorization: getAuthHeader() } });
  if (!res.ok) {
    throw new Error(`Document download failed (${res.status}) for ${downloadUrl}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = dirname(savePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(savePath, buf);
  return {
    savedPath: savePath,
    contentType: res.headers.get('content-type'),
    bytes: buf.length,
  };
}

/** Search recent shipments for one matching a customer name / zip / etc. */
export async function findRecentShipmentByConsignee({ consignee = null, zip = null, dateFrom = null, dateTo = null, limit = 50 }) {
  // EchoShip's list endpoint doesn't filter by consignee, so we list + grep locally.
  const list = await listShipments({ dateFrom, dateTo, limit });
  const shipments = list.shipments || list.Shipments || list.data || list.results || (Array.isArray(list) ? list : []);
  if (!consignee && !zip) return shipments;
  const lc = consignee ? consignee.toLowerCase() : null;
  return shipments.filter(s => {
    const stops = s.Stops || s.stops || [];
    const dropStop = stops.find(p => (p.StopType || p.stopType) === 'DROP') || stops[stops.length - 1];
    const consigneeName = String(dropStop?.LocationName || dropStop?.locationName || s.consignee?.name || '').toLowerCase();
    const consigneeZip = String(dropStop?.PostalCode || dropStop?.postalCode || s.consignee?.zip || '');
    if (lc && consigneeName.includes(lc)) return true;
    if (zip && consigneeZip === zip) return true;
    return false;
  });
}
