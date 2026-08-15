import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { filterCatalogByFamily, declaredSeries } from './catalog-filter.js';

/**
 * The picker's family filter, against catalog rows shaped like `fetchSerializedCatalog` returns.
 *
 * Filtering is on `Product_Series__c` — the org's "L3 Product Series" — because it is the only
 * field that names a product line exactly. `Device_Type__c` calls every Driveri model *and* Octo
 * `Driveri`, so it cannot separate the two.
 */

// Real values and real counts, taken from the testing org on 2026-08-15.
const CATALOG = [
  { productCode: 'B2E231USASS00C0S', productSeries: 'D210', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'K2I132USASI10Y4S', productSeries: 'D215', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'B3E110005AAA', productSeries: 'D450', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'DE811301USA01001', productSeries: 'D810', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'DE811311USA01001', productSeries: 'D810', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'DHUBX', productSeries: 'DHUB', l1Family: 'Accessory', deviceType: 'DHUB' },
  { productCode: 'ACCCM1DMSCAM', productSeries: 'DMS', l1Family: 'Accessory', deviceType: 'DMS_CAMERA' },
  { productCode: 'VDI2L001', productSeries: 'VBUS', l1Family: 'Accessory', deviceType: 'VBUS' },
  { productCode: 'ACCEC1EMPCAM', productSeries: 'EXCAM', l1Family: 'Accessory', deviceType: 'EXCAM' },
  // Nine products in the org carry no series at all.
  { productCode: 'EXTINDCAMCONV', productSeries: null, l1Family: 'Accessory', deviceType: null },
];

const FILTERS = {
  // Driveri is every device *except* Octo, so a new D-series model appears without a config edit.
  driveri: { l1Family: ['Device'], excludeSeries: ['D810'] },
  octo: { series: ['D810'] },
  dhub: { series: ['DHUB'] },
  dms: { series: ['DMS'] },
  vbus: { series: ['VBUS'] },
  haptic: { series: ['HAPTIC'] },
};

const codes = (r) => r.products.map((p) => p.productCode);

