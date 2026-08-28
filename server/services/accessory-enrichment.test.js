import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accessorySerialsFor, attachAccessories } from './accessory-enrichment.js';

/**
 * Pure functions only: `enrichWithAccessories` itself wraps `fetchAssetsByDeviceId` and is left
 * untested here, the same way `fetchAssetsByDeviceId`/`query()` are never tested directly
 * elsewhere in this repo — the tested logic is what decides which serials to ask for and how to
 * read the answer, not the network call itself.
 */

describe('accessorySerialsFor', () => {
  test('gathers wired-speaker and native-camera serials across devices', () => {
    const record = {
      d1: { wiredSpeaker: 'WS1', nativeCam: 'NC1' },
      d2: { wiredSpeaker: 'WS2' },
      d3: { nativeCam: 'NC3' },
    };
    assert.deepEqual(accessorySerialsFor(record).sort(), ['NC1', 'NC3', 'WS1', 'WS2'].sort());
  });

  test('a device with neither field contributes nothing', () => {
    assert.deepEqual(accessorySerialsFor({ d1: {} }), []);
  });

  test('null or missing record yields no serials', () => {
    assert.deepEqual(accessorySerialsFor(null), []);
    assert.deepEqual(accessorySerialsFor(undefined), []);
  });
});

describe('attachAccessories', () => {
  test('a device with no recorded accessory passes through unchanged', () => {
    const rows = [{ deviceId: 'd1', syncStatus: 'X' }];
    const out = attachAccessories(rows, { d2: { wiredSpeaker: 'WS2' } }, []);
    assert.deepEqual(out, rows);
    assert.equal('accessories' in out[0], false);
  });

  test('an accessory not yet an Asset reports present:false with a null assetId', () => {
    const rows = [{ deviceId: 'd1' }];
    const out = attachAccessories(rows, { d1: { wiredSpeaker: 'WS1' } }, []);
    assert.equal(out[0].accessories.length, 1);
    assert.deepEqual(out[0].accessories[0], {
      type: 'Wired Speaker',
      serialId: 'WS1',
      present: false,
      assetId: null,
      stage: { known: false, absent: true, code: null, label: 'no stage yet', stage: null },
      syncStatus: null,
      assetStatus: null,
    });
  });

  test('an accessory matched to a fetched Asset carries its stage and ids', () => {
    const rows = [{ deviceId: 'd1' }];
    const accessoryAssets = [
      { deviceId: 'WS1', id: 'a00WS1', idmsStatus: -2, syncStatus: 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS', assetStatus: 'Active' },
    ];
    const out = attachAccessories(rows, { d1: { wiredSpeaker: 'WS1' } }, accessoryAssets);
    const acc = out[0].accessories[0];
    assert.equal(acc.present, true);
    assert.equal(acc.assetId, 'a00WS1');
    assert.equal(acc.syncStatus, 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS');
    assert.equal(acc.assetStatus, 'Active');
    assert.equal(acc.stage.known, true);
  });

  test('a device carrying both accessories gets both, in a stable order', () => {
    const rows = [{ deviceId: 'd1' }];
    const out = attachAccessories(rows, { d1: { wiredSpeaker: 'WS1', nativeCam: 'NC1' } }, []);
    assert.deepEqual(
      out[0].accessories.map((a) => a.type),
      ['Wired Speaker', 'Native Camera']
    );
  });

  test('null accessoriesRecord returns rows unchanged', () => {
    const rows = [{ deviceId: 'd1' }];
    assert.equal(attachAccessories(rows, null, []), rows);
  });

  test('empty rows returns as-is without touching accessoryAssets', () => {
    assert.deepEqual(attachAccessories([], { d1: { wiredSpeaker: 'WS1' } }, []), []);
  });
});
