/**
 * Salesforce REST queries.
 *
 * Every read this app needs, and nothing that writes. The whole integration surface for
 * *changing* anything is a mailbox (spec section 1) — Salesforce is only ever consulted
 * here to answer "what does the order need", "is this device id free", and "did the load
 * land".
 */

import {
  readSession,
  markSessionExpired,
  markSessionVerified,
  refreshSessionSilently,
} from './sf-session.js';
import { decodeSku, describeProduct, scoreSkuMatch } from './sku-decoder.js';
import { loadProfiles, loadOperations } from '../lib/config.js';
import {
  loadLifecycle,
  classifyStage,
  operationMovement,
  pollingOrder,
  operationForSyncBase,
  summariseStages,
} from '../lib/lifecycle.js';

export class SalesforceNotConnectedError extends Error {
  constructor(env) {
    super(`Not connected to ${env}. Connect on the Connect screen first.`);
    this.name = 'SalesforceNotConnectedError';
    this.status = 401;
    this.env = env;
  }
}

export class SalesforceSessionExpiredError extends Error {
  constructor(env, reason = null) {
    super(
      `The ${env} Salesforce session has expired and could not be renewed automatically` +
        (reason ? ` (${reason}).` : '.') +
        ' Reconnect to continue.'
    );
    this.name = 'SalesforceSessionExpiredError';
    this.status = 401;
    this.env = env;
    this.reason = reason;
  }
}

/** Escape a value for embedding in a SOQL string literal. */
export function soqlString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function soqlInList(values) {
  return values.map((v) => `'${soqlString(v)}'`).join(',');
}

/**
 * One REST call.
 *
 * On 401 the sid is re-minted from the remembered browser profile and the call retried once,
 * silently. A Salesforce sid expires on the org's session timeout — a couple of hours — while the
 * profile's trust lasts weeks, so the overwhelming majority of 401s need no human at all. Only when
 * the refresh cannot produce a working sid does this surface as "reconnect".
 */
async function request(env, urlPath, { method = 'GET', allowRefresh = true } = {}) {
  const session = readSession(env);
  if (!session) throw new SalesforceNotConnectedError(env);

  const url = `${session.instanceUrl}/services/data/${session.apiVersion}${urlPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${session.sid}`,
      Accept: 'application/json',
    },
  });

  if (res.status === 401) {
    if (allowRefresh) {
      const refresh = await refreshSessionSilently(env);
      if (refresh.refreshed) {
        // Retry once with the new sid. allowRefresh:false so a genuinely dead session cannot loop.
        return request(env, urlPath, { method, allowRefresh: false });
      }
      markSessionExpired(env, `401 and silent refresh failed: ${refresh.reason}`);
      throw new SalesforceSessionExpiredError(env, refresh.reason);
    }
    markSessionExpired(env);
    throw new SalesforceSessionExpiredError(env);
  }
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = Array.isArray(parsed)
        ? parsed.map((e) => `${e.errorCode}: ${e.message}`).join('; ')
        : JSON.stringify(parsed);
    } catch {
      /* keep the raw body */
    }
    throw new Error(`Salesforce ${res.status} on ${urlPath} — ${detail}`);
  }

  markSessionVerified(env);
  return res.json();
}

/** Run a SOQL query, following nextRecordsUrl so callers always get the full set. */
export async function query(env, soql) {
  let result = await request(env, `/query/?q=${encodeURIComponent(soql)}`);
  const records = [...result.records];
  while (!result.done && result.nextRecordsUrl) {
    const suffix = result.nextRecordsUrl.split(/\/services\/data\/v[\d.]+/)[1];
    result = await request(env, suffix);
    records.push(...result.records);
  }
  return records;
}

