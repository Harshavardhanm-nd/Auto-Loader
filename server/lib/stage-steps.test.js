import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { operationChain, pollingOrder, requiredStepsBefore, describeLifecycle, operationOrder } from './lifecycle.js';

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

/**
 * The order operations are *listed in* — the tab strips on Review and Watch.
 *
 * A stage step runs at a stage without moving the device, so it has no movement to sort on. Both
 * lists sorted it to the end: Watch ranked each tab by the stage its operation moves the device
 * *to* and defaulted a step to 99, and Review used the raw key order of `config/environments.json`.
 * Data update therefore appeared *after* Shipment update in both, which is the reverse of the order
 * a device actually meets them — `stageSteps` declares `before: "shipmentUpdate"`, and Octo owes
 * the data update before it ships.
 *
 * `operationOrder` is the one answer both lists use: the polling chain first, in chain order, then
 * everything else in the order it was declared.
 */
describe('the order operations are listed in', () => {
  const CONFIG_ORDER = [
    'initialLoad', 'updateLoad', 'shipmentUpdate', 'dataUpdate', 'received',
    'nonRepairable', 'faultyReturned', 'wizardUpload', 'rmaReturned', 'deviceDead', 'undoDead',
  ];

  test('a stage step is listed before the operation it precedes', () => {
    const order = operationOrder(CONFIG_ORDER);
    assert.ok(
      order.indexOf('dataUpdate') < order.indexOf('shipmentUpdate'),
      `data update must come first: ${order.join(' ')}`
    );
  });

  test('the chain itself keeps the order a device meets it', () => {
    const order = operationOrder(CONFIG_ORDER);
    const chain = order.filter((id) => pollingOrder().includes(id));
    assert.deepEqual(chain, pollingOrder());
  });

  test('the pollable tabs come out in chart order', () => {
    // Exactly what the Watch stage strip renders, before its view tabs are interleaved.
    const pollable = ['initialLoad', 'shipmentUpdate', 'dataUpdate', 'received', 'rmaReturned'];
    assert.deepEqual(operationOrder(pollable), [
      'initialLoad', 'dataUpdate', 'shipmentUpdate', 'received', 'rmaReturned',
    ]);
  });

  test('operations off the chain keep the order they were declared in', () => {
    // Their relative order is a config decision, not a lifecycle one — nothing should reshuffle it.
    const order = operationOrder(CONFIG_ORDER);
    const offChain = order.filter((id) => !pollingOrder().includes(id));
    assert.deepEqual(offChain, CONFIG_ORDER.filter((id) => !pollingOrder().includes(id)));
  });

  test('every id given comes back exactly once', () => {
    const order = operationOrder(CONFIG_ORDER);
    assert.equal(order.length, CONFIG_ORDER.length);
    assert.deepEqual([...order].sort(), [...CONFIG_ORDER].sort());
  });

  test('the chain is pulled to the front, ahead of operations that are not on it', () => {
    // The one visible consequence beyond data update: `updateLoad` is declared second in
    // environments.json and sorts after `received`, because it is not on the walk this app drives.
    // It has **no template in any family** (its sheet was re-pointed at dataUpdate), so it is
    // mailbox-only — filtered out of Review by `anySupported` and absent from Watch, which lists
    // only pollable operations. Nothing on screen moves.
    const order = operationOrder(CONFIG_ORDER);
    assert.ok(order.indexOf('received') < order.indexOf('updateLoad'));
    assert.deepEqual(order.slice(0, 4), pollingOrder());
  });

  test('a list with only the step does not lose it', () => {
    assert.deepEqual(operationOrder(['dataUpdate']), ['dataUpdate']);
  });

  test('empty and unknown ids are not an error', () => {
    assert.deepEqual(operationOrder([]), []);
    assert.deepEqual(operationOrder(['whatever', 'dataUpdate']), ['dataUpdate', 'whatever']);
  });

  test('the caller\'s array is not reordered underneath it', () => {
    const input = [...CONFIG_ORDER];
    operationOrder(input);
    assert.deepEqual(input, CONFIG_ORDER, 'operationOrder must not sort in place');
  });
});
