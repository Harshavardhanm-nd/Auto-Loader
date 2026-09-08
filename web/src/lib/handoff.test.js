import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { partitionHandoff } from './handoff.js';

/** The stage-step model as `/api/catalog/lifecycle` reports it. */
const MODEL = {
  stageSteps: [{ operation: 'dataUpdate', at: -2, before: 'shipmentUpdate', requiredFor: ['octo'] }],
  successStatus: { dataUpdate: 'DATA_UPDATE_SYNC_SUCCESS' },
};

const row = (deviceId, family, syncStatus = 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS') => ({
  deviceId,
  family,
  syncStatus,
});

const ids = (rows) => rows.map((r) => r.deviceId);

describe('hand-off partition', () => {
  test('a family that owes the step is offered only that step', () => {
    const { dataUpdate, shipmentUpdate } = partitionHandoff([row('1', 'octo')], MODEL);
    assert.deepEqual(ids(dataUpdate), ['1']);
    assert.deepEqual(ids(shipmentUpdate), []);
  });

  test('a family that does not owe it is offered both', () => {
    const { dataUpdate, shipmentUpdate } = partitionHandoff([row('2', 'driveri')], MODEL);
    assert.deepEqual(ids(dataUpdate), ['2']);
    assert.deepEqual(ids(shipmentUpdate), ['2']);
  });

  test('a mixed selection splits per device, not per run', () => {
    // The whole point: one Octo group in the run must not hold the Driveri devices back.
    const rows = [row('1', 'octo'), row('2', 'driveri'), row('3', 'haptic'), row('4', 'vbus')];
    const { dataUpdate, shipmentUpdate } = partitionHandoff(rows, MODEL);
    assert.deepEqual(ids(dataUpdate), ['1', '2', '3', '4']);
    assert.deepEqual(ids(shipmentUpdate), ['2', '3', '4']);
  });

  test('an owing device is released once its step has actually synced', () => {
    const rows = [row('1', 'octo', 'DATA_UPDATE_SYNC_SUCCESS')];
    const { shipmentUpdate } = partitionHandoff(rows, MODEL);
    assert.deepEqual(ids(shipmentUpdate), ['1']);
  });

  test('a send is not enough to release it — the org has to have written the status', () => {
    const rows = [row('1', 'octo', 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS')];
    assert.deepEqual(ids(partitionHandoff(rows, MODEL).shipmentUpdate), []);
  });

  test('a device whose family is unknown is not held back', () => {
    // An unknown must not manufacture a conclusion. Withholding on a family that could not be
    // identified would block work on a guess.
    const { dataUpdate, shipmentUpdate } = partitionHandoff([row('9', null)], MODEL);
    assert.deepEqual(ids(dataUpdate), ['9']);
    assert.deepEqual(ids(shipmentUpdate), ['9']);
  });

  test('no stage step declared means nothing is ever withheld', () => {
    const model = { stageSteps: [], successStatus: {} };
    const { shipmentUpdate } = partitionHandoff([row('1', 'octo')], model);
    assert.deepEqual(ids(shipmentUpdate), ['1']);
  });

  test('a partial model does not take the page down', () => {
    assert.deepEqual(partitionHandoff([], undefined), { dataUpdate: [], shipmentUpdate: [] });
    assert.deepEqual(partitionHandoff(null, MODEL), { dataUpdate: [], shipmentUpdate: [] });
  });

  test('the rows handed back are the rows handed in', () => {
    // The caller reads deviceId, accessories and syncStatus off these to build the CSV request.
    const original = row('1', 'driveri');
    assert.equal(partitionHandoff([original], MODEL).shipmentUpdate[0], original);
  });
});
