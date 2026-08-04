import express from 'express';
import {
  fetchSerializedCatalog,
  searchCatalog,
  fetchAssetPicklists,
  fetchOrder,
  fetchRecentOrders,
} from '../services/sf-client.js';
import {
  loadProfiles,
  loadTemplates,
  loadOperations,
  templateIndex,
  getEnvironment,
  resolveDistributionList,
  sendBlockers,
} from '../lib/config.js';
import { decodeSku } from '../services/sku-decoder.js';

export const catalogRouter = express.Router();

/** Cached per environment — the catalog is ~165 rows and changes rarely. */
const catalogCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getCatalog(env, { refresh = false } = {}) {
  const cached = catalogCache.get(env);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.products;
  const products = await fetchSerializedCatalog(env);
  catalogCache.set(env, { at: Date.now(), products });
  return products;
}

catalogRouter.get('/products', async (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    const products = await getCatalog(env, { refresh: req.query.refresh === 'true' });
    const filtered = req.query.q
      ? searchCatalog(products, req.query.q, { kind: req.query.kind || null })
      : products.filter((p) => (req.query.kind ? p.kind === req.query.kind : true));

    res.json({
      total: products.length,
      counts: {
        device: products.filter((p) => p.kind === 'device').length,
        accessory: products.filter((p) => p.kind === 'accessory').length,
      },
      products: filtered.slice(0, Number(req.query.limit) || 200),
    });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/picklists', async (req, res, next) => {
  try {
    res.json(await fetchAssetPicklists(req.query.env || 'testing'));
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/profiles', (req, res) => {
  const { profiles, default: defaultId, orderStatus } = loadProfiles();
  res.json({ default: defaultId, profiles, orderStatus });
});

catalogRouter.get('/templates', (req, res) => {
  res.json({
    templates: loadTemplates().map((t) => ({
      id: t.id,
      label: t.label,
      family: t.family,
      familyLabel: t.familyLabel,
      operation: t.operation,
      kind: t.kind,
      status: t.status,
      usable: t.status === 'verified',
      sourceTemplate: t.sourceTemplate,
      columnCount: t.columns.length,
      header: t.columns.map((c) => c.name).join(','),
      bytes: t.bytes,
      filenamePattern: t.filenamePattern,
      dateFormat: t.dateFormat ?? 'YYYY-MM-DD',
      series: t.series ?? {},
      defaults: t.defaults ?? {},
      // Which fields the UI should offer for editing, and which columns are always blank.
      editableFields: t.columns
        .filter((c) => c.source?.startsWith('field.'))
        .map((c) => ({ column: c.name, field: c.source.slice('field.'.length), required: Boolean(c.required) })),
      reusesExistingDevices: Boolean(t.reusesExistingDevices),
      awaiting: t.awaiting ?? null,
      notes: t.notes ?? [],
    })),
  });
});

/**
 * The picker's index: every family, the operations it supports, and where each one would be
 * emailed. Mailbox resolution is exposed because the mailbox is the only thing that
 * distinguishes one operation from another.
 */
catalogRouter.get('/families', (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    const operations = loadOperations();
    const { families } = templateIndex();

    res.json({
      operations: Object.entries(operations).map(([id, meta]) => ({ id, ...meta })),
      families: families.map((family) => ({
        family: family.family,
        label: family.label,
        kind: family.kind,
        operations: Object.entries(family.operations).map(([operation, templateId]) => {
          let dl = null;
          let blockers = [];
          try {
            dl = resolveDistributionList(env, family.family, operation);
            blockers = sendBlockers(env, family.family, operation);
          } catch (err) {
            blockers = [err.message];
          }
          return {
            operation,
            label: operations[operation]?.label ?? operation,
            templateId,
            needsMail: operations[operation]?.needsMail !== false,
            to: dl?.to ?? null,
            dlSource: dl ? `${dl.source}["${dl.key}"]` : null,
            blockers,
            ready: blockers.length === 0,
          };
        }),
      })),
    });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/decode/:code', (req, res) => {
  res.json(decodeSku(req.params.code));
});

// --- Orders ---------------------------------------------------------------

catalogRouter.get('/orders/recent', async (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    res.json({ orders: await fetchRecentOrders(env, { limit: Number(req.query.limit) || 25 }) });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/orders/:orderNumber', async (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    const order = await fetchOrder(env, req.params.orderNumber);
    res.json({ order, environment: publicEnv(env) });
  } catch (err) {
    next(err);
  }
});

function publicEnv(name) {
  const env = getEnvironment(name);
  return {
    name,
    label: env.label,
    verified: env.verified,
    distributionLists: env.distributionLists,
    unconfigured: env.unconfigured,
    ready: env.unconfigured.length === 0,
  };
}
