/**
 * scripts/lib/shipping/fedex.mjs
 *
 * Locked FedEx booking module.
 * imageType: PDF, labelStockType: STOCK_4X6 — HARD-CODED.
 * No caller can request a PNG label or a different stock size.
 *
 * Why locked: today's failure mode was the agent picking imageType: PNG
 * → label printed wrong size. Hard-coding makes the wrong format impossible.
 *
 * Exports:
 *   bookGround(opts)         — FedEx Ground (residential auto-routes to Home Delivery)
 *   bookHomeDelivery(opts)   — explicitly FedEx Home Delivery for residential
 *   bookFreight(opts)        — FedEx Freight Priority for LTL (rarely used; usually Echo)
 *   voidShipment(tracking)   — cancels an existing tracking
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Booked label PDFs persist here (durable across reboots / /tmp cleanup, which once
// lost a label before it shipped). Tidied on a 90-day retention by labels-cleanup.sh.
const LABELS_DIR = fileURLToPath(new URL('../../../data/labels', import.meta.url));
fs.mkdirSync(LABELS_DIR, { recursive: true });

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

const FEDEX_BASE = 'https://apis.fedex.com';

const SHIPPER_LOCKED = {
  contact: {
    personName: 'ROBERT EGGERS',
    phoneNumber: '5125510805',
    companyName: 'CHILLX CHILLERS',
    emailAddress: 'shipping@chillxchillers.com',
  },
  address: {
    streetLines: ['430 CR 266', 'UNIT 1A'],
    city: 'BERTRAM',
    stateOrProvinceCode: 'TX',
    postalCode: '78605',
    countryCode: 'US',
  },
};

async function token() {
  const r = await fetch(`${FEDEX_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ENV.FEDEX_API_KEY}&client_secret=${ENV.FEDEX_SECRET_KEY}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`FedEx OAuth failed: ${JSON.stringify(j).slice(0, 300)}`);
  return j.access_token;
}

function recipientFrom(opts) {
  // opts.ship_to: { company, street1, street2, city, state, zip, residential }
  // opts.ship_to_contact: { name, phone, email }
  const a = opts.ship_to;
  const c = opts.ship_to_contact || {};
  return {
    contact: {
      personName: c.name || a.company,
      phoneNumber: (c.phone || '0000000000').replace(/\D/g, '').slice(-10).padStart(10, '0'),
      companyName: a.company,
      emailAddress: c.email || '',
    },
    address: {
      streetLines: [a.street1, a.street2].filter(Boolean),
      city: a.city,
      stateOrProvinceCode: a.state,
      postalCode: a.zip,
      countryCode: a.country || 'US',
      residential: !!a.residential,
    },
  };
}

function packageFrom(opts, sequenceNumber = 1) {
  // opts.weight_lb, opts.dimensions: {length,width,height}, opts.declared_value, opts.references: [{type, value}]
  const refs = (opts.references || []).map(r => ({
    customerReferenceType: r.type || 'CUSTOMER_REFERENCE',
    value: r.value,
  }));
  return {
    sequenceNumber,  // 1-based; FedEx requires it on every piece when totalPackageCount > 1 (multi-piece)
    weight: { units: 'LB', value: opts.weight_lb },
    dimensions: { ...opts.dimensions, units: 'IN' },
    declaredValue: { amount: opts.declared_value, currency: 'USD' },
    customerReferences: refs,
  };
}

function emailNotificationDetailFrom(opts) {
  // Build FedEx tracking-email recipients. Always copy SHIPPER (shipping@) for
  // audit trail; include RECIPIENT only if we actually have a customer email.
  // Events: ON_TENDER (pickup scan), ON_ESTIMATED_DELIVERY (ETA),
  // ON_DELIVERY (delivered), ON_EXCEPTION (delays). We deliberately skip
  // ON_SHIPMENT because it fires at label creation, before the package moves.
  const events = ['ON_TENDER', 'ON_ESTIMATED_DELIVERY', 'ON_DELIVERY', 'ON_EXCEPTION'];
  const recipients = [
    {
      name: 'CHILLX Shipping',
      emailAddress: 'shipping@chillxchillers.com',
      emailNotificationRecipientType: 'SHIPPER',
      notificationFormatType: 'HTML',
      notificationType: 'EMAIL',
      locale: 'en_US',
      notificationEventType: events,
    },
  ];
  const custEmail = opts.ship_to_contact?.email?.trim();
  if (custEmail) {
    recipients.push({
      name: opts.ship_to_contact.name || opts.ship_to?.company || 'Customer',
      emailAddress: custEmail,
      emailNotificationRecipientType: 'RECIPIENT',
      notificationFormatType: 'HTML',
      notificationType: 'EMAIL',
      locale: 'en_US',
      notificationEventType: events,
    });
  }
  return { aggregationType: 'PER_SHIPMENT', emailNotificationRecipients: recipients };
}

async function book(serviceType, opts) {
  const tok = await token();
  const payload = {
    labelResponseOptions: 'LABEL',
    accountNumber: { value: ENV.FEDEX_ACCOUNT_NUMBER },
    requestedShipment: {
      shipper: SHIPPER_LOCKED,
      recipients: [recipientFrom(opts)],
      pickupType: 'USE_SCHEDULED_PICKUP',
      serviceType,
      packagingType: 'YOUR_PACKAGING',
      shippingChargesPayment: { paymentType: 'SENDER' },
      // LOCKED: PDF format, 4x6 stock. No caller overrides allowed.
      labelSpecification: { labelStockType: 'STOCK_4X6', imageType: 'PDF', labelFormatType: 'COMMON2D' },
      // FedEx-side tracking-email notifications to customer + shipper.
      // Added 2026-06-11 — supersedes the manual CHILLX duplicate when email is on file.
      emailNotificationDetail: emailNotificationDetailFrom(opts),
      totalPackageCount: (opts.packages || [opts]).length,
      requestedPackageLineItems: (opts.packages || [opts]).map((p, i) => packageFrom(p, i + 1)),
    },
  };

  const r = await fetch(`${FEDEX_BASE}/ship/v1/shipments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  if (!r.ok) {
    // Auto-retry Ground→Home Delivery when FedEx says it's residential
    if (serviceType === 'FEDEX_GROUND' && txt.includes('FedEx Home Delivery')) {
      return book('GROUND_HOME_DELIVERY', opts);
    }
    throw new Error(`FedEx book failed (${serviceType}): ${r.status} ${txt.slice(0, 600)}`);
  }
  const data = JSON.parse(txt);
  const tx = data.output?.transactionShipments?.[0];
  const pieces = (tx?.pieceResponses || []).map(pr => ({
    trackingNumber: pr.trackingNumber,
    labelBase64: pr.packageDocuments?.[0]?.encodedLabel,
  }));
  if (!pieces.length || !pieces[0].labelBase64) {
    throw new Error(`FedEx book returned no label: ${JSON.stringify(data).slice(0, 500)}`);
  }
  // Save each piece's label PDF to data/labels (durable; tidied by labels-cleanup.sh)
  const labels = pieces.map(p => {
    const path = `${LABELS_DIR}/fedex-${p.trackingNumber}.pdf`;
    fs.writeFileSync(path, Buffer.from(p.labelBase64, 'base64'));
    return { trackingNumber: p.trackingNumber, labelPath: path };
  });
  // Extract the actual rated charge from the ship response (FedEx returns it
  // in completedShipmentDetail.shipmentRating). Lets callers log the real cost,
  // and powers book-and-void rate lookups while the Rate API is unprovisioned.
  const rating = tx?.completedShipmentDetail?.shipmentRating?.shipmentRateDetails?.[0]
    || tx?.pieceResponses?.[0]?.packageRating?.packageRateDetails?.[0]
    || null;
  const netCharge = rating?.totalNetCharge ?? rating?.totalNetFedExCharge ?? null;
  return {
    masterTracking: tx?.masterTrackingNumber || pieces[0].trackingNumber,
    pieces: labels,
    serviceType,
    netCharge: netCharge != null ? Number(netCharge) : null,
    rateDetail: rating,
  };
}

export const bookGround = (opts) => book('FEDEX_GROUND', opts);

/**
 * Book a RETURN label: customer ships back to CHILLX Bertram, we pay.
 * Shipper = the customer (opts.ship_to / ship_to_contact — same shape as bookGround,
 * they're the party physically tendering the box); recipient = SHIPPER_LOCKED.
 * Uses FedEx PRINT_RETURN_LABEL — no pickup is scheduled; the customer drops off
 * or hands to any FedEx driver. Label is emailed/printed by US, not FedEx.
 */
