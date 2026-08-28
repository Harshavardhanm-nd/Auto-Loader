# Pricebook Catalog Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the Families & SKUs picker by pricebook, and hide products flagged `Not_for_Sales__c` behind a toggle.

**Architecture:** Two cached Salesforce reads — the existing per-env `Product2` catalog (unchanged, now carrying a `notForSale` field) and a new id-only `PricebookEntry` membership query cached per `env:pricebookId`. All three narrowings (family → pricebook → sellability) are pure functions in `catalog-filter.js`, composed by one exported `scopeCatalog`. Toggling sellability issues no query at all.

**Tech Stack:** ESM Node 20 + Express, React 18 + Vite, `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-pricebook-catalog-scope-design.md`

## Global Constraints

- **`Not_for_Sales__c`** — plural *Sales*. Confirmed on `Product2` in **testing** only; presence in staging is **unverified**. It MUST be declared optional in `CATALOG_FIELDS` so `buildCatalogSoql`'s `has()` intersection omits it in an org that lacks it. Never `required`.
- **`notForSale` is tri-state:** `true`, `false`, or `null` meaning "the org did not report the flag". A `null` row is NEVER hidden.
- **No filter may return an empty list because a rule or query matched nothing.** Fall back to unscoped and report the reason. This is `filterCatalogByFamily`'s existing contract.
- **`IsActive = true` is never dropped** from any catalog query.
- **Pricebook names are literal org values.** `Standard Price Book` keeps its own case, never passed to a `Sheet` `eyebrow`. Eyebrow stays `Catalog`.
- **Default selection is "All price books"** — today's behaviour. Not a mandatory gate.
- **Only `IsActive = true` pricebooks are offered**, standard first.
- **Return-shape convention:** the pre-existing `filterCatalogByFamily` returns `filterApplied`; the two NEW filters return `applied`. Do not rename the existing one — the route and `CatalogScope` both read `filterApplied` today.
- Run tests with `node --test <file>`. Node prints tallies with `ℹ`, not TAP `#`.
- Pre-existing failures that are NOT yours: `config.test.js` (6) and `templates.test.js` (21). Total suite baseline is **292 tests, 265 pass, 27 fail**. Do not "fix" these.

---

### Task 1: `Not_for_Sales__c` reaches the catalog row as tri-state `notForSale`

**Files:**
- Modify: `server/services/sf-client.js:147-159` (`CATALOG_FIELDS`), `server/services/sf-client.js:244-275` (`fetchSerializedCatalog`)
- Test: `server/services/catalog-query.test.js` (extends existing 12 tests)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `notForSaleFrom(record) -> boolean|null`, exported from `sf-client.js`. Every row from `fetchSerializedCatalog` gains `notForSale: boolean|null`. `CATALOG_FIELDS` gains `{ api: 'Not_for_Sales__c' }`.

- [ ] **Step 1: Write the failing tests**

Append to `server/services/catalog-query.test.js`:

```javascript
describe('the Not-for-Sale flag is optional, like every other custom field', () => {
  test('it is named when the org reports it', () => {
    const soql = buildCatalogSoql({ availableFields: TESTING, includeSeries: SERIES });
    assert.ok(soql.includes('Not_for_Sales__c'), 'testing has the field, so it must be selected');
  });

  test('it is not named when the org does not report it', () => {
    // The whole point: SOQL is all-or-nothing on its SELECT list. Naming a field staging may not
    // have would fail the entire catalog query, which is the L1_Product_Family__c outage again.
    const without = TESTING.filter((f) => f !== 'Not_for_Sales__c');
    const soql = buildCatalogSoql({ availableFields: without, includeSeries: SERIES });
    assert.equal(soql.includes('Not_for_Sales__c'), false);
  });

  test('its absence leaves the serialized gate and the series widening intact', () => {
    const without = TESTING.filter((f) => f !== 'Not_for_Sales__c');
    const soql = buildCatalogSoql({ availableFields: without, includeSeries: SERIES });
    assert.ok(soql.includes("Product_Serialized__c = 'Yes'"), 'serialized gate survives');
    assert.ok(soql.includes("Product_Series__c IN ('D810','DHUB','DMS','VBUS','HAPTIC')"), 'series widening survives');
    assert.ok(soql.includes('IsActive = true'), 'the active filter is never dropped');
  });

  test('it is never used as a WHERE clause — filtering happens in memory', () => {
    // Sellability is filtered in `catalog-filter.js` so the toggle costs no query. If this ever
    // moves into SOQL, the cache key has to grow and the toggle becomes a round trip.
    const soql = buildCatalogSoql({ availableFields: TESTING, includeSeries: SERIES });
    assert.equal(/WHERE[\s\S]*Not_for_Sales__c/.test(soql), false);
  });
});

describe('reading the Not-for-Sale flag off a record', () => {
  test('true and false pass through', () => {
    assert.equal(notForSaleFrom({ Not_for_Sales__c: true }), true);
    assert.equal(notForSaleFrom({ Not_for_Sales__c: false }), false);
  });

  test('a record without the field reads as null, not false', () => {
    // The field was not in the SELECT because the org does not have it. "Unknown" must never be
    // reported as "sellable" — the same rule positionInChain follows for an unplaceable status.
    assert.equal(notForSaleFrom({}), null);
    assert.equal(notForSaleFrom({ Not_for_Sales__c: null }), null);
    assert.equal(notForSaleFrom(undefined), null);
  });
});
```

