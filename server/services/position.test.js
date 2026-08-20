import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarisePolling, splitByStagePosition } from './sf-client.js';

/**
 * Where a device sits relative to the stage being watched.
 *
 * On the Asset a device ahead of the watched stage and one behind it look identical — each carries
 * some `_SYNC_SUCCESS`. The answer comes from the order in `lifecycle.json`, so a device that has
 * only had its data update must not read as having been shipped.
 */
const asset = (deviceId, syncStatus, idmsStatus) => ({
  deviceId, syncStatus, idmsStatus, id: 'a' + deviceId, assetStatus: null,
  cpqOrderNumber: null, phase: 'synced',
});

describe('placing a device against the watched stage', () => {
  test('a data-updated device is behind shipment update, not done', () => {
    const s = summarisePolling('shipmentUpdate', ['1'], [asset('1', 'DATA_UPDATE_SYNC_SUCCESS', -2)]);
    const row = s.rows[0];
    assert.equal(row.aheadOfStage, false, 'a data update is not a shipment update');
    assert.equal(s.counts.succeeded, 0, 'it must not be counted as loaded');
  });

  test('a shipped device is ahead of the data-update stage', () => {
    const s = summarisePolling('dataUpdate', ['1'], [asset('1', 'SHIPMENT_UPDATE_SYNC_SUCCESS', -1)]);
    assert.equal(s.rows[0].aheadOfStage, true);
  });

  test('a device at the watched stage is done', () => {
    const s = summarisePolling('dataUpdate', ['1'], [asset('1', 'DATA_UPDATE_SYNC_SUCCESS', -2)]);
    assert.equal(s.counts.succeeded, 1);
  });

  test('an unmodelled status is never read as progress', () => {
    const s = summarisePolling('shipmentUpdate', ['1'], [asset('1', 'SOMETHING_ELSE_SYNC_SUCCESS', -2)]);
    assert.equal(s.rows[0].aheadOfStage, false);
  });
});

/**
 * The split reduces a full row to a summary, and every field it forgets to copy disappears from
 * the UI silently. `id` is the Salesforce Asset id, which is what lets the Watch page link a
 * serial number to the record it came from — a device that has moved on is exactly the one you
 * most want to open, so dropping it here is the case that matters.
 */
describe('the stage split keeps the Asset id', () => {
  const split = (stage, ids, assets) => splitByStagePosition(summarisePolling(stage, ids, assets));

  test('a device that moved on carries its Asset id', () => {
    const s = split('dataUpdate', ['1'], [asset('1', 'SHIPMENT_UPDATE_SYNC_SUCCESS', -1)]);
    assert.equal(s.movedOn.length, 1);
    assert.equal(s.movedOn[0].assetId, 'a1');
  });

  test('a device not yet at the stage carries its Asset id', () => {
    const s = split('shipmentUpdate', ['1'], [asset('1', 'DATA_UPDATE_SYNC_SUCCESS', -2)]);
    assert.equal(s.notYet.length, 1);
    assert.equal(s.notYet[0].assetId, 'a1');
  });

  test('a row with no Asset id yields null rather than undefined', () => {
    const bare = { ...asset('1', 'SHIPMENT_UPDATE_SYNC_SUCCESS', -1), id: undefined };
    const s = split('dataUpdate', ['1'], [bare]);
    assert.equal(s.movedOn[0].assetId, null, 'an absent id must be explicit, not missing');
  });
});
