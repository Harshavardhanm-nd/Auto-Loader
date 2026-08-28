import express from 'express';
import {
  fetchSerializedCatalog,
  searchCatalog,
  fetchAssetPicklists,
  fetchOrder,
  fetchRecentOrders,
  fetchPricebooks,
  fetchPricebookProductIds,
  isSalesforceId,
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
import { declaredSeries, scopeCatalog } from '../services/catalog-filter.js';
import { describeLifecycle } from '../lib/lifecycle.js';

export const catalogRouter = express.Router();

/** Cached per environment — the catalog is ~165 rows and changes rarely. */
const catalogCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getCatalog(env, { refresh = false } = {}) {
  const cached = catalogCache.get(env);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.products;
  // Widened to reach the series a family rule names but the serialized flag would exclude.
  const products = await fetchSerializedCatalog(env, {
    includeSeries: declaredSeries(loadProfiles().catalogFilters),
  });
  catalogCache.set(env, { at: Date.now(), products });
  return products;
}

/**
 * Pricebooks change far less often than products, and membership is an id-only read, so both share
 * the catalog's 10-minute TTL. Membership is keyed per book, so switching books costs one small
 * query once — and toggling sellability costs none at all, because `notForSale` is a field on the
 * row rather than a query parameter.
 */
const pricebookListCache = new Map(); // env -> { at, pricebooks }
const pricebookMemberCache = new Map(); // `${env}:${pricebookId}` -> { at, ids }

async function getPricebooks(env) {
  const cached = pricebookListCache.get(env);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.pricebooks;
  const pricebooks = await fetchPricebooks(env);
  pricebookListCache.set(env, { at: Date.now(), pricebooks });
  return pricebooks;
}

/**
 * The Product2 ids in one book, or `null` when there is no usable book to scope by.
 *
 * A failed membership read returns `null` rather than throwing: the catalog itself was read fine,
 * and `filterCatalogByPricebook` treats `null` as "no book selected" and falls back to the
 * unscoped list. Losing the narrowing costs a search; failing the whole request would take the
 * picker away over a filter the operator can live without.
 */
async function getPricebookMembers(env, pricebookId) {
  if (!pricebookId || !isSalesforceId(pricebookId)) return null;
  const key = `${env}:${pricebookId}`;
  const cached = pricebookMemberCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ids;
  try {
    const ids = await fetchPricebookProductIds(env, pricebookId);
    pricebookMemberCache.set(key, { at: Date.now(), ids });
    return ids;
  } catch {
    return null;
  }
}

catalogRouter.get('/pricebooks', async (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    res.json({ pricebooks: await getPricebooks(env) });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/products', async (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    const all = await getCatalog(env, { refresh: req.query.refresh === 'true' });

    // Family, then pricebook, then sellability — one order, defined in scopeCatalog. Each stage
    // reports its own verdict, because with three filters stacked the UI has to be able to say
    // which one emptied the table. `q` and `kind` then search inside the final scope.
    const family = req.query.family || null;
    const pricebookId = req.query.pricebookId || null;
    const includeNonSellable = req.query.includeNonSellable === 'true';
    const memberIds = await getPricebookMembers(env, pricebookId);

    const scoped = scopeCatalog(all, {
      family,
      filters: loadProfiles().catalogFilters ?? {},
      memberIds,
      includeNonSellable,
    });
    const products = scoped.products;

    const book = pricebookId
      ? (await getPricebooks(env)).find((p) => p.id === pricebookId) ?? null
      : null;

    const filtered = req.query.q
      ? searchCatalog(products, req.query.q, { kind: req.query.kind || null })
      : products.filter((p) => (req.query.kind ? p.kind === req.query.kind : true));

    res.json({
      total: scoped.total,
      // The size of the catalog before *any* narrowing, so "show all N" still means "drop every
      // filter" rather than "drop only the family rule".
      catalogTotal: scoped.catalogTotal,
      family,
      filterApplied: scoped.filterApplied,
      filterReason: scoped.filterReason,
      pricebook: {
        id: pricebookId,
        // The org's own name, verbatim — a literal value, never re-cased.
        name: book?.name ?? null,
        applied: scoped.pricebook.applied,
        reason: scoped.pricebook.reason,
      },
      sellability: scoped.sellability,
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

/**
 * The DLCM stage graph, with each operation placed on it.
 *
 * Environment-independent — the chart is a property of the device, not of a sandbox — but the
 * operations carry per-environment send readiness, so `env` is honoured when given.
 */
catalogRouter.get('/lifecycle', (req, res, next) => {
  try {
    const model = describeLifecycle(loadOperations());
    const all = loadTemplates();

    res.json({
      ...model,
      operations: model.operations.map((op) => {
        const templates = all.filter((t) => t.operation === op.id);
        return {
          ...op,
          // An operation can be fully modelled and still unsendable: four of them have a
          // mailbox but no sheet, which is the difference between "next" and "next, by hand".
          templateCount: templates.length,
          templates: templates.map((t) => ({ id: t.id, family: t.family, status: t.status })),
          hasTemplate: templates.length > 0,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
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
