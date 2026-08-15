import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { operationChain, pollingOrder } from './lifecycle.js';

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
