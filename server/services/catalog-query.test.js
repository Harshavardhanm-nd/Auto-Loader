import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogSoql, CATALOG_FIELDS, notForSaleFrom } from './sf-client.js';

/**
 * The catalog query, built against the fields the org actually has.
 *
 * Two sandboxes are two metadata deployments, and a custom field present in one is not a promise
 * about the other: `L1_Product_Family__c` exists on `Product2` in testing and **does not exist in
 * staging** (verified 2026-08-15). SOQL is all-or-nothing on its SELECT list — one unknown column
 * fails the whole request with `INVALID_FIELD`, so naming that field unconditionally returned zero
 * products in staging rather than fewer, and the Families & SKUs picker rendered empty.
 *
 * So the field list is intersected with the org's own describe before the query is built. The
 * standard fields are always named: an org without `Name` or `ProductCode` on `Product2` is not a
 * Salesforce org, and pretending otherwise would hide a genuine outage.
 */

// Exactly the fields each org exposes on Product2, read from its describe on 2026-08-15.
const TESTING = CATALOG_FIELDS.map((f) => f.api);
const STAGING = TESTING.filter((f) => f !== 'L1_Product_Family__c');

const SERIES = ['D810', 'DHUB', 'DMS', 'VBUS', 'HAPTIC'];

describe('building the catalog query for an org that lacks a field', () => {
  test('an absent custom field is not named anywhere in the query', () => {
    const soql = buildCatalogSoql({ availableFields: STAGING, includeSeries: SERIES });
    assert.equal(
      soql.includes('L1_Product_Family__c'),
      false,
      'the field staging does not have must not reach the query planner'
    );
  });

  test('every other field survives the narrowing', () => {
    const soql = buildCatalogSoql({ availableFields: STAGING, includeSeries: SERIES });
    for (const field of STAGING) {
      assert.ok(soql.includes(field), `${field} exists in staging and should still be selected`);
    }
  });

  test('an org with every field gets every field', () => {
    const soql = buildCatalogSoql({ availableFields: TESTING, includeSeries: SERIES });
    for (const field of TESTING) assert.ok(soql.includes(field), `${field} should be selected`);
  });

  test('standard fields are named even if describe did not report them', () => {
    // A describe that came back thin is a reason to distrust the describe, not to stop asking for
    // ProductCode. If they are genuinely absent the query fails loudly, which is the correct
    // outcome — that is a broken org, not a configuration difference.
    const soql = buildCatalogSoql({ availableFields: [], includeSeries: SERIES });
    for (const field of CATALOG_FIELDS.filter((f) => f.required).map((f) => f.api)) {
      assert.ok(soql.includes(field), `${field} is required and must always be selected`);
    }
  });

  test('an unknown field set falls back to asking for everything', () => {
    // `null` means the describe could not be read at all. The full list is what this app asked for
    // before it consulted describe, so an unreadable describe costs nothing that already worked.
    const soql = buildCatalogSoql({ availableFields: null, includeSeries: SERIES });
    for (const field of TESTING) assert.ok(soql.includes(field), `${field} should be selected`);
  });
});

describe('the serialized gate degrades with the fields behind it', () => {
  test('both fields present gives the serialized filter and the series widening', () => {
    const soql = buildCatalogSoql({ availableFields: TESTING, includeSeries: SERIES });
    assert.ok(soql.includes("Product_Serialized__c = 'Yes'"));
    assert.ok(soql.includes("Product_Series__c IN ('D810','DHUB','DMS','VBUS','HAPTIC')"));
  });

  test('no declared series is no widening clause', () => {
    const soql = buildCatalogSoql({ availableFields: TESTING, includeSeries: [] });
    assert.ok(soql.includes("Product_Serialized__c = 'Yes'"));
    assert.equal(soql.includes('Product_Series__c IN'), false);
  });

  test('an org without the series field still applies the serialized filter', () => {
    const soql = buildCatalogSoql({
      availableFields: TESTING.filter((f) => f !== 'Product_Series__c'),
      includeSeries: SERIES,
    });
    assert.ok(soql.includes("Product_Serialized__c = 'Yes'"));
    assert.equal(soql.includes('Product_Series__c'), false);
  });

  test('an org without the serialized field falls back to every active product', () => {
    // Showing too much only costs the operator a search; showing nothing stops the run. Same
    // choice `filterCatalogByFamily` makes when a family rule matches nothing.
    const soql = buildCatalogSoql({
      availableFields: TESTING.filter((f) => f !== 'Product_Serialized__c'),
      includeSeries: [],
    });
    assert.ok(soql.includes('IsActive = true'));
    assert.equal(soql.includes('Product_Serialized__c'), false);
  });

  test('the active filter is never dropped', () => {
    for (const available of [TESTING, STAGING, [], null]) {
      assert.ok(
        buildCatalogSoql({ availableFields: available, includeSeries: SERIES }).includes('IsActive = true'),
        'a retired product is never loadable and must never be offered'
      );
    }
  });
});

describe('series values reaching the query', () => {
  test('a value carrying a quote or a backslash is dropped, not escaped', () => {
    // These come from config/profiles.json rather than a request, but a mistake in the config is
    // still a mistake, and shipping it to the query planner is worse than ignoring it.
    const soql = buildCatalogSoql({ availableFields: TESTING, includeSeries: ["D8'10", 'D8\\10', 'DHUB'] });
    assert.ok(soql.includes("Product_Series__c IN ('DHUB')"));
    assert.equal(soql.includes("D8'10"), false);
  });

  test('only unsafe values are dropped, not the whole clause', () => {
    const soql = buildCatalogSoql({ availableFields: TESTING, includeSeries: ['D810', 'DHUB'] });
    assert.ok(soql.includes("Product_Series__c IN ('D810','DHUB')"));
  });
});

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
    assert.ok(
      soql.includes("Product_Series__c IN ('D810','DHUB','DMS','VBUS','HAPTIC')"),
      'series widening survives'
    );
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