/** Cheap liveness probe used by the Connect screen. */
export async function verifyConnection(env) {
  const records = await query(env, 'SELECT Id FROM Organization LIMIT 1');
  return { ok: true, organizationId: records[0]?.Id ?? null };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Every column the catalog query would like, and whether the query is allowed to go without it.
 *
 * `required` means standard — present on `Product2` in any Salesforce org, so an org missing one is
 * broken rather than merely configured differently, and the query should fail loudly. Everything
 * else is a custom field (`__c`) and therefore a **per-org deployment artifact**: it is asked for
 * only when the org's own describe says it exists.
 *
 * This is not hypothetical. `L1_Product_Family__c` exists on `Product2` in testing and does not
 * exist in staging (verified 2026-08-15). SOQL is all-or-nothing on its SELECT list — one unknown
 * column fails the entire request with `INVALID_FIELD` — so naming it unconditionally returned
 * *zero* products in staging rather than fewer, and the Families & SKUs picker rendered empty for
 * every family.
 */
export const CATALOG_FIELDS = [
  { api: 'Id', required: true },
  { api: 'ProductCode', required: true },
  { api: 'Name', required: true },
  { api: 'Family', required: true },
  { api: 'Product_SKU__c' },
  { api: 'Device_Type__c' },
  { api: 'IDMS_Device_Type__c' },
  { api: 'Product_Serialized__c' },
  { api: 'Product_Series__c' },
  { api: 'Product_Category__c' },
  { api: 'L1_Product_Family__c' },
];

/**
 * The `Product_Series__c IN (…)` values, or none.
 *
 * These come from `config/profiles.json`, not from a request, but they are still interpolated into
 * SOQL — so anything that could terminate the literal is dropped rather than escaped. A series name
 * is a short identifier like `HAPTIC` or `D810`; a value carrying a quote or a backslash is a
 * mistake in the config, and silently ignoring it is safer than shipping it to the query planner.
 */
function safeSeries(series) {
  return (Array.isArray(series) ? series : [])
    .map((s) => String(s).trim())
    .filter((s) => s && /^[\w .+-]+$/.test(s));
}

/**
 * The catalog SOQL, built against the fields this org actually exposes.
 *
 * `availableFields` is the org's describe, or `null` when it could not be read — in which case
 * every field is asked for, which is exactly what this app did before it consulted describe, so an
 * unreadable describe costs nothing that already worked.
 *
 * Both halves of the `WHERE` degrade with the fields behind them. `Product_Serialized__c = 'Yes'`
 * is the right gate for almost everything, but not all of it: Haptic's only product is flagged
 * `No` in the org while this app mints serials for it and loads it through a verified sheet, so
 * `includeSeries` reopens the gate for exactly the series a family rule names rather than dropping
 * the filter and pulling in 555 products no template can load. An org exposing neither field gets
 * every active product — too many rows costs the operator a search, none stops the run, which is
 * the same trade `filterCatalogByFamily` makes when a rule matches nothing.
 *
 * `IsActive = true` is never dropped: a retired product cannot be loaded and must never be offered.
 */
export function buildCatalogSoql({ availableFields = null, includeSeries = [] } = {}) {
  const has = (api) =>
    availableFields === null || [...availableFields].some((f) => String(f) === api);
  const selected = CATALOG_FIELDS.filter((f) => f.required || has(f.api)).map((f) => f.api);

  // Product_Series__c is the org's "L3 Product Series" and is what the picker's family filter keys
  // on — the only field naming a product line exactly (DHUB, DMS, VBUS, D810, HAPTIC, the
  // D-series). Device_Type__c is too coarse: every Driveri model *and* Octo share `Driveri`.
  const series = has('Product_Series__c') ? safeSeries(includeSeries) : [];
  const gates = [
    has('Product_Serialized__c') ? "Product_Serialized__c = 'Yes'" : null,
    series.length ? `Product_Series__c IN ('${series.join("','")}')` : null,
  ].filter(Boolean);

  return (
    `SELECT ${selected.join(', ')}\n` +
    `  FROM Product2\n` +
    ` WHERE IsActive = true` +
    (gates.length ? ` AND (${gates.join(' OR ')})` : '') +
    `\n ORDER BY ProductCode`
  );
}

/**
 * Which fields an sObject exposes in this org, or `null` if the describe could not be read.
 *
 * Cached for the process: object metadata changes on a deployment, not between two page loads, and
 * the catalog itself is already cached for ten minutes upstream.
 */
const describedFields = new Map();

export async function fieldsOn(env, sobject) {
  const key = `${env}:${sobject}`;
  if (describedFields.has(key)) return describedFields.get(key);
  let fields = null;
  try {
    const describe = await request(env, `/sobjects/${sobject}/describe`);
    fields = describe.fields.map((f) => f.name);
  } catch {
    // Deliberately swallowed: an unreadable describe is a reason to fall back to asking for every
    // field, not to fail the catalog. If a field is genuinely absent the query then fails with
    // INVALID_FIELD, which the picker now reports rather than hiding.
    fields = null;
  }
  describedFields.set(key, fields);
  return fields;
}

/**
 * Serialized product catalog. Product_Serialized__c = 'Yes' is what decides whether a line
 * needs device serials — not the family, not the name (spec section 8).
 */
export async function fetchSerializedCatalog(env, { includeSeries = [] } = {}) {
  const availableFields = await fieldsOn(env, 'Product2');
  const records = await query(env, buildCatalogSoql({ availableFields, includeSeries }));
  return records.map((p) => ({
    id: p.Id,
    productCode: p.ProductCode,
    productSku: p.Product_SKU__c,
    name: p.Name,
    deviceType: p.Device_Type__c,
    idmsDeviceType: p.IDMS_Device_Type__c,
    family: p.Family,
    // "L3 Product Series" / "L2 Product Category" / "L1 Product Family" in the org's own
    // hierarchy. The series is what the picker filters families on.
    productSeries: p.Product_Series__c,
    productCategory: p.Product_Category__c,
    l1Family: p.L1_Product_Family__c,
    // Whether the org itself considers this serialized. Not always true of rows the picker shows —
    // Haptic's module says No while its sheet loads generated serials — so it is reported rather
    // than assumed.
    serialized: p.Product_Serialized__c === 'Yes',
    // Family = 'Hardware' is the device population; everything else serialized is treated
    // as an accessory by the picker.
    kind: p.Family === 'Hardware' ? 'device' : 'accessory',
    decoded: decodeSku(p.ProductCode),
  })).map((p) => ({
    // The picker's one-line "what is this". Attached here rather than derived in the UI so the
    // decode and its fallback have one definition — 31 of these rows are accessories whose codes
    // no positional decoder can read, and `decoded.decoded` stays honestly `false` for them.
    ...p,
    description: describeProduct(p),
  }));
}

export function searchCatalog(catalog, queryText, { kind = null, limit = 100 } = {}) {
  return catalog
    .filter((p) => (kind ? p.kind === kind : true))
    .map((p) => ({
      product: p,
      score: scoreSkuMatch(
        {
          ProductCode: p.productCode,
          Product_SKU__c: p.productSku,
          Name: p.name,
          Device_Type__c: p.deviceType,
          IDMS_Device_Type__c: p.idmsDeviceType,
          Family: p.family,
        },
        queryText
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.product.productCode.localeCompare(b.product.productCode))
    .slice(0, limit)
    .map((r) => r.product);
}

/** Live Asset picklists, falling back to the verified list in config when offline. */
export async function fetchAssetPicklists(env) {
  const fallback = loadProfiles().picklists;
  try {
    const describe = await request(env, '/sobjects/Asset/describe');
    const pick = (name) =>
      describe.fields
        .find((f) => f.name === name)
        ?.picklistValues.filter((v) => v.active)
        .map((v) => v.value) ?? null;

    return {
      source: 'live',
      product_type: pick('Product_Type__c') ?? fallback.product_type,
      device_category: pick('Device_Category__c') ?? fallback.device_category,
    };
  } catch {
    return { source: 'config-fallback', ...fallback };
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Resolve an order by OrderNumber and read its lines.
 *
 * Note what is NOT here: any filter on Status = 'Confirmed'. No Order in this org has ever
 * had that status (spec section 9 trap 1); a finished order is 'Activated'. Status is
 * reported for display and for the Partially Shipped warning, never used to find orders.
 */
export async function fetchOrder(env, orderNumber) {
  const number = String(orderNumber ?? '').trim();
  if (!number) throw new Error('An order number is required.');

  const orders = await query(
    env,
    `SELECT Id, OrderNumber, Status, AccountId, Account.Name, TotalAmount, CreatedDate, EffectiveDate
       FROM Order
      WHERE OrderNumber = '${soqlString(number)}'
      LIMIT 1`
  );
  if (!orders.length) throw new Error(`No order found with OrderNumber ${number}.`);
  const order = orders[0];

  const items = await query(
    env,
    `SELECT Id, Quantity, UnitPrice, Product2Id, Product2.Name, Product2.ProductCode,
            Product2.Product_SKU__c, Product2.Family, Product2.Product_Serialized__c
       FROM OrderItem
      WHERE OrderId = '${soqlString(order.Id)}'`
  );

  const lines = items.map((it) => {
    const serialized = it.Product2?.Product_Serialized__c === 'Yes';
    const code = it.Product2?.ProductCode ?? null;
    return {
      orderItemId: it.Id,
      sku: code,
      productSku: it.Product2?.Product_SKU__c ?? null,
      name: it.Product2?.Name ?? null,
      family: it.Product2?.Family ?? null,
      // Quantity comes straight from the order. The old pack-factor heuristic derived it
      // from digits in the SKU, which are option flags (spec section 9 trap 3).
      quantity: Number(it.Quantity ?? 0),
      serialized,
      kind: it.Product2?.Family === 'Hardware' ? 'device' : 'accessory',
      decoded: code ? decodeSku(code) : null,
    };
  });

  const { orderStatus } = loadProfiles();
  const serializedLines = lines.filter((l) => l.serialized);

  return {
    orderId: order.Id,
    orderNumber: order.OrderNumber,
    status: order.Status,
    accountName: order.Account?.Name ?? null,
    createdDate: order.CreatedDate,
    effectiveDate: order.EffectiveDate,
    lines,
    serializedLines,
    requiredSerialTotal: serializedLines.reduce((n, l) => n + l.quantity, 0),
    statusFlags: {
      isComplete: orderStatus.completeStatuses.includes(order.Status),
      isBlocked: orderStatus.blockedStatuses.includes(order.Status),
      // Partially Shipped hides the Load Asset & Ship Order button and dead-ends the flow.
      blockedReason: orderStatus.blockedStatuses.includes(order.Status)
        ? `Order is ${order.Status}, which hides the "Load Asset & Ship Order" button. ` +
          'This order cannot be completed through the wizard — pick a different order.'
        : null,
    },
  };
}

/** Recent orders for the picker, so nobody has to remember an order number. */
export async function fetchRecentOrders(env, { limit = 25 } = {}) {
  const records = await query(
    env,
    `SELECT Id, OrderNumber, Status, Account.Name, CreatedDate
       FROM Order
      WHERE Status IN ('Activated','Ready to Ship','Sent to Fulfillment','Received','Draft')
      ORDER BY CreatedDate DESC
      LIMIT ${Number(limit)}`
  );
  return records.map((o) => ({
    orderId: o.Id,
    orderNumber: o.OrderNumber,
    status: o.Status,
    accountName: o.Account?.Name ?? null,
    createdDate: o.CreatedDate,
  }));
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Every Asset field a minted id can land in.
 *
 * A candidate is unusable if it collides in *any* of them, so this list is the whole of what the
 * allocator can see — a series whose values land somewhere absent here is allocated blind.
 *
 *   Name            device_id, driveri_hub_id, serial_number — the join key for everything
 *   SIM_Serial__c   sim_serial
 *   Device_IMEI__c  device_imei
 *   Wifi_Mac__c     mac_id
 *
 * `Wifi_Mac__c` was missing until 2026-08-15 and a real VBUS load was rejected for it: the org
 * already held `Wifi_Mac__c = 1100928221` on a device loaded in May, the check never asked about
 * that field, and the run minted the same mac again. The tell was the two series moving
 * differently — the serial advanced past its collision because it lives in `Name`, which *was*
 * checked, while the mac stayed on its start value.
 *
 * Octo's `wired_speaker_serial` and `native_cam_serial` become Assets in their own right, so they
 * are covered by `Name`. `server/services/collision-fields.test.js` fails if a new series appears
 * with no field mapped to it.
 */
export const COLLISION_FIELDS = ['Name', 'SIM_Serial__c', 'Device_IMEI__c', 'Wifi_Mac__c'];

/**
 * The URL length Salesforce will accept on a GET query, with margin.
 *
 * Measured against testing 2026-08-15: a single-field query carrying 900 eleven-digit ids encodes
 * to 14,588 characters and succeeds in 686 ms; the same query with 1,200 ids is 19,388 characters
 * and comes back as an HTML error page rather than JSON. The real wall is the documented 16,384;
 * this sits under it so a widened id or an extra field cannot silently cross it.
 */
export const QUERY_URL_LIMIT = 12000;

/**
 * How many candidates to ask about per query.
 *
 * **A query's cost is nearly flat in the number of ids.** Measured against testing 2026-08-15:
 * `Name IN (300)` took 654 ms and `Name IN (900)` took 686 ms — the ~1–2.4 s is fixed per round
 * trip. Chunking at 75 therefore multiplied a fixed cost by the chunk count and bought nothing:
 * one Octo allocation was 14 sequential queries and 33.7 seconds. So the chunk is now as large as
 * the URL budget allows rather than a small constant.
 *
 * Each entry costs its own digits plus `%27…%27%2C` once URL-encoded, and the widest id in the
 * batch sets the rate — 11-digit Driveri ids pack less densely than 6-digit Haptic serials.
 */
export function collisionChunkSize(candidateIds = []) {
  // The widest id present sets the rate. With nothing to measure, assume the widest a descriptor
  // mints (11 digits, Driveri) rather than something optimistic — guessing narrow here is what
  // would push a URL over the limit.
  const widest = (candidateIds ?? []).reduce(
    (max, v) => Math.max(max, String(v ?? '').length),
    0
  ) || 11;
  return Math.max(25, Math.floor(QUERY_URL_LIMIT / (widest + 9)));
}

/**
 * Every query needed to check a batch of candidates — one field per query.
 *
 * Splitting the old `Name IN (…) OR SIM_Serial__c IN (…) OR …` into one query per field halves
 * each one: `Asset` holds 860,748 rows in this org, and an OR across four fields cannot be served
 * from a single index, so it degrades toward a scan (~2.4 s against ~1.1 s single-field). The
 * union of the per-field results is exactly the OR's result set, so nothing about *which*
 * collisions are found changes — only how they are fetched.
 *
 * The SELECT still returns all four fields on every query: a row matched on `Name` may carry a
 * taken `SIM_Serial__c`, and `takenFromRecords` reads all four off every record.
 *
 * Pure, so the plan can be asserted without a network.
 */
export function collisionQueryPlan(candidateIds = []) {
  const ids = [...new Set((candidateIds ?? []).map((v) => String(v ?? '')))].filter(Boolean);
  if (!ids.length) return [];

  const size = collisionChunkSize(ids);
  const plan = [];
  for (let i = 0; i < ids.length; i += size) {
    const inList = soqlInList(ids.slice(i, i + size));
    for (const field of COLLISION_FIELDS) {
      plan.push(`SELECT ${COLLISION_FIELDS.join(', ')} FROM Asset WHERE ${field} IN (${inList})`);
    }
  }
  return plan;
}

/**
 * How many collision queries are in flight at once.
 *
 * They are independent, and awaiting them one at a time was most of allocation's wall clock.
 * Measured on twelve queries: 10.3 s serial, 3.7 s at 4, 1.95 s at 8, 1.74 s at 12, none failing.
 * Six is past the knee of that curve while staying well clear of the org's concurrent-request
 * limits — this runs beside polling and the UI's own reads, and starving those to save a few
 * hundred milliseconds here would be a poor trade.
 */
const COLLISION_QUERY_CONCURRENCY = 6;

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The taken values in a query result.
 *
 * Only values that were actually asked about come back. A matched Asset also carries its own
 * SIM_Serial__c, Device_IMEI__c and Wifi_Mac__c, and reporting those as "taken" told the allocator
 * to step over ids nobody had claimed.
 */
export function takenFromRecords(records, askedIds) {
  const asked = new Set((askedIds ?? []).map(String));
  const taken = new Set();
  for (const record of records ?? []) {
    for (const field of COLLISION_FIELDS) {
      const value = record?.[field];
      if (value && asked.has(String(value))) taken.add(String(value));
    }
  }
  return [...taken];
}

/**
 * Which of these candidate ids are already taken?
 *
 * The whole cost of allocating ids is this call, and all of it is network wait. The plan is one
 * query per (field, chunk), run concurrently, and scored once at the end against the *full*
 * candidate set — the old per-chunk scoring could only recognise a value inside the chunk that
 * fetched its row.
 */
export async function findTakenDeviceIds(env, candidateIds) {
  const ids = [...new Set(candidateIds.map(String))].filter(Boolean);
  if (!ids.length) return [];

  const plan = collisionQueryPlan(ids);
  const results = await mapWithConcurrency(plan, COLLISION_QUERY_CONCURRENCY, (soql) => query(env, soql));
  return takenFromRecords(results.flat(), ids);
}

const FIELDS_FOR_WATCH = `Id, Name, Sync_Status__c, IDMS_Status__c, Status,
       Shipment_Tracking_Id__c, CPQ_Order__c, CPQ_Order__r.OrderNumber, SKU_Number__c,
       Service_Provider__c, Device_Category__c, OTA_Version__c, Shipped_to_3PL_Partner__c,
       NetSuite_PO_Number__c, Vendor_Invoice_Number__c, Received_Date__c, CreatedDate,
       LastModifiedDate`;

export async function fetchAssetsByDeviceId(env, deviceIds) {
  const ids = [...new Set(deviceIds.map(String))].filter(Boolean);
  if (!ids.length) return [];

  // SF strips leading zeros from Asset.Name — query with the stripped form but remap back so
  // the rest of the pipeline (summarisePolling) sees the original padded id it allocated.
  const strippedToOriginal = new Map(ids.map((id) => [id.replace(/^0+/, '') || id, id]));
  const queryIds = [...strippedToOriginal.keys()];

  const out = [];
  const CHUNK = 200;
  for (let i = 0; i < queryIds.length; i += CHUNK) {
    const chunk = queryIds.slice(i, i + CHUNK);
    const records = await query(
      env,
      `SELECT ${FIELDS_FOR_WATCH}
         FROM Asset
        WHERE Name IN (${soqlInList(chunk)})
        ORDER BY CreatedDate DESC`
    );
    out.push(...records);
  }
  return out.map((a) => shapeAsset(a));
}

/** Everything for one order, including devices not yet attached to it. */
export async function fetchAssetsByTrackingId(env, orderNumber) {
  const records = await query(
    env,
    `SELECT ${FIELDS_FOR_WATCH}
       FROM Asset
      WHERE Shipment_Tracking_Id__c = '${soqlString(orderNumber)}'
      ORDER BY CreatedDate DESC`
  );
  return records.map(shapeAsset);
}

function shapeAsset(a) {
  return {
    id: a.Id,
    deviceId: a.Name,
    syncStatus: a.Sync_Status__c,
    idmsStatus: a.IDMS_Status__c,
    assetStatus: a.Status,
    shipmentTrackingId: a.Shipment_Tracking_Id__c,
    cpqOrderId: a.CPQ_Order__c,
    cpqOrderNumber: a.CPQ_Order__r?.OrderNumber ?? null,
    sku: a.SKU_Number__c,
    serviceProvider: a.Service_Provider__c,
    deviceCategory: a.Device_Category__c,
    otaVersion: a.OTA_Version__c,
    shippedTo3pl: a.Shipped_to_3PL_Partner__c,
    poNumber: a.NetSuite_PO_Number__c,
    invoiceNumber: a.Vendor_Invoice_Number__c,
    receivedDate: a.Received_Date__c,
    createdDate: a.CreatedDate,
    lastModifiedDate: a.LastModifiedDate,
    ...classifySyncStatus(a.Sync_Status__c),
  };
}

// ---------------------------------------------------------------------------
// Sync status classification
// ---------------------------------------------------------------------------

/**
 * The _SYNC_SUCCESS / _SYNC_FAILED variants are written by the integration and are NOT
 * picklist members, so this cannot be driven off Asset metadata (spec section 5).
 *
 * Roughly a third of initial loads fail in this org, so failure is treated as an ordinary
 * terminal outcome that ends polling immediately — not as something to wait out.
 */
export function classifySyncStatus(syncStatus) {
  const value = String(syncStatus ?? '');
  if (!value) return { phase: 'absent', terminal: false, failed: false, base: null };

  if (value.endsWith('_SYNC_FAILED')) {
    return {
      phase: 'failed',
      terminal: true,
      failed: true,
      base: value.slice(0, -'_SYNC_FAILED'.length),
    };
  }
  if (value.endsWith('_SYNC_SUCCESS')) {
    return {
      phase: 'success',
      terminal: true,
      failed: false,
      base: value.slice(0, -'_SYNC_SUCCESS'.length),
    };
  }
  return { phase: 'in-progress', terminal: false, failed: false, base: value };
}

/**
 * What to watch for, per operation, derived from the life cycle's own `syncStatus` map.
 *
 * Derived rather than listed so that adding a pollable operation is one line in
 * `config/lifecycle.json` and not a second place to keep in step. An operation with no known
 * base cannot be polled at all — it is absent here, `summarisePolling` refuses it by name, and
 * the UI says so instead of waiting for a status that will never be written.
 */
export const STAGE_EXPECTATIONS = Object.fromEntries(
  Object.entries(loadLifecycle().syncStatus).map(([operation, base]) => {
    const movement = operationMovement(operation);
    return [
      operation,
      {
        label: loadOperations()[operation]?.label ?? operation,
        pending: base,
        success: `${base}_SYNC_SUCCESS`,
        failed: `${base}_SYNC_FAILED`,
        // Where a device lands once this operation succeeds, so the poller can report movement
        // rather than just a status string.
        movesTo: movement?.to?.[0] ?? null,
      },
    ];
  })
);

/**
 * Roll a set of assets up against the stage we are waiting for.
 * `settled` means every device has reached a terminal state — success or failure — which
 * is the condition to stop polling on.
 */
export function summarisePolling(stage, deviceIds, assets) {
  const expectation = STAGE_EXPECTATIONS[stage];
  if (!expectation) throw new Error(`Unknown stage "${stage}"`);

  const byDeviceId = new Map(assets.map((a) => [a.deviceId, a]));
  const rows = deviceIds.map((deviceId) => {
    const asset = byDeviceId.get(String(deviceId));
    if (!asset) {
      return {
        deviceId,
        present: false,
        syncStatus: null,
        phase: 'absent',
        terminal: false,
        failed: false,
        stage: classifyStage(null),
      };
    }
    const reached = asset.syncStatus === expectation.success;
    const failedHere = asset.syncStatus === expectation.failed;
    const chainPos = positionInChain(stage, asset.syncStatus);
    // A terminal unknown status at exactly the expected IDMS means the device completed this
    // stage but a later external operation then overwrote the sync status (e.g.
    // NEW_ORDER_FULFILMENT_SYNC_FAILED appearing after DEVICE_RECEIVED_AT_3PL_SYNC_SUCCESS).
    // Guard: never fire when the sync status is already this operation's own — that status
    // means the device IS at this stage, not past it (fixes rmaReturned off-chain case).
    const idmsAtOrAhead =
      chainPos === 'unknown' &&
      !reached &&
      asset.syncStatus !== expectation.pending &&
      !failedHere &&
      expectation.movesTo !== null &&
      asset.idmsStatus != null &&
      (Number(asset.idmsStatus) > expectation.movesTo ||
        Number(asset.idmsStatus) === expectation.movesTo);
    return {
      // Where this device's own status sits relative to the stage being watched. See
      // `positionInChain` — this is what stops a device that has not reached the stage yet
      // being counted as a success just because it finished an earlier one.
      aheadOfStage: chainPos === 'ahead' || idmsAtOrAhead,
      // True when the device carries an earlier operation's sync status and has not yet had
      // this operation applied — distinct from aheadOfStage so the tab can hide these rows.
      behindStage: chainPos === 'behind',
      deviceId,
      present: true,
      assetId: asset.id,
      syncStatus: asset.syncStatus,
      idmsStatus: asset.idmsStatus,
      assetStatus: asset.assetStatus,
      cpqOrderNumber: asset.cpqOrderNumber,
      phase: asset.phase,
      // The numeric IDMS code placed on the DLCM chart. A device can be at the expected sync
      // status and still not have moved stage yet, so the two are reported separately.
      stage: classifyStage(asset.idmsStatus),
      // A device that has moved past this stage (e.g. already SHIPMENT_UPDATE_SYNC_SUCCESS
      // when we are watching the initial load) counts as done, not stuck.
      terminal: asset.terminal,
      reached,
      failed: failedHere || asset.failed,
      lastModifiedDate: asset.lastModifiedDate,
    };
  });

  return { stage, label: expectation.label, expectation, ...tallyRows(rows) };
}

/**
 * Recompute the stage-relative fields of a stored snapshot.
 *
 * A snapshot is written once and read many times, so anything decided at poll time is frozen at
 * whatever the code understood that day — a snapshot taken before `aheadOfStage` existed carries
 * no opinion about it, and every reader downstream silently falls back. Deriving it here instead
 * means an old snapshot reads exactly like a fresh one.
 *
 * Everything needed is already in the row: `syncStatus` is the fact, the rest is interpretation.
 */
export function rescoreSnapshot(stage, snapshot) {
  const expectation = STAGE_EXPECTATIONS[stage];
  if (!expectation || !snapshot?.rows?.length) return snapshot;

  const rows = snapshot.rows.map((row) => {
    const chainPos = positionInChain(stage, row.syncStatus);
    const isOwn = row.syncStatus === expectation.success ||
                  row.syncStatus === expectation.pending ||
                  row.syncStatus === expectation.failed;
    const idmsAtOrAhead =
      chainPos === 'unknown' &&
      !isOwn &&
      expectation.movesTo !== null &&
      row.idmsStatus != null &&
      (Number(row.idmsStatus) > expectation.movesTo ||
        Number(row.idmsStatus) === expectation.movesTo);
    return {
      ...row,
      reached: row.syncStatus === expectation.success,
      aheadOfStage: chainPos === 'ahead' || idmsAtOrAhead,
      behindStage: chainPos === 'behind' && !idmsAtOrAhead,
    };
  });
  return { ...snapshot, ...tallyRows(rows) };
}

/**
 * Split a tally into the devices still at this stage and the ones that have moved past it.
 *
 * The Watch page shows one tab per stage, and a device that has gone on to a later operation was
 * appearing under every earlier tab — it carries a success there too, so by the old reading it
 * belonged everywhere. Showing it only where it now sits means answering "which devices are at
 * this stage" separately from "did the file I sent land", and both are worth keeping: the second
 * is the record of the send, and it must not vanish just because the devices moved on.
 *
 * Counted by the same `tallyRows` as the whole set, so the two can never drift apart.
 */
export function splitByStagePosition(summary) {
  const movedOn = summary.rows.filter((r) => r.aheadOfStage === true);
  // Devices whose sync status belongs to an earlier operation — they have not had this stage
  // applied yet and should not inflate the "waiting" count for this tab.
  const notYet = summary.rows.filter((r) => r.behindStage === true);
  if (!movedOn.length && !notYet.length) return { ...summary, atStage: null, movedOn: [], notYet: [] };
  const atStageRows = summary.rows.filter((r) => r.aheadOfStage !== true && r.behindStage !== true);
  return {
    ...summary,
    atStage: tallyRows(atStageRows),
    // `id` is the Salesforce Asset id. It is carried through the reduction so the Watch page can
    // link a serial back to its record — a device that has moved on is the one you most want to
    // open. Explicitly null when absent, so an old snapshot reads as "no id" rather than missing.
    movedOn: movedOn.map((r) => ({ deviceId: r.deviceId, assetId: r.assetId ?? null, syncStatus: r.syncStatus, stage: r.stage })),
    notYet: notYet.map((r) => ({ deviceId: r.deviceId, assetId: r.assetId ?? null, syncStatus: r.syncStatus, stage: r.stage })),
  };
}

/**
 * Is a device's own sync status behind, at, or ahead of the stage being watched?
 *
 * Both directions look the same on the Asset — `INITIAL_DEVICE_LOAD_SYNC_SUCCESS` and
 * `SHIPMENT_UPDATE_SYNC_SUCCESS` are each just "some operation succeeded" — so the answer comes
 * from where those two operations sit on the chain in `lifecycle.json`.
 *
 * `unknown` when either end is off the chain: `dataUpdate` moves no device and so has no place in
 * it, and a status this app does not model should never be read as progress. Unknown is treated
 * as not-ahead, which is the cautious reading — it can under-report a success, never invent one.
 */
function positionInChain(stage, syncStatus) {
  // The polling order, not the movement chain: a device that has only had its data update is
  // somewhere real, and comparing against a chain that omits that step reads it as "unknown".
  const chain = pollingOrder();
  const watched = chain.indexOf(stage);
  if (watched === -1) return 'unknown';

  const base = classifySyncStatus(syncStatus).base;
  const operation = base ? operationForSyncBase(base) : null;
  const at = operation ? chain.indexOf(operation) : -1;
  if (at === -1) return 'unknown';

  if (at > watched) return 'ahead';
  return at === watched ? 'at' : 'behind';
}

/**
 * Roll a set of already-classified rows up into counts.
 *
 * Split out so a stored snapshot can be re-tallied after rows are dropped from it without
 * duplicating — and quietly diverging from — the arithmetic used when it was first taken.
 */
export function tallyRows(rows) {
  // Done means: reached this stage, or already past it. A device sitting on an *earlier*
  // operation's success is not done — it simply has not had this operation applied yet, and
  // counting it as a success reports a load that never happened.
  //
  // `aheadOfStage === undefined` is a row from a snapshot taken before this distinction existed;
  // those keep the old "any terminal state is done" reading rather than being re-judged wrongly.
  const isDone = (r) => r.reached || (r.terminal && !r.failed && r.aheadOfStage !== false);

  const succeeded = rows.filter(isDone);
  const failed = rows.filter((r) => r.failed);
  const waiting = rows.filter((r) => !isDone(r) && !r.failed);

  return {
    rows,
    counts: {
      total: rows.length,
      succeeded: succeeded.length,
      failed: failed.length,
      waiting: waiting.length,
      absent: rows.filter((r) => !r.present).length,
    },
    settled: waiting.length === 0,
    anyFailed: failed.length > 0,
    loadedDeviceIds: succeeded.map((r) => r.deviceId),
    failedDeviceIds: failed.map((r) => r.deviceId),
    // Where the devices actually are on the DLCM chart, which is what decides the next step.
    stages: summariseStages(rows.map((r) => r.idmsStatus ?? null)),
  };
}
