import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { operationChain, pollingOrder, requiredStepsBefore, describeLifecycle } from './lifecycle.js';

/**
 * Two orders, deliberately different.
 *
 * `operationChain` is the movement chain — what actually carries a device from stage to stage.
 * `pollingOrder` is what positions are compared in, and includes operations that run *at* a stage
 * without moving it. A device carrying DATA_UPDATE_SYNC_SUCCESS sits between initial load and
 * shipment update, and has to be placed there or it reads as "unknown" and is treated as not done.
 */
describe('the order operations are compared in', () => {
  test('the movement chain carries no stage-preserving step', () => {
    assert.deepEqual(operationChain(), ['initialLoad', 'shipmentUpdate', 'received']);
  });

  test('the polling order splices dataUpdate in before shipment update', () => {
    assert.deepEqual(pollingOrder(), ['initialLoad', 'dataUpdate', 'shipmentUpdate', 'received']);
  });

  test('every movement operation keeps its relative order', () => {
    const order = pollingOrder();
    const positions = operationChain().map((op) => order.indexOf(op));
    assert.ok(
      positions.every((p, i) => i === 0 || p > positions[i - 1]),
      'splicing a stage step must not reorder the movements'
    );
  });

  test('is stable across calls', () => {
    assert.deepEqual(pollingOrder(), pollingOrder());
  });
});

describe('which steps a family must complete first', () => {
  test('Octo must data-update before shipping', () => {
    assert.deepEqual(requiredStepsBefore('shipmentUpdate', 'octo'), ['dataUpdate']);
  });

  test('no other family is required to', () => {
    for (const family of ['driveri', 'dhub', 'dms', 'vbus', 'haptic']) {
      assert.deepEqual(requiredStepsBefore('shipmentUpdate', family), [], family);
    }
  });

  test('nothing is required before the step itself, or before an unrelated operation', () => {
    assert.deepEqual(requiredStepsBefore('dataUpdate', 'octo'), []);
    assert.deepEqual(requiredStepsBefore('received', 'octo'), []);
  });

  test('an unknown family requires nothing rather than throwing', () => {
    assert.deepEqual(requiredStepsBefore('shipmentUpdate', 'nosuchfamily'), []);
    assert.deepEqual(requiredStepsBefore('shipmentUpdate', null), []);
  });

  test('the UI payload carries the steps, so the rule is not re-implemented in the browser', () => {
    const payload = describeLifecycle({ dataUpdate: { label: 'Data update' } });
    const step = payload.stageSteps.find((s) => s.operation === 'dataUpdate');
    assert.ok(step, 'dataUpdate must appear in the lifecycle payload');

    // Pin every key. Task 5 reads these names off the wire, so a rename or a dropped field is a
    // break in a contract no type checker is watching.
    assert.deepEqual(Object.keys(step).sort(), [
      'at', 'before', 'note', 'operation', 'operationLabel', 'requiredFor',
    ]);
    assert.equal(step.at, -2);
    assert.equal(step.before, 'shipmentUpdate');
    assert.equal(step.operationLabel, 'Data update');
    assert.deepEqual(step.requiredFor, ['octo']);
    assert.ok(step.note, 'the note explains the rule to whoever edits the config');
  });

  test('the payload does not hand out the cached model\'s own arrays', () => {
    // loadLifecycle() returns a singleton. Handing back the model's array means a caller that
    // pushes to what it thinks is its own copy rewrites the rule for every later request, with
    // nothing raised to say so.
    const first = describeLifecycle({}).stageSteps.find((s) => s.operation === 'dataUpdate');
    first.requiredFor.push('driveri');

    const second = describeLifecycle({}).stageSteps.find((s) => s.operation === 'dataUpdate');
    assert.deepEqual(second.requiredFor, ['octo'], 'the model was mutated through the payload');
  });
});
