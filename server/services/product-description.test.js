import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeProduct, decodeSku } from './sku-decoder.js';

/**
 * The one line under a product code in the picker: "what is this".
 *
 * A Driveri hardware code is positional, so `decodeSku` reads it and that is the best answer there
 * is. Accessory codes are a different scheme entirely — `ACCAM1HAPTICMDL`, `DHUBX` and `VDI2L001`
 * share no structure — and the decoder correctly refuses them.
 *
 * 31 of the testing org's 170 catalog rows are in that position, and they are **every** row of the
 * DHUB, DMS, VBUS and Haptic families. The picker printed "code not decodable" for all of them,
 * which is a true statement about the decoder and a useless one about the product. Every one of
 * those 31 is already classified by the org, so the fallback is its own words.
 *
 * Rows below are real, taken from the testing org on 2026-08-15.
 */

const row = (p) => ({ kind: 'accessory', ...p, decoded: decodeSku(p.productCode) });

describe('describing a product whose code cannot be decoded', () => {
  test('a decodable Driveri code still wins', () => {
    // Nothing about this changes: the decode is richer than any classification field.
    const p = row({ productCode: 'B3E231USASI0210S', kind: 'device', productCategory: 'D450', deviceType: 'Driveri' });
    assert.equal(describeProduct(p), p.decoded.summary);
    assert.ok(describeProduct(p).includes('D-450'));
  });

  test('an accessory falls back to the org’s own classification', () => {
    assert.equal(
      describeProduct(row({ productCode: 'ACCAM1HAPTICMDL', productCategory: 'Auxiliary Module', deviceType: 'HAPTIC', productSeries: 'HAPTIC' })),
      'Auxiliary Module · HAPTIC'
    );
  });

  test('never returns the dead-end sentence for any real catalog row', () => {
    const REAL = [
      { productCode: 'ACCAC1SQN720PAWC', productCategory: 'Auxiliary Camera' },
      { productCode: 'ACCAT1AT700BTTRY', productCategory: 'Auxiliary Module', deviceType: 'ASSET_TRACKER', productSeries: 'AT700' },
      { productCode: 'ACCCM1DMSCAM', productCategory: 'DMS', deviceType: 'DMS_CAMERA', productSeries: 'DMS' },
      { productCode: 'ACCDC1DR20', productCategory: 'Digital Camera', deviceType: 'NATIVE_DIGITAL_CAMERA', productSeries: 'DR-20' },
      { productCode: 'ACCDR2DHUBX6MC3M', productCategory: 'DHUBX', deviceType: 'DHUB', productSeries: 'DHUB' },
      { productCode: 'ACCEC1EMPCAM', productCategory: 'Auxiliary Camera', deviceType: 'EXCAM', productSeries: 'EXCAM' },
      { productCode: 'DHUBX', productCategory: 'DHUBX', deviceType: 'DHUB', productSeries: 'DHUB' },
      { productCode: 'VDI2L001', productCategory: 'Vehicle Data Reader', deviceType: 'VBUS', productSeries: 'VBUS' },
    ];
    for (const p of REAL) {
      const text = describeProduct(row(p));
      assert.ok(text && text.trim().length, `${p.productCode} must say something`);
      assert.equal(/decodable/i.test(text), false, `${p.productCode} must not mention decoding`);
    }
  });

  test('the more specific of two overlapping values wins', () => {
    // `DMS` (L2 category) and `DMS_CAMERA` (device type) are the same fact at two precisions.
    assert.equal(
      describeProduct(row({ productCode: 'ACCCM1DMSCAM', productCategory: 'DMS', deviceType: 'DMS_CAMERA' })),
      'DMS_CAMERA'
    );
    // …and the other way round, where the category is the longer of the two.
    assert.equal(
      describeProduct(row({ productCode: 'ACCDR2DHUBX6MC3M', productCategory: 'DHUBX', deviceType: 'DHUB' })),
      'DHUBX'
    );
  });

  test('not repeating the code outranks being more specific', () => {
    // The DHUBX product is genuinely `ProductCode = DHUBX`, `Product_Category__c = DHUBX` — the
    // category is its own code. Echoing it directly under the code says nothing, so the device
    // type is shown instead even though it is the less specific of the two.
    assert.equal(
      describeProduct(row({ productCode: 'DHUBX', productCategory: 'DHUBX', deviceType: 'DHUB' })),
      'DHUB'
    );
  });

  test('genuinely different values are both kept, category first', () => {
    assert.equal(
      describeProduct(row({ productCode: 'ACCEC1EMPCAM', productCategory: 'Auxiliary Camera', deviceType: 'EXCAM' })),
      'Auxiliary Camera · EXCAM'
    );
  });

  test('a value is never repeated, whatever its spelling', () => {
    const text = describeProduct(row({ productCode: 'X', productCategory: 'Asset Tracker', deviceType: 'ASSET_TRACKER' }));
    assert.equal(text.split('·').length, 1, `underscores and spaces are the same word: ${text}`);
  });

  test('a series that merely repeats the product code is not shown', () => {
    // Three EXCAM rows carry `Product_Series__c = 'EXCAM-<their own product code>'`, which says
    // nothing the code on the line above does not already say.
    assert.equal(
      describeProduct(row({ productCode: 'ACCEC1SQN720PANL', productSeries: 'EXCAM-ACCEC1SQN720PANL' })),
      'Accessory'
    );
  });

  test('the series is used only when there is nothing better', () => {
    assert.equal(describeProduct(row({ productCode: 'ZZZ1', productSeries: 'KFOB' })), 'KFOB');
  });

  test('a row classified by nothing at all still says what it is', () => {
    // Every catalog row has a `kind`, so there is always something truer than "not decodable".
    assert.equal(describeProduct(row({ productCode: 'ZZZ1' })), 'Accessory');
    assert.equal(describeProduct(row({ productCode: 'ZZZ1', kind: 'device' })), 'Device');
  });

  test('org strings keep their own case and punctuation', () => {
    // `DMS_CAMERA` and `WIRELESS_ALERT_BUTTON` are literal values the org and the Apex parser use.
    // Re-casing one into "Dms Camera" misreports it — the class of error this app exists to prevent.
    const text = describeProduct(row({ productCode: 'X', deviceType: 'WIRELESS_ALERT_BUTTON' }));
    assert.equal(text, 'WIRELESS_ALERT_BUTTON');
  });

  test('a missing or malformed product is not a crash', () => {
    assert.ok(describeProduct(undefined));
    assert.ok(describeProduct({}));
    assert.ok(describeProduct({ productCode: null, decoded: null }));
  });
});