describe('filtering the catalog to a family by L3 product series', () => {
  test('a single-series family gets exactly its own series', () => {
    for (const [family, expected] of [
      ['dhub', ['DHUBX']],
      ['dms', ['ACCCM1DMSCAM']],
      ['vbus', ['VDI2L001']],
      ['octo', ['DE811301USA01001', 'DE811311USA01001']],
    ]) {
      const r = filterCatalogByFamily(CATALOG, family, FILTERS);
      assert.deepEqual(codes(r), expected, family);
      assert.equal(r.filterApplied, true, `${family} should report a filter`);
    }
  });

  test('Driveri is every device except the Octo series', () => {
    const r = filterCatalogByFamily(CATALOG, 'driveri', FILTERS);
    assert.deepEqual(codes(r), ['B2E231USASS00C0S', 'K2I132USASI10Y4S', 'B3E110005AAA']);
  });

  test('a new Driveri series needs no config change', () => {
    // The reason Driveri is "devices minus D810" rather than a list of its series: D210, D450 and
    // the rest gain models regularly, and a list would silently omit each new one.
    const withNewModel = [
      ...CATALOG,
      { productCode: 'NEWMODEL001', productSeries: 'D480', l1Family: 'Device', deviceType: 'Driveri' },
    ];
    assert.ok(codes(filterCatalogByFamily(withNewModel, 'driveri', FILTERS)).includes('NEWMODEL001'));
  });

  test('Driveri and Octo never overlap, and together cover every device', () => {
    const driveri = codes(filterCatalogByFamily(CATALOG, 'driveri', FILTERS));
    const octo = codes(filterCatalogByFamily(CATALOG, 'octo', FILTERS));

    assert.equal(driveri.some((c) => octo.includes(c)), false, 'no SKU may appear under both');
    assert.equal(
      driveri.length + octo.length,
      CATALOG.filter((p) => p.l1Family === 'Device').length,
      'every device must be reachable from one of the two'
    );
  });

  test('a declared series with no products shows everything, and does not claim staleness', () => {
    // Haptic: HAPTIC is a real, active series value in the org, but no serialized product carries
    // it. An empty table would read as "this family has no SKUs" — true, but it strands the
    // operator, so the whole catalog plus a note is the answer.
    const r = filterCatalogByFamily(CATALOG, 'haptic', FILTERS);
    assert.equal(r.products.length, CATALOG.length);
    assert.equal(r.filterApplied, false);
    assert.equal(r.reason, 'no-matches');
  });

  test('a family with no rule at all is reported differently from one whose rule matched nothing', () => {
    const r = filterCatalogByFamily(CATALOG, 'nosuchfamily', FILTERS);
    assert.equal(r.filterApplied, false);
    assert.equal(r.reason, 'no-filter-declared');
  });

  test('no family selected is not a filter', () => {
    const r = filterCatalogByFamily(CATALOG, null, FILTERS);
    assert.equal(r.products.length, CATALOG.length);
    assert.equal(r.filterApplied, false);
  });

  test('a product with no series is never matched by a series filter', () => {
    for (const family of ['octo', 'dhub', 'dms', 'vbus']) {
      assert.equal(
        codes(filterCatalogByFamily(CATALOG, family, FILTERS)).includes('EXTINDCAMCONV'),
        false,
        `${family} must not match the seriesless product`
      );
    }
  });

  test('an excludeSeries rule still excludes a product that has no series', () => {
    // `excludeSeries` must not accidentally admit unclassified rows: the seriesless product is an
    // accessory, so the Device rule keeps it out on l1Family alone.
    assert.equal(
      codes(filterCatalogByFamily(CATALOG, 'driveri', FILTERS)).includes('EXTINDCAMCONV'),
      false
    );
  });

  test('an empty catalog reports that it could not filter', () => {
    const r = filterCatalogByFamily([], 'driveri', FILTERS);
    assert.deepEqual(r.products, []);
    assert.equal(r.filterApplied, false);
  });

  test('the unfiltered total is always reported, so the UI can offer "show all"', () => {
    const r = filterCatalogByFamily(CATALOG, 'octo', FILTERS);
    assert.equal(r.total, CATALOG.length);
    assert.equal(r.products.length, 2);
  });

  test('matching is case-insensitive', () => {
    const shouty = { dhub: { series: ['dhub'] } };
    const r = filterCatalogByFamily(CATALOG, 'dhub', shouty);
    assert.equal(r.filterApplied, true);
    assert.deepEqual(codes(r), ['DHUBX']);
  });
});

/**
 * The catalog query keeps `Product_Serialized__c = 'Yes'`, which is right for almost everything —
 * but Haptic's only product, ACCAM1HAPTICMDL "Haptic Feedback Module", is flagged `No` in the org
 * while this app mints a `serial_number` series for it and has a verified Haptic_Initial_Load.csv.
 * The org's flag and the sheets disagree, and the sheets are what the parser accepted.
 *
 * `declaredSeries` is how the query reaches those rows without opening the gate to all 555
 * non-serialized products: it widens to exactly the series a family rule names, and nothing else.
 */
describe('series a family rule declares', () => {
  test('collects every positively declared series, deduplicated', () => {
    const series = declaredSeries({
      octo: { series: ['D810'] },
      dhub: { series: ['DHUB'] },
      haptic: { series: ['HAPTIC'] },
      other: { series: ['DHUB'] },
    });
    assert.deepEqual([...series].sort(), ['D810', 'DHUB', 'HAPTIC']);
  });

  test('a rule with no series contributes nothing', () => {
    // Driveri is declared by L1 family, so it widens the query for no one.
    assert.deepEqual(declaredSeries({ driveri: { l1Family: ['Device'], excludeSeries: ['D810'] } }), []);
  });

  test('excludeSeries is not a reason to fetch a series', () => {
    assert.deepEqual(declaredSeries({ a: { excludeSeries: ['D810'] } }), []);
  });

  test('no rules at all is not an error', () => {
    assert.deepEqual(declaredSeries(undefined), []);
    assert.deepEqual(declaredSeries({}), []);
  });
});