Add `notForSaleFrom` to the import at the top of the file:

```javascript
import { buildCatalogSoql, CATALOG_FIELDS, notForSaleFrom } from './sf-client.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/services/catalog-query.test.js`
Expected: FAIL. `notForSaleFrom` is not exported (`SyntaxError` or `not a function`), and the "it is named when the org reports it" test fails because `Not_for_Sales__c` is not in `CATALOG_FIELDS` so `TESTING` does not contain it.

- [ ] **Step 3: Add the field and the tri-state reader**

In `server/services/sf-client.js`, append to `CATALOG_FIELDS` (after `L1_Product_Family__c`, before the closing `]`):

```javascript
  // Commercial "do not sell" flag. Optional, like every other custom field here: confirmed on
  // Product2 in testing, unverified in staging, and SOQL is all-or-nothing on its SELECT list.
  { api: 'Not_for_Sales__c' },
```

Add this exported function immediately after `CATALOG_FIELDS`:

```javascript
/**
 * The org's "not for sale" flag, as a tri-state.
 *
 * `null` means the org did not report the field — not that the product is sellable. A checkbox
 * Salesforce did not return is unknown, and an unknown must never manufacture a conclusion; the
 * sellability filter hides nothing in that case rather than claiming everything is sellable.
 *
 * @returns {boolean|null}
 */
export function notForSaleFrom(record) {
  const value = record?.Not_for_Sales__c;
  return value === true || value === false ? value : null;
}
```

In `fetchSerializedCatalog`, inside the first `.map((p) => ({ … }))`, add after the `serialized:` line:

```javascript
    // Commercial flag, not a fulfilment one: VDI2L001 — the SKU on the real accepted VBUS sheet —
    // carries `true`, as do all ten refurbished `-R` D210 codes. Reported, never acted on here.
    notForSale: notForSaleFrom(p),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/services/catalog-query.test.js`
Expected: PASS, 18 tests (12 existing + 6 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/services/sf-client.js server/services/catalog-query.test.js
git commit -m "Carry the org's Not-for-Sale flag onto each catalog row as a tri-state"
```

---

### Task 2: the two pure filters and their composition

**Files:**
- Modify: `server/services/catalog-filter.js` (append after `declaredSeries`, line 85)
- Test: `server/services/catalog-filter.test.js` (extends existing 34 tests)

**Interfaces:**
- Consumes: rows carrying `id` and `notForSale` from Task 1.
- Produces, all exported from `catalog-filter.js`:
  - `filterCatalogByPricebook(products, memberIds) -> { products, total, applied, reason }`
  - `filterCatalogBySellability(products, { includeNonSellable }) -> { products, total, applied, reason, hidden, unknown }`
  - `scopeCatalog(products, { family, filters, memberIds, includeNonSellable }) -> { products, total, catalogTotal, filterApplied, filterReason, pricebook: { applied, reason }, sellability: { applied, hidden, unknown } }`

- [ ] **Step 1: Write the failing tests**

Append to `server/services/catalog-filter.test.js`:

```javascript
// ---------------------------------------------------------------------------
// Pricebook membership and sellability
// ---------------------------------------------------------------------------

/**
 * Rows shaped as `fetchSerializedCatalog` returns them, with the two fields these filters read.
 * `notForSale` values are the real ones from the testing org on 2026-08-27: VDI2L001 is flagged
 * `true` even though it is the SKU on the accepted VBUS initial-load sheet.
 */
const SCOPED = [
  { id: '01t01', productCode: 'DHUBX', productSeries: 'DHUB', family: 'Accessory', notForSale: false },
  { id: '01t02', productCode: 'VDI2L001', productSeries: 'VBUS', family: 'Accessory', notForSale: true },
  { id: '01t03', productCode: 'VDI3N001', productSeries: 'VBUS', family: 'Accessory', notForSale: false },
  { id: '01t04', productCode: 'ACCDR2DHUBXV2', productSeries: 'DHUB', family: 'Accessory', notForSale: true },
];

const scopedCodes = (r) => r.products.map((p) => p.productCode);

describe('narrowing the catalog to one pricebook', () => {
  test('only products in the book survive', () => {
    const r = filterCatalogByPricebook(SCOPED, new Set(['01t01', '01t03']));
    assert.deepEqual(scopedCodes(r), ['DHUBX', 'VDI3N001']);
    assert.equal(r.applied, true);
    assert.equal(r.reason, null);
  });

  test('no book selected leaves the catalog alone', () => {
    const r = filterCatalogByPricebook(SCOPED, null);
    assert.equal(r.products.length, 4);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'no-pricebook-selected');
  });

  test('an empty membership set falls back to everything rather than an empty table', () => {
    // A book with no matching entries and a failed membership query are indistinguishable here.
    // Showing too much costs a search; showing nothing stops the run.
    const r = filterCatalogByPricebook(SCOPED, new Set());
    assert.equal(r.products.length, 4);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'no-entries-in-pricebook');
  });

  test('a book that matches nothing in this catalog falls back too', () => {
    const r = filterCatalogByPricebook(SCOPED, new Set(['01tZZ']));
    assert.equal(r.products.length, 4);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'no-matches');
  });

  test('total reports the population before narrowing', () => {
    const r = filterCatalogByPricebook(SCOPED, new Set(['01t01']));
    assert.equal(r.total, 4);
    assert.equal(r.products.length, 1);
  });
});