export async function bookReturn(opts) {
  const tok = await token();
  const payload = {
    labelResponseOptions: 'LABEL',
    accountNumber: { value: ENV.FEDEX_ACCOUNT_NUMBER },
    requestedShipment: {
      shipper: recipientFrom(opts),          // customer is the shipper on a return
      recipients: [SHIPPER_LOCKED],          // coming back to Bertram
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      serviceType: 'FEDEX_GROUND',
      packagingType: 'YOUR_PACKAGING',
      shippingChargesPayment: { paymentType: 'SENDER' }, // our account pays either way
      labelSpecification: { labelStockType: 'STOCK_4X6', imageType: 'PDF', labelFormatType: 'COMMON2D' },
      shipmentSpecialServices: {
        specialServiceTypes: ['RETURN_SHIPMENT'],
        returnShipmentDetail: { returnType: 'PRINT_RETURN_LABEL' },
      },
      totalPackageCount: 1,
      requestedPackageLineItems: [packageFrom(opts)],
    },
  };
  const r = await fetch(`${FEDEX_BASE}/ship/v1/shipments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`FedEx bookReturn failed: ${r.status} ${txt.slice(0, 600)}`);
  const data = JSON.parse(txt);
  const tx = data.output?.transactionShipments?.[0];
  const pr = tx?.pieceResponses?.[0];
  if (!pr?.packageDocuments?.[0]?.encodedLabel) throw new Error(`FedEx bookReturn returned no label: ${JSON.stringify(data).slice(0, 400)}`);
  const path = `${LABELS_DIR}/fedex-return-${pr.trackingNumber}.pdf`;
  fs.writeFileSync(path, Buffer.from(pr.packageDocuments[0].encodedLabel, 'base64'));
  return { trackingNumber: pr.trackingNumber, labelPath: path, serviceType: 'FEDEX_GROUND' };
}
export const bookHomeDelivery = (opts) => book('GROUND_HOME_DELIVERY', opts);
export const bookFreight = (opts) => book('FEDEX_FREIGHT_PRIORITY', opts);

/**
 * Get FedEx parcel rate quotes WITHOUT creating a shipment.
 *
 * Endpoint: POST /rate/v1/rates/quotes — note the `/quotes` suffix. Hitting
 * `/rate/v1/rates` (no suffix) returns a 404 NOT.FOUND that looks like a
 * provisioning error but is just the wrong path (learned 2026-06-15).
 *
 * @param opts {
 *   ship_to: { city?, state, zip, country?, residential? },
 *   weight_lb,
 *   dimensions: { length, width, height },   // inches
 *   declared_value?,                          // optional; adds insurance to the quote
 *   services?: string[],                      // filter, e.g. ['FEDEX_GROUND','GROUND_HOME_DELIVERY']; default = all
 * }
 * @returns sorted array of { serviceType, netCharge, billingWeightLb, transit }
 */
export async function getRate(opts) {
  const tok = await token();
  const a = opts.ship_to;
  const pkg = {
    weight: { units: 'LB', value: opts.weight_lb },
    dimensions: { ...opts.dimensions, units: 'IN' },
  };
  if (opts.declared_value != null) {
    pkg.declaredValue = { amount: opts.declared_value, currency: 'USD' };
  }
  const payload = {
    accountNumber: { value: ENV.FEDEX_ACCOUNT_NUMBER },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: { address: { ...SHIPPER_LOCKED.address } },
      recipient: {
        address: {
          city: a.city,
          stateOrProvinceCode: a.state,
          postalCode: a.zip,
          countryCode: a.country || 'US',
          residential: !!a.residential,
        },
      },
      pickupType: 'USE_SCHEDULED_PICKUP',
      rateRequestType: ['ACCOUNT'],
      packagingType: 'YOUR_PACKAGING',
      requestedPackageLineItems: [pkg],
    },
  };
  const r = await fetch(`${FEDEX_BASE}/rate/v1/rates/quotes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`FedEx rate failed: ${r.status} ${txt.slice(0, 400)}`);
  const data = JSON.parse(txt);
  const filter = opts.services ? new Set(opts.services) : null;
  const out = [];
  for (const s of (data.output?.rateReplyDetails || [])) {
    if (filter && !filter.has(s.serviceType)) continue;
    const detail =
      s.ratedShipmentDetails?.find((d) => d.rateType === 'ACCOUNT') ||
      s.ratedShipmentDetails?.[0];
    out.push({
      serviceType: s.serviceType,
      netCharge: detail?.totalNetCharge != null ? Number(detail.totalNetCharge) : null,
      billingWeightLb: detail?.shipmentRateDetail?.totalBillingWeight?.value ?? null,
      transit: s.commit?.dateDetail?.dayCxsFormat || s.commit?.transitDays?.description || null,
    });
  }
  return out.sort((x, y) => (x.netCharge ?? 9e9) - (y.netCharge ?? 9e9));
}

/**
 * Void/cancel an existing FedEx shipment by tracking number.
 */
export async function voidShipment(trackingNumber) {
  const tok = await token();
  const r = await fetch(`${FEDEX_BASE}/ship/v1/shipments/cancel`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify({
      accountNumber: { value: ENV.FEDEX_ACCOUNT_NUMBER },
      trackingNumber,
      deletionControl: 'DELETE_ONE_PACKAGE',
    }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Void failed: ${r.status} ${txt.slice(0, 400)}`);
  return JSON.parse(txt);
}
