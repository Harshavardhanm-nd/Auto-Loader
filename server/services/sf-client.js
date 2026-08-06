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
import { decodeSku, scoreSkuMatch } from './sku-decoder.js';
import { loadProfiles, loadOperations } from '../lib/config.js';
import {
  loadLifecycle,
  classifyStage,
  operationMovement,
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
 * Serialized product catalog. Product_Serialized__c = 'Yes' is what decides whether a line
 * needs device serials — not the family, not the name (spec section 8).
 */
export async function fetchSerializedCatalog(env) {
  const records = await query(
    env,
    `SELECT Id, ProductCode, Product_SKU__c, Name, Device_Type__c, IDMS_Device_Type__c, Family
       FROM Product2
      WHERE IsActive = true AND Product_Serialized__c = 'Yes'
      ORDER BY ProductCode`
  );
  return records.map((p) => ({
    id: p.Id,
    productCode: p.ProductCode,
    productSku: p.Product_SKU__c,
    name: p.Name,
    deviceType: p.Device_Type__c,
    idmsDeviceType: p.IDMS_Device_Type__c,
    family: p.Family,
    // Family = 'Hardware' is the device population; everything else serialized is treated
    // as an accessory by the picker.
    kind: p.Family === 'Hardware' ? 'device' : 'accessory',
    decoded: decodeSku(p.ProductCode),
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
 * Which of these device ids already exist? Asset.Name IS the device_id — that is the join
 * key for everything (spec section 6).
 */
export async function findTakenDeviceIds(env, candidateIds) {
  const ids = [...new Set(candidateIds.map(String))].filter(Boolean);
  if (!ids.length) return [];

  const taken = new Set();
  // Chunked to keep the SOQL statement well under the 100k character limit.
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const records = await query(
      env,
      `SELECT Name FROM Asset WHERE Name IN (${soqlInList(chunk)})`
    );
    for (const r of records) taken.add(r.Name);
  }
  return [...taken];
}

const FIELDS_FOR_WATCH = `Id, Name, Sync_Status__c, IDMS_Status__c, Status,
       Shipment_Tracking_Id__c, CPQ_Order__c, CPQ_Order__r.OrderNumber, SKU_Number__c,
       Service_Provider__c, Device_Category__c, OTA_Version__c, Shipped_to_3PL_Partner__c,
       NetSuite_PO_Number__c, Vendor_Invoice_Number__c, Received_Date__c, CreatedDate,
       LastModifiedDate`;

export async function fetchAssetsByDeviceId(env, deviceIds) {
  const ids = [...new Set(deviceIds.map(String))].filter(Boolean);
  if (!ids.length) return [];

  const out = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const records = await query(
      env,
      `SELECT ${FIELDS_FOR_WATCH}
         FROM Asset
        WHERE Name IN (${soqlInList(chunk)})
        ORDER BY CreatedDate DESC`
    );
    out.push(...records);
  }
  return out.map(shapeAsset);
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
    return {
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

  const succeeded = rows.filter((r) => r.reached || (r.terminal && !r.failed));
  const failed = rows.filter((r) => r.failed);
  const waiting = rows.filter((r) => !r.terminal);

  return {
    stage,
    label: expectation.label,
    expectation,
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
