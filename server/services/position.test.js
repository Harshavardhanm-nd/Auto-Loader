import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarisePolling } from './sf-client.js';

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
