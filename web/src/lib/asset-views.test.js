import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ASSET_VIEW_TABS, filterViewRows, isSelectableView } from './asset-views.js';

const row = (deviceId, idmsStatus, syncStatus = null) => ({ deviceId, idmsStatus, syncStatus });
const ids = (rows) => rows.map((r) => r.deviceId);

// One device at every stage the chart draws, IDMS as the org returns it — a string.
const ROWS = [-2, -1, 1, 2, 3, 4, 10, 5, 7, 11, 6, 8, 12, 9].map((code) => row(`d${code}`, String(code)));

describe('non-RMA views', () => {
  test('Non-RMA Pending is IDMS 11 exactly', () => {
    assert.deepEqual(ids(filterViewRows(ROWS, 'nonRmaPending')), ['d11']);
  });

  test('Non-RMA Initiated is IDMS 6 — "Return Initiated Non-RMA"', () => {
    assert.deepEqual(ids(filterViewRows(ROWS, 'nonRmaInitiated')), ['d6']);
  });

  test('Non-RMA Initiated leaves out devices already sent back, as RMA Initiated does', () => {
    // After the RMA Returned email the device still reads IDMS 6 until the integration moves it;
    // its sync status is what says the return was already sent.
    const rows = [
      row('a', '6'),
      row('b', '6', 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER'),
      row('c', '6', 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER_SYNC_SUCCESS'),
      row('d', '6', 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER_SYNC_FAILED'),
    ];
    assert.deepEqual(ids(filterViewRows(rows, 'nonRmaInitiated')), ['a']);
  });

  test('Returned Non-RMA is IDMS 8', () => {
    assert.deepEqual(ids(filterViewRows(ROWS, 'returnedNonRma')), ['d8']);
  });

  test('numeric and string IDMS values are read the same way', () => {
    assert.deepEqual(ids(filterViewRows([row('n', 8), row('s', '8')], 'returnedNonRma')), ['n', 's']);
  });

  test('a device with no IDMS status appears in none of them', () => {
    const unknown = [row('u', null), row('v', undefined)];
    for (const tab of ['nonRmaPending', 'nonRmaInitiated', 'returnedNonRma']) {
      assert.deepEqual(filterViewRows(unknown, tab), [], tab);
    }
  });
});

describe('which views can be ticked', () => {
  test('only views with an operation to hand devices to are selectable', () => {
    // rmaInitiated and nonRmaInitiated → RMA Returned (one email, one sheet for both legs),
    // deadView → Mark Dead / Undo Dead, returnedNonRma → Mark Dead. Non-RMA Pending moves by
    // Support raising a return, not by an email, so a checkbox there would lead nowhere.
    const selectable = ASSET_VIEW_TABS.filter((t) => isSelectableView(t.id)).map((t) => t.id);
    assert.deepEqual(selectable.sort(), ['deadView', 'nonRmaInitiated', 'returnedNonRma', 'rmaInitiated']);
  });

  test('a stage tab is not a selectable view', () => {
    assert.equal(isSelectableView('initialLoad'), false);
  });
});

describe('existing views keep their rules', () => {
  test('RMA Pending is IDMS 10 and Installed is IDMS 4', () => {
    assert.deepEqual(ids(filterViewRows(ROWS, 'rmaPending')), ['d10']);
    assert.deepEqual(ids(filterViewRows(ROWS, 'installed')), ['d4']);
  });

  test('RMA Initiated leaves out devices already received at the repair partner', () => {
    const rows = [
      row('a', '5'),
      row('b', '5', 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER_SYNC_SUCCESS'),
    ];
    assert.deepEqual(ids(filterViewRows(rows, 'rmaInitiated')), ['a']);
  });

  test('an unknown view returns nothing, and no rows returns nothing', () => {
    assert.deepEqual(filterViewRows(ROWS, 'nope'), []);
    assert.deepEqual(filterViewRows(undefined, 'installed'), []);
  });
});