describe('hiding products the org flags as not for sale', () => {
  test('flagged products are dropped and counted', () => {
    const r = filterCatalogBySellability(SCOPED, { includeNonSellable: false });
    assert.deepEqual(scopedCodes(r), ['DHUBX', 'VDI3N001']);
    assert.equal(r.hidden, 2);
    assert.equal(r.applied, true);
    assert.equal(r.unknown, false);
  });

  test('the toggle keeps everything and reports that nothing was applied', () => {
    const r = filterCatalogBySellability(SCOPED, { includeNonSellable: true });
    assert.equal(r.products.length, 4);
    assert.equal(r.hidden, 0);
    assert.equal(r.applied, false);
  });

  test('an unknown flag is never hidden, and is reported as unknown', () => {
    // This is the staging guard. If Not_for_Sales__c is missing from that org's describe, every
    // row reads null — and hiding them all would empty the picker for a field we could not read.
    const unknown = SCOPED.map((p) => ({ ...p, notForSale: null }));
    const r = filterCatalogBySellability(unknown, { includeNonSellable: false });
    assert.equal(r.products.length, 4, 'nothing is hidden on an unreadable flag');
    assert.equal(r.hidden, 0);
    assert.equal(r.unknown, true);
    assert.equal(r.applied, false, 'a filter that hid nothing did not apply');
  });

  test('a mix of known and unknown hides only the known true', () => {
    const mixed = [
      { id: 'a', productCode: 'A', notForSale: true },
      { id: 'b', productCode: 'B', notForSale: null },
      { id: 'c', productCode: 'C', notForSale: false },
    ];
    const r = filterCatalogBySellability(mixed, { includeNonSellable: false });
    assert.deepEqual(scopedCodes(r), ['B', 'C']);
    assert.equal(r.hidden, 1);
    assert.equal(r.unknown, true);
  });
});

