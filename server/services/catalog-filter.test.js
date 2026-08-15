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

// Real values and real counts, taken from the testing org on 2026-08-15. `family` is the standard
// `Product2.Family`; `l1Family` is the custom `L1_Product_Family__c`, which exists in testing and
// **not in staging** — every row here carries both so the same fixture can play either org.
const CATALOG = [
  { productCode: 'B2E231USASS00C0S', productSeries: 'D210', family: 'Hardware', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'K2I132USASI10Y4S', productSeries: 'D215', family: 'Hardware', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'B3E110005AAA', productSeries: 'D450', family: 'Hardware', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'DE811301USA01001', productSeries: 'D810', family: 'Hardware', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'DE811311USA01001', productSeries: 'D810', family: 'Hardware', l1Family: 'Device', deviceType: 'Driveri' },
  { productCode: 'DHUBX', productSeries: 'DHUB', family: 'Accessory', l1Family: 'Accessory', deviceType: 'DHUB' },
  { productCode: 'ACCCM1DMSCAM', productSeries: 'DMS', family: 'Accessory', l1Family: 'Accessory', deviceType: 'DMS_CAMERA' },
  { productCode: 'VDI2L001', productSeries: 'VBUS', family: 'Accessory', l1Family: 'Accessory', deviceType: 'VBUS' },
  { productCode: 'ACCEC1EMPCAM', productSeries: 'EXCAM', family: 'Accessory', l1Family: 'Accessory', deviceType: 'EXCAM' },
  // Nine products in the org carry no series at all.
  { productCode: 'EXTINDCAMCONV', productSeries: null, family: 'Accessory', l1Family: 'Accessory', deviceType: null },
];

/** The same catalog as an org that does not expose `L1_Product_Family__c` returns it. */
const CATALOG_WITHOUT_L1 = CATALOG.map(({ l1Family, ...rest }) => rest);

const FILTERS = {
  // Driveri is every device *except* Octo, so a new D-series model appears without a config edit.
  // Keyed on the standard `Product2.Family` rather than the custom L1 field, because the custom one
  // is absent in staging — see the `sfFamily` block at the foot of this file.
  driveri: { sfFamily: ['Hardware'], excludeSeries: ['D810'] },
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
      { productCode: 'NEWMODEL001', productSeries: 'D480', family: 'Hardware', l1Family: 'Device', deviceType: 'Driveri' },
    ];
    assert.ok(codes(filterCatalogByFamily(withNewModel, 'driveri', FILTERS)).includes('NEWMODEL001'));
  });

  test('Driveri and Octo never overlap, and together cover every device', () => {
    const driveri = codes(filterCatalogByFamily(CATALOG, 'driveri', FILTERS));
    const octo = codes(filterCatalogByFamily(CATALOG, 'octo', FILTERS));

    assert.equal(driveri.some((c) => octo.includes(c)), false, 'no SKU may appear under both');
    assert.equal(
      driveri.length + octo.length,
      CATALOG.filter((p) => p.family === 'Hardware').length,
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
    // accessory, so the Hardware rule keeps it out on `sfFamily` alone.
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
 * Declaring a family on the standard `Product2.Family` rather than the custom `L1_Product_Family__c`.
 *
 * The custom field exists in testing and **not in staging** (verified 2026-08-15), which took the
 * whole picker out there. The standard field is an exact stand-in: in testing every one of the 137
 * `L1 = Device` rows is `Family = 'Hardware'` and every one of the 33 `L1 = Accessory` rows is
 * `Family = 'Accessory'` — a clean cross-tab with nothing off the diagonal — and staging's own
 * `Family = 'Hardware'` minus series `D810` gives the same 135 Driveri products testing does.
 *
 * `l1Family` stays supported: it is still selected where the org has it, and a rule may still name
 * it. Nothing in the shipped config depends on it any more.
 */
describe('declaring a family on the standard product family field', () => {
  test('Driveri resolves identically in an org with no L1 field', () => {
    const withL1 = codes(filterCatalogByFamily(CATALOG, 'driveri', FILTERS));
    const withoutL1 = codes(filterCatalogByFamily(CATALOG_WITHOUT_L1, 'driveri', FILTERS));

    assert.deepEqual(withoutL1, withL1, 'the missing custom field must not change the answer');
    assert.deepEqual(withoutL1, ['B2E231USASS00C0S', 'K2I132USASI10Y4S', 'B3E110005AAA']);
  });

  test('every family still narrows in an org with no L1 field', () => {
    // The bug this guards: staging showed nothing at all for every family, not just Driveri.
    for (const [family, expected] of [
      ['driveri', 3],
      ['octo', 2],
      ['dhub', 1],
      ['dms', 1],
      ['vbus', 1],
    ]) {
      const r = filterCatalogByFamily(CATALOG_WITHOUT_L1, family, FILTERS);
      assert.equal(r.products.length, expected, family);
      assert.equal(r.filterApplied, true, `${family} should still report a filter`);
    }
  });

  test('an accessory is never matched by a Hardware rule', () => {
    const driveri = codes(filterCatalogByFamily(CATALOG_WITHOUT_L1, 'driveri', FILTERS));
    for (const accessory of ['DHUBX', 'ACCCM1DMSCAM', 'VDI2L001', 'ACCEC1EMPCAM', 'EXTINDCAMCONV']) {
      assert.equal(driveri.includes(accessory), false, `${accessory} is not a Driveri device`);
    }
  });

  test('a row with no product family value is never matched', () => {
    // Same rule as every other criterion: unclassified is not universal.
    const orphan = [{ productCode: 'NOFAMILY', productSeries: 'D210', family: null }];
    const r = filterCatalogByFamily(orphan, 'driveri', FILTERS);
    assert.equal(r.filterApplied, false, 'nothing matched, so it falls back rather than hiding it');
    assert.equal(r.reason, 'no-matches');
  });

  test('matching is case-insensitive, like every other criterion', () => {
    const shouty = { driveri: { sfFamily: ['hardware'], excludeSeries: ['d810'] } };
    assert.deepEqual(codes(filterCatalogByFamily(CATALOG, 'driveri', shouty)), [
      'B2E231USASS00C0S',
      'K2I132USASI10Y4S',
      'B3E110005AAA',
    ]);
  });

  test('a rule naming only sfFamily counts as a real rule', () => {
    const r = filterCatalogByFamily(CATALOG, 'anything', { anything: { sfFamily: ['Accessory'] } });
    assert.equal(r.filterApplied, true, 'sfFamily alone must not read as "no filter declared"');
    assert.equal(r.products.length, 5);
  });

  test('l1Family still works where an org has it', () => {
    const legacy = { driveri: { l1Family: ['Device'], excludeSeries: ['D810'] } };
    assert.deepEqual(codes(filterCatalogByFamily(CATALOG, 'driveri', legacy)), [
      'B2E231USASS00C0S',
      'K2I132USASI10Y4S',
      'B3E110005AAA',
    ]);
  });
});

/**
 * A family whose identifying field is filled in one org and blank in another.
 *
 * The Haptic module, `ACCAM1HAPTICMDL`, is one product that the two sandboxes describe differently
 * (verified 2026-08-15):
 *
 *            Product_Serialized__c   Product_Series__c   Device_Type__c
 *   testing            No                 HAPTIC             HAPTIC
 *   staging            Yes                (blank)            HAPTIC
 *
 * Keyed on series alone it is invisible in staging, and `series: ['HAPTIC']` matched nothing there —
 * so the picker fell back to all 168 products instead of the one Haptic SKU. `Device_Type__c` is the
 * field that survives both differences, and it matches exactly one product in each org.
 *
 * It cannot simply *replace* the series, because criteria are ANDed and staging's series is blank —
 * and because `declaredSeries` reads `series` to widen the query past `Product_Serialized__c =
 * 'Yes'`, which is the only reason testing's copy (flagged `No`) is in the catalog at all. So the
 * rule keeps both and declares `match: 'any'`: either signal identifies the family, and the
 * widening survives untouched.
 */
describe('a family identified by either of two fields', () => {
  const HAPTIC_TESTING = { productCode: 'ACCAM1HAPTICMDL', productSeries: 'HAPTIC', family: 'Accessory', deviceType: 'HAPTIC' };
  const HAPTIC_STAGING = { productCode: 'ACCAM1HAPTICMDL', productSeries: null, family: 'Accessory', deviceType: 'HAPTIC' };
  const ANY = { haptic: { series: ['HAPTIC'], deviceType: ['HAPTIC'], match: 'any' } };

  test('matches on the series where the org fills it in', () => {
    const r = filterCatalogByFamily([...CATALOG, HAPTIC_TESTING], 'haptic', ANY);
    assert.deepEqual(codes(r), ['ACCAM1HAPTICMDL']);
    assert.equal(r.filterApplied, true);
  });

  test('matches on the device type where the org leaves the series blank', () => {
    // The staging bug, exactly: series is null, so an ANDed rule found nothing and the picker
    // showed every product in the org rather than the one Haptic SKU.
    const r = filterCatalogByFamily([...CATALOG, HAPTIC_STAGING], 'haptic', ANY);
    assert.deepEqual(codes(r), ['ACCAM1HAPTICMDL']);
    assert.equal(r.filterApplied, true);
  });

  test('a product carrying both signals is matched once, not twice', () => {
    const r = filterCatalogByFamily([...CATALOG, HAPTIC_TESTING], 'haptic', ANY);
    assert.equal(r.products.length, 1);
  });

  test('no other catalog row is pulled in by the widened rule', () => {
    for (const org of [HAPTIC_TESTING, HAPTIC_STAGING]) {
      const r = filterCatalogByFamily([...CATALOG, org], 'haptic', ANY);
      assert.deepEqual(codes(r), ['ACCAM1HAPTICMDL'], 'only the Haptic module may match');
    }
  });

  test("the series stays in the rule, so the query still widens to reach it", () => {
    // Testing's copy is flagged `Product_Serialized__c = 'No'` and is in the catalog only because
    // `HAPTIC` is in the query's widening clause. A rule that dropped `series` would take it out.
    assert.deepEqual(declaredSeries(ANY), ['HAPTIC']);
  });
});

describe('how a rule combines its criteria', () => {
  test('the default is still every criterion, so Driveri is unchanged', () => {
    // driveri is `sfFamily: [Hardware]` minus D810. Under `any` it would admit every accessory.
    const r = filterCatalogByFamily(CATALOG, 'driveri', FILTERS);
    assert.deepEqual(codes(r), ['B2E231USASS00C0S', 'K2I132USASI10Y4S', 'B3E110005AAA']);
  });

  test('an explicit "all" behaves like the default', () => {
    const strict = { driveri: { sfFamily: ['Hardware'], excludeSeries: ['D810'], match: 'all' } };
    assert.deepEqual(codes(filterCatalogByFamily(CATALOG, 'driveri', strict)), [
      'B2E231USASS00C0S',
      'K2I132USASI10Y4S',
      'B3E110005AAA',
    ]);
  });

  test('"all" and "any" genuinely differ on the same rule', () => {
    const criteria = { series: ['DHUB'], deviceType: ['DMS_CAMERA'] };
    const all = filterCatalogByFamily(CATALOG, 'x', { x: { ...criteria, match: 'all' } });
    const any = filterCatalogByFamily(CATALOG, 'x', { x: { ...criteria, match: 'any' } });

    assert.equal(all.filterApplied, false, 'nothing is both DHUB and a DMS camera');
    assert.deepEqual(codes(any).sort(), ['ACCCM1DMSCAM', 'DHUBX']);
  });

  test('excludeSeries is a veto under "any", not one more alternative', () => {
    // Otherwise a rule saying "anything but D810" would match D810 on its other criterion.
    const rule = { octoish: { deviceType: ['Driveri'], excludeSeries: ['D810'], match: 'any' } };
    const r = filterCatalogByFamily(CATALOG, 'octoish', rule);
    assert.equal(codes(r).includes('DE811301USA01001'), false, 'D810 must stay excluded');
    assert.deepEqual(codes(r), ['B2E231USASS00C0S', 'K2I132USASI10Y4S', 'B3E110005AAA']);
  });

  test('a rule with only match and no criteria is still not a filter', () => {
    const r = filterCatalogByFamily(CATALOG, 'empty', { empty: { match: 'any' } });
    assert.equal(r.filterApplied, false);
    assert.equal(r.reason, 'no-filter-declared');
  });

  test('a rule with only excludeSeries keeps everything else', () => {
    // No positive criterion at all: `any` must not read as "nothing matched".
    const r = filterCatalogByFamily(CATALOG, 'notocto', { notocto: { excludeSeries: ['D810'], match: 'any' } });
    assert.equal(r.filterApplied, true);
    assert.equal(r.products.length, CATALOG.length - 2);
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
    // Driveri is declared by product family, so it widens the query for no one.
    assert.deepEqual(declaredSeries({ driveri: { sfFamily: ['Hardware'], excludeSeries: ['D810'] } }), []);
  });

  test('excludeSeries is not a reason to fetch a series', () => {
    assert.deepEqual(declaredSeries({ a: { excludeSeries: ['D810'] } }), []);
  });

  test('no rules at all is not an error', () => {
    assert.deepEqual(declaredSeries(undefined), []);
    assert.deepEqual(declaredSeries({}), []);
  });
});