describe('composing the three narrowings', () => {
  const FILTERS_SCOPED = { vbus: { series: ['VBUS'] }, dhub: { series: ['DHUB'] } };

  test('family narrows first, then the book, then sellability', () => {
    const r = scopeCatalog(SCOPED, {
      family: 'vbus',
      filters: FILTERS_SCOPED,
      memberIds: new Set(['01t02', '01t03']),
      includeNonSellable: false,
    });
    assert.deepEqual(scopedCodes(r), ['VDI3N001'], 'VBUS, in the book, and sellable');
    assert.equal(r.catalogTotal, 4, 'the population before any narrowing');
    assert.equal(r.total, 1);
    assert.equal(r.filterApplied, true);
    assert.equal(r.pricebook.applied, true);
    assert.equal(r.sellability.hidden, 1, 'VDI2L001, hidden within this family and book');
  });

  test('each stage keeps its own reason rather than one flag for all three', () => {
    const r = scopeCatalog(SCOPED, {
      family: 'octo',
      filters: FILTERS_SCOPED,
      memberIds: null,
      includeNonSellable: false,
    });
    assert.equal(r.filterApplied, false);
    assert.equal(r.filterReason, 'no-filter-declared', 'no rule for octo in this fixture');
    assert.equal(r.pricebook.reason, 'no-pricebook-selected');
    assert.equal(r.sellability.applied, true, 'sellability still ran over the unscoped catalog');
  });

  test('sellability counts are relative to the family and book, not the whole org', () => {
    const r = scopeCatalog(SCOPED, {
      family: 'dhub',
      filters: FILTERS_SCOPED,
      memberIds: null,
      includeNonSellable: false,
    });
    assert.deepEqual(scopedCodes(r), ['DHUBX']);
    assert.equal(r.sellability.hidden, 1, 'only ACCDR2DHUBXV2 — VDI2L001 is not in this family');
  });

  test('an empty catalog composes without throwing', () => {
    const r = scopeCatalog([], { family: 'vbus', filters: FILTERS_SCOPED, memberIds: null, includeNonSellable: false });
    assert.deepEqual(r.products, []);
    assert.equal(r.catalogTotal, 0);
  });
});
```

Update the import at the top of `catalog-filter.test.js`:

```javascript
import {
  filterCatalogByFamily,
  declaredSeries,
  filterCatalogByPricebook,
  filterCatalogBySellability,
  scopeCatalog,
} from './catalog-filter.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/services/catalog-filter.test.js`
Expected: FAIL with `filterCatalogByPricebook is not a function` (or a `SyntaxError` on the import, depending on Node's resolution order).

- [ ] **Step 3: Implement the three functions**

Append to `server/services/catalog-filter.js`:

```javascript
/**
 * Narrow the catalog to the products in one pricebook.
 *
 * A pricebook is not a pure narrowing of this catalog: Standard Price Book holds 210 active
 * serialized entries against the picker's ~170, including series no family rule covers (AT700,
 * KFOB, SPEAKER, nine EXCAM variants). Applying it *after* the family rule is what keeps that
 * from widening the picker — the family rule remains the primary filter.
 *
 * `memberIds` of `null` means no book is selected. An empty set, or one intersecting nothing, falls
 * back to the whole catalog for the same reason `filterCatalogByFamily` does: a stale book and a
 * genuinely empty one are indistinguishable from here, and an empty table stops the operator where
 * too many rows only cost a search.
 *
 * @param {Array<object>} products
 * @param {Set<string>|null} memberIds  Product2 ids in the selected book
 * @returns {{products: Array<object>, total: number, applied: boolean, reason: string|null}}
 */
export function filterCatalogByPricebook(products, memberIds) {
  const all = Array.isArray(products) ? products : [];
  const unfiltered = (reason) => ({ products: all, total: all.length, applied: false, reason });

  if (!memberIds) return unfiltered('no-pricebook-selected');
  if (!memberIds.size) return unfiltered('no-entries-in-pricebook');

  const matched = all.filter((p) => memberIds.has(p.id));
  if (!matched.length) return unfiltered('no-matches');

  return { products: matched, total: all.length, applied: true, reason: null };
}

/**
 * Drop products the org flags as not for sale.
 *
 * `Not_for_Sales__c` is a *commercial* flag — do not quote or sell this item. It is not a
 * fulfilment flag, and this app does not sell anything: `VDI2L001`, the SKU on the real accepted
 * VBUS initial-load sheet, carries `true`, as do the DHUB V2 hub and all ten refurbished `-R` D210
 * codes. So this filter is an aid, never a gate — the picker offers a toggle to show them.
 *
 * A `notForSale` of `null` means the org did not report the field, and is never hidden. Hiding an
 * unknown would empty the picker in an org missing the field, which is exactly how the
 * `L1_Product_Family__c` outage presented.
 *
 * @param {Array<object>} products
 * @param {{includeNonSellable?: boolean}} opts
 * @returns {{products, total, applied, reason, hidden: number, unknown: boolean}}
 */
export function filterCatalogBySellability(products, { includeNonSellable = false } = {}) {
  const all = Array.isArray(products) ? products : [];
  const unknown = all.some((p) => p.notForSale === null || p.notForSale === undefined);

  if (includeNonSellable) {
    return { products: all, total: all.length, applied: false, reason: 'showing-non-sellable', hidden: 0, unknown };
  }

  const kept = all.filter((p) => p.notForSale !== true);
  const hidden = all.length - kept.length;

  return {
    products: kept,
    total: all.length,
    // A filter that hid nothing did not apply. This keeps the UI from announcing "0 hidden",
    // which would falsely claim the flag was read and every product is sellable.
    applied: hidden > 0,
    reason: hidden > 0 ? null : unknown ? 'flag-unreadable' : 'nothing-flagged',
    hidden,
    unknown,
  };
}

/**
 * The picker's whole narrowing, in one place and in one order: family, then pricebook, then
 * sellability.
 *
 * The order is the design. Family rules stay the primary filter, so the pricebook restricts within
 * a family rather than replacing it — and each stage's counts are therefore relative to what the
 * stage before it passed through. `sellability.hidden` is "hidden within this family and book",
 * which is what makes the UI note true of the table on screen.
 *
 * `catalogTotal` keeps its established meaning: the population before *any* narrowing, so the
 * picker's "Show all N" still means "drop every filter".
 */
export function scopeCatalog(products, { family = null, filters = {}, memberIds = null, includeNonSellable = false } = {}) {
  const all = Array.isArray(products) ? products : [];

  const byFamily = filterCatalogByFamily(all, family, filters);
  const byBook = filterCatalogByPricebook(byFamily.products, memberIds);
  const bySale = filterCatalogBySellability(byBook.products, { includeNonSellable });

  return {
    products: bySale.products,
    total: bySale.products.length,
    catalogTotal: all.length,
    // Named as the route and CatalogScope already read them, so the family path is unchanged.
    filterApplied: byFamily.filterApplied,
    filterReason: byFamily.reason,
    pricebook: { applied: byBook.applied, reason: byBook.reason },
    sellability: { applied: bySale.applied, reason: bySale.reason, hidden: bySale.hidden, unknown: bySale.unknown },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/services/catalog-filter.test.js`
Expected: PASS, 47 tests (34 existing + 13 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/services/catalog-filter.js server/services/catalog-filter.test.js
git commit -m "Add pricebook and sellability narrowing, composed in one order"
```

---

### Task 3: the two Salesforce reads

**Files:**
- Modify: `server/services/sf-client.js` (append after `fetchSerializedCatalog`, ~line 275)
- Create: `server/services/pricebook-query.test.js`

**Interfaces:**
- Consumes: `query(env, soql)` from `sf-client.js` (already exported, paginates via `nextRecordsUrl`).
- Produces, exported from `sf-client.js`:
  - `isSalesforceId(value) -> boolean`
  - `buildPricebookEntrySoql(pricebookId) -> string` (throws on an invalid id)
  - `fetchPricebooks(env) -> Promise<Array<{id, name, isStandard}>>`
  - `fetchPricebookProductIds(env, pricebookId) -> Promise<Set<string>>`

- [ ] **Step 1: Write the failing tests**

Create `server/services/pricebook-query.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPricebookEntrySoql, isSalesforceId } from './sf-client.js';

/**
 * The pricebook membership query.
 *
 * `pricebookId` is the only value in this app that reaches SOQL straight from an HTTP query string,
 * so it is validated as a Salesforce id rather than escaped — the same choice `safeSeries` makes for
 * config-supplied series names. A value that could terminate the string literal is refused.
 *
 * Real ids from the testing org, 2026-08-27: Standard Price Book is `01s36000005K1LMAA0` (18 chars),
 * Netradyne CPQ is `01s1Q000007FOQ3QAO`.
 */

const STANDARD = '01s36000005K1LMAA0';

describe('validating a Salesforce id', () => {
  test('15 and 18 character ids are accepted', () => {
    assert.equal(isSalesforceId('01s36000005K1LM'), true);
    assert.equal(isSalesforceId(STANDARD), true);
  });

  test('anything that could break out of a SOQL literal is refused', () => {
    for (const bad of ["01s3'", "x' OR Id != '", '01s3\\', '01s3 OR', '', null, undefined, 42, {}]) {
      assert.equal(isSalesforceId(bad), false, `refused: ${JSON.stringify(bad)}`);
    }
  });

  test('a plausible but wrong length is refused', () => {
    assert.equal(isSalesforceId('01s360'), false);
    assert.equal(isSalesforceId('01s36000005K1LMAA0XXX'), false);
  });
});

describe('building the membership query', () => {
  test('it asks only for Product2Id', () => {
    const soql = buildPricebookEntrySoql(STANDARD);
    // Id-only keeps the URL far inside QUERY_URL_LIMIT even for a book with thousands of entries.
    assert.match(soql, /^SELECT Product2Id\b/);
    assert.equal(soql.includes('Product2.'), false, 'no relationship fields — this is a membership probe');
  });

  test('it scopes to the book and to active entries', () => {
    const soql = buildPricebookEntrySoql(STANDARD);
    assert.ok(soql.includes('FROM PricebookEntry'));
    assert.ok(soql.includes(`Pricebook2Id = '${STANDARD}'`));
    assert.ok(soql.includes('IsActive = true'));
  });

  test('an invalid id throws rather than reaching the org', () => {
    assert.throws(() => buildPricebookEntrySoql("x' OR Id != '"), /not a Salesforce id/);
    assert.throws(() => buildPricebookEntrySoql(null), /not a Salesforce id/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/services/pricebook-query.test.js`
Expected: FAIL — `buildPricebookEntrySoql is not a function`.

- [ ] **Step 3: Implement the id guard, the SOQL builder, and the two reads**

Append to `server/services/sf-client.js`:

```javascript
// ---------------------------------------------------------------------------
// Pricebooks
// ---------------------------------------------------------------------------

/**
 * A Salesforce id: 15 or 18 alphanumeric characters, nothing else.
 *
 * `pricebookId` arrives from an HTTP query string and is interpolated into SOQL, so it is validated
 * rather than escaped — the same call `safeSeries` makes for config-supplied series names. A value
 * carrying a quote or a backslash is refused outright.
 */
export function isSalesforceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(value);
}

/**
 * Which products are in one pricebook.
 *
 * `Product2Id` only, deliberately: this is a membership probe, and the product fields are already
 * in the per-env catalog. An id-only projection keeps the URL far inside `QUERY_URL_LIMIT` even for
 * a book with thousands of entries, and `query()` pages through the rest.
 */
export function buildPricebookEntrySoql(pricebookId) {
  if (!isSalesforceId(pricebookId)) {
    throw new Error(`Pricebook "${pricebookId}" is not a Salesforce id (15 or 18 alphanumerics).`);
  }
  return (
    `SELECT Product2Id\n` +
    `  FROM PricebookEntry\n` +
    ` WHERE Pricebook2Id = '${pricebookId}'\n` +
    `   AND IsActive = true`
  );
}

/**
 * The pricebooks worth offering: active only, standard first.
 *
 * Testing holds 24 books, 6 of them inactive (`netradyne`, `Trial`, `Safety Price Book`,
 * `Security Price Book`, `Partner Price Book - TruckSpy`, `Non-Bundled Items`). An inactive book
 * cannot be sold from, so offering it would only invite a pointless narrowing.
 */
export async function fetchPricebooks(env) {
  const records = await query(
    env,
    `SELECT Id, Name, IsStandard\n  FROM Pricebook2\n WHERE IsActive = true\n ORDER BY IsStandard DESC, Name`
  );
  return records.map((p) => ({ id: p.Id, name: p.Name, isStandard: p.IsStandard === true }));
}

/** The Product2 ids in one pricebook, as a Set for the in-memory intersection. */
export async function fetchPricebookProductIds(env, pricebookId) {
  const records = await query(env, buildPricebookEntrySoql(pricebookId));
  return new Set(records.map((r) => r.Product2Id).filter(Boolean));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/services/pricebook-query.test.js`
Expected: PASS, 6 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/services/sf-client.js server/services/pricebook-query.test.js
git commit -m "Read the org's pricebooks and one book's product membership"
```

---

### Task 4: route wiring and the two new caches

**Files:**
- Modify: `server/routes/catalog.js:1-72` (imports, caches, `/products`), and add `/pricebooks`

**Interfaces:**
- Consumes: `scopeCatalog` (Task 2); `fetchPricebooks`, `fetchPricebookProductIds`, `isSalesforceId` (Task 3).
- Produces: `GET /api/catalog/pricebooks?env=` → `{ pricebooks: [{id, name, isStandard}] }`. `GET /api/catalog/products` additionally accepts `pricebookId` and `includeNonSellable`, and its response gains `pricebook` and `sellability` objects.

- [ ] **Step 1: Extend the imports**

In `server/routes/catalog.js`, add to the `sf-client.js` import block:

```javascript
  fetchPricebooks,
  fetchPricebookProductIds,
  isSalesforceId,
```

and replace the `catalog-filter.js` import:

```javascript
import { declaredSeries, scopeCatalog } from '../services/catalog-filter.js';
```

**`filterCatalogByFamily` is dropped from this import.** Verified 2026-08-27: its only call site in this file is line 49, inside `/products`, and `scopeCatalog` now calls it internally. `/families` does not use it. Leaving it imported would be dead code.

- [ ] **Step 2: Add the two caches**

After the existing `catalogCache` block (line 25-26), add:

```javascript
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
```

- [ ] **Step 3: Add the `/pricebooks` route**

Insert immediately before `catalogRouter.get('/products', …)`:

```javascript
catalogRouter.get('/pricebooks', async (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    res.json({ pricebooks: await getPricebooks(env) });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Rewrite the `/products` handler body**

Replace the body of `catalogRouter.get('/products', …)` (lines 39-72) with:

```javascript
catalogRouter.get('/products', async (req, res, next) => {
  try {
    const env = req.query.env || 'testing';
    const all = await getCatalog(env, { refresh: req.query.refresh === 'true' });

    // Family, then pricebook, then sellability — one order, defined in scopeCatalog. Each stage
    // reports its own verdict, because with three filters stacked the UI has to be able to say
    // which one emptied the table.
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
      // The size of the catalog before any narrowing, so the UI can offer "show all N".
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
```

- [ ] **Step 5: Verify the server boots and the whole suite is unchanged**

Run: `node --check server/routes/catalog.js && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `node --check` silent. Suite shows **317 tests, 290 pass, 27 fail** — the 27 are the pre-existing `config.test.js` (6) and `templates.test.js` (21). No new failures. (Task 4 adds no tests; the 25 new ones all landed in Tasks 1-3.)

- [ ] **Step 6: Commit**

```bash
git add server/routes/catalog.js
git commit -m "Serve the pricebook list, and scope /products by book and sellability"
```

---

### Task 5: the pricebook selector in the picker

**Files:**
- Modify: `web/src/api.js:67-70` (add `pricebooks`)
- Modify: `web/src/pages/PickerPage.jsx:17-31` (state), `:66-88` (catalog effect), and the render around `:224` (new `Sheet`)

**Interfaces:**
- Consumes: `GET /api/catalog/pricebooks`, and the `pricebookId` / `includeNonSellable` params on `GET /api/catalog/products` (Task 4).
- Produces: `pricebookId` and `includeNonSellable` state in `PickerPage`, passed to `CatalogScope` in Task 6.

- [ ] **Step 1: Add the API method**

In `web/src/api.js`, after the `products:` line:

```javascript
  pricebooks: (env) => get(`/api/catalog/pricebooks?${q({ env })}`),
```

- [ ] **Step 2: Add state and load the books**

In `PickerPage.jsx`, after the `catalogLoading` state declaration:

```javascript
  // The org's active pricebooks, and the one selected. `null` means "All price books" — today's
  // behaviour, and the default deliberately: Standard Price Book's serialized population differs
  // from this catalog's, so defaulting to it would silently change what is on offer.
  const [pricebooks, setPricebooks] = React.useState([]);
  const [pricebookId, setPricebookId] = React.useState(null);
  // Non-sellable SKUs are hidden by default. VDI2L001 — the SKU on the accepted VBUS sheet — is
  // flagged non-sellable, so this toggle is what keeps that load reachable.
  const [includeNonSellable, setIncludeNonSellable] = React.useState(false);
```

Then add this effect immediately after (a failed read leaves the selector empty and is not shouted about — the picker works fine without it):

```javascript
  React.useEffect(() => {
    let cancelled = false;
    api
      .pricebooks(env)
      .then((r) => {
        if (!cancelled) setPricebooks(r.pricebooks ?? []);
      })
      .catch(() => {
        // Deliberately quiet. The pricebook filter is an aid; losing it must not raise a banner
        // over a picker that still works, and the catalog's own error path already reports a
        // dead session.
        if (!cancelled) setPricebooks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [env]);
```

- [ ] **Step 3: Pass the two new params to the catalog read**

Replace the `.products(...)` call in the catalog effect (line 71):

```javascript
      .products(
        env,
        showAll
          ? { includeNonSellable: String(includeNonSellable) }
          : {
              family: activeFamily,
              ...(pricebookId ? { pricebookId } : {}),
              includeNonSellable: String(includeNonSellable),
            }
      )
```

and extend that effect's dependency array (line 88):

```javascript
  }, [env, activeFamily, showAll, catalogReload, pricebookId, includeNonSellable]);
```

- [ ] **Step 4: Render the selector above the Family sheet**

Insert immediately before `<Sheet title="Family">`:

```jsx
      {pricebooks.length > 0 ? (
        <Sheet eyebrow="Catalog" title="Price book">
          <Field
            label="Price book"
            hint="Narrows the SKUs on offer to the products in one book. Leave on all books to search the whole catalog."
          >
            <select
              value={pricebookId ?? ''}
              onChange={(e) => setPricebookId(e.target.value || null)}
            >
              <option value="">All price books</option>
              {pricebooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </Sheet>
      ) : null}
```

`Field` is **not** currently imported in `PickerPage.jsx`. Change line 3 to add it:

```javascript
import { Badge, Callout, Explainer, Field, KeyValue, PageHead, Segmented, Sheet, Stat } from '../components/ui.jsx';
```

Note: `select` is already styled in `web/src/styles.css:632,649,654,661` alongside the text inputs, and `label.field` at `:594` is what `Field` renders — so no CSS is needed. Pricebook names render verbatim; do not uppercase them.

- [ ] **Step 5: Verify by hand**

Run: `npm run dev`, open the Families & SKUs step.
Expected: a `Price book` panel above `Family`, defaulting to `All price books` and listing 18 books with `Standard Price Book` first. Choosing a book re-reads the catalog and the table shrinks. The build must be clean: `npm run build` exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.js web/src/pages/PickerPage.jsx
git commit -m "Offer the org's pricebooks as a catalog filter in the picker"
```

---

### Task 6: report both new narrowings in `CatalogScope`

**Files:**
- Modify: `web/src/pages/PickerPage.jsx:526-563` (`CatalogScope`) and its call site at `:351-356`

**Interfaces:**
- Consumes: `pricebook` and `sellability` on the `/products` response (Task 4); `includeNonSellable` state (Task 5).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Pass the new props at the call site**

Replace the `<CatalogScope … />` call:

```jsx
              <CatalogScope
                catalog={catalog}
                familyLabel={activeTemplate.familyLabel ?? activeFamily}
                showAll={showAll}
                onToggle={() => setShowAll((v) => !v)}
                includeNonSellable={includeNonSellable}
                onToggleSellable={() => setIncludeNonSellable((v) => !v)}
              />
```

- [ ] **Step 2: Extend `CatalogScope`**

Change its signature and append two lines after the existing `btn-row` div. The whole component becomes:

```jsx
function CatalogScope({ catalog, familyLabel, showAll, onToggle, includeNonSellable, onToggleSellable }) {
  const { total, catalogTotal, filterApplied, filterReason, pricebook, sellability } = catalog;
  const narrowed = filterApplied && !showAll;

  return (
    <>
      <div className="btn-row" style={{ marginBottom: '0.7rem', alignItems: 'baseline' }}>
        <span className="muted small">
          {narrowed ? (
            <>
              Showing the <strong>{familyLabel}</strong> devices — {total} of {catalogTotal} products.
            </>
          ) : showAll ? (
            <>Showing all {total} serialized products.</>
          ) : filterReason === 'no-filter-declared' ? (
            <>
              No catalog rule for <strong>{familyLabel}</strong>, so all {total} products are listed.
              Add one under <code>catalogFilters</code> in <code>config/profiles.json</code>.
            </>
          ) : filterReason === 'no-matches' ? (
            // Deliberately not "the rule is stale". It might be — or the org may simply hold no such
            // product, which is Haptic's case: HAPTIC is a real active series with nothing in it.
            // Both look identical from here, so claim only what is certain.
            <>
              No serialized product in this org belongs to <strong>{familyLabel}</strong>. Showing all{' '}
              {total} products rather than an empty table.
            </>
          ) : (
            <>Showing all {total} serialized products.</>
          )}
        </span>
        {filterApplied || showAll ? (
          <button className="btn quiet small" onClick={onToggle}>
            {showAll ? `Back to ${familyLabel} only` : `Show all ${catalogTotal}`}
          </button>
        ) : null}
      </div>

      {/* The pricebook's own verdict. A book that narrowed nothing says so rather than staying
          silent, because a filter the operator set and cannot see the effect of reads as broken. */}
      {pricebook?.id ? (
        <div className="muted small" style={{ marginBottom: '0.7rem' }}>
          {pricebook.applied ? (
            <>
              In <strong>{pricebook.name}</strong>.
            </>
          ) : pricebook.reason === 'no-matches' ? (
            <>
              No product here is in <strong>{pricebook.name}</strong>. Showing the unscoped list
              rather than an empty table.
            </>
          ) : pricebook.reason === 'no-entries-in-pricebook' ? (
            <>
              <strong>{pricebook.name}</strong> has no active entries, or could not be read. Showing
              the unscoped list.
            </>
          ) : null}
        </div>
      ) : null}

      {/* Sellability. `unknown` is not "0 hidden": the flag could not be read at all, and saying
          "0 hidden" would claim every product is sellable on evidence we do not have. */}
      <div className="btn-row" style={{ marginBottom: '0.7rem', alignItems: 'baseline' }}>
        <span className="muted small">
          {sellability?.unknown && !sellability?.applied ? (
            <>
              This org does not report <code>Not_for_Sales__c</code>, so nothing is hidden on it.
            </>
          ) : includeNonSellable ? (
            <>Including products flagged Not for Sale.</>
          ) : sellability?.hidden > 0 ? (
            <>
              {sellability.hidden} hidden as Not for Sale.
            </>
          ) : null}
        </span>
        {sellability?.hidden > 0 || includeNonSellable ? (
          <button className="btn quiet small" onClick={onToggleSellable}>
            {includeNonSellable ? 'Hide Not for Sale' : 'Show non-sellable'}
          </button>
        ) : null}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Verify by hand**

Run: `npm run dev`, open Families & SKUs, pick **VBUS**.
Expected: `1 hidden as Not for Sale` with a `Show non-sellable` button; clicking it reveals `VDI2L001` and the label flips to `Hide Not for Sale`. Clicking it back must issue **no** network request for the catalog — the row already carries `notForSale`, so confirm in the browser Network tab that only the expected re-read happens (the effect re-runs, but the response is served from the 10-minute cache).

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/PickerPage.jsx
git commit -m "Say which filter narrowed the catalog, and offer the non-sellable escape hatch"
```

---

### Task 7: documentation and final verification

**Files:**
- Modify: `CLAUDE.md` (the `config/profiles.json` catalog section, and the design-rules section on `Segmented`)
- Modify: `docs/superpowers/specs/2026-08-27-pricebook-catalog-scope-design.md` (record the staging result)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Re-check the staging describe**

Run, with a live staging session connected via the Connect page:

```bash
node --input-type=module -e '
import { fieldsOn } from "./server/services/sf-client.js";
const f = await fieldsOn("staging", "Product2");
console.log(f === null ? "describe unreadable" : f.includes("Not_for_Sales__c") ? "PRESENT" : "ABSENT");'
```

Record the answer in the spec's "The staging gap" section, replacing the pre-release action with the result and the date. If it is **ABSENT**, no code changes are needed — that is the case Task 1 and Task 2 already handle — but the spec must say so, and the UI note added in Task 6 is what the operator will see.

- [ ] **Step 2: Document the catalog scoping in `CLAUDE.md`**

In the `### The constant columns live in \`config/profiles.json\`` section, after the `catalogFilters` bullet, add:

```markdown
- **`Not_for_Sales__c` and pricebooks scope the picker, and neither is a gate.** The catalog is
  narrowed **family → pricebook → sellability** by `scopeCatalog` (`services/catalog-filter.js`);
  each stage reports its own verdict because with three filters stacked the UI has to say which one
  emptied the table. Two rules matter more than the feature:
  **`Not_for_Sales__c` is commercial, not fulfilment.** It is `true` on `VDI2L001` — the SKU on the
  real accepted VBUS initial-load sheet — and on the DHUB V2 hub and all ten refurbished `-R` D210
  codes. Hiding it by default is a convenience; the `Show non-sellable` toggle is what keeps those
  loads reachable, and removing the toggle makes the VBUS initial load unpickable.
  **`notForSale` is tri-state.** `null` means the org did not report the field, and is never
  hidden — an unknown must not manufacture a conclusion, the same rule `positionInChain` follows.
  The field is optional in `CATALOG_FIELDS`, so an org lacking it simply does not name it; had it
  been `required`, a staging deployment without it would fail the whole catalog query, which is
  exactly the `L1_Product_Family__c` outage.
  A pricebook is **not** a pure narrowing: Standard Price Book holds 210 active serialized entries
  against this catalog's ~170, including `AT700`, `KFOB`, `SPEAKER` and nine `EXCAM-*` series no
  family rule covers. Applying it *after* the family rule is what stops it widening the picker.
  The book is a view filter only — it never reaches a run, a CSV, or a send.
```

- [ ] **Step 3: Record the `Segmented` boundary**

In the design-rules section, after the sentence naming `Segmented` as "every *pick one of these*", add:

```markdown
`Segmented` is for small mutually-exclusive sets **this app defines** — families, operations, view
tabs. A long list the **org** supplies gets a native `<select>`: the picker's price book is 18
entries with names like `Partner Price Book - Teletrac North America`, which a row of buttons cannot
carry. `select` is already styled in `styles.css` alongside the text inputs, and belongs inside a
`Field`. The org's own value renders verbatim — `Standard Price Book` keeps its case and never
becomes a `Sheet` eyebrow.
```

- [ ] **Step 4: Full verification**

Run each and confirm:

```bash
node --test server/services/catalog-query.test.js    # expect 18 tests, 18 pass
node --test server/services/catalog-filter.test.js   # expect 47 tests, 47 pass
node --test server/services/pricebook-query.test.js  # expect 6 tests, 6 pass
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'
npm run build
```

Expected: suite **317 tests, 290 pass, 27 fail**, `skipped 0`. The 27 failures must be exactly `config.test.js` (6) and `templates.test.js` (21) — confirm with a per-file loop if the number differs. `npm run build` exits 0.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-27-pricebook-catalog-scope-design.md
git commit -m "Document pricebook scoping, the tri-state sellability flag, and the select boundary"
```

---

## Self-review record

**Spec coverage.** Every spec section maps to a task: `Not_for_Sales__c` field + tri-state → Task 1; the two pure filters and composition order → Task 2; `fetchPricebooks` / `fetchPricebookProductIds` / id validation → Task 3; route, response shape, two caches, both degradation rules → Task 4; selector, default "All price books", `<select>` decision → Task 5; `CatalogScope` notes, the two wording rules → Task 6; the staging re-check and the docs → Task 7.

**Type consistency.** `notForSale` (row field) and `notForSaleFrom` (reader) are used identically in Tasks 1, 2 and 6. `applied` is used for the two new filters throughout; `filterApplied` is preserved only for the pre-existing family filter, and Task 2's `scopeCatalog` is the single place the two conventions meet. `memberIds` is a `Set|null` everywhere.

**Known gap, deliberately not a task.** Whether `VDI2L001`, `ACCDR2DHUBXV2` and `ACCVR4NVHDATARDR` should have their `Not_for_Sales__c` flag cleared in Salesforce is an org data decision for the maintainer, not a code change. The toggle keeps them reachable either way.
