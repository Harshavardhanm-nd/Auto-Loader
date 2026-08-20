import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { supersedesRecordedResult, REVISABLE_STATUSES, shouldFinaliseFromSinglePoll } from './poller.js';
import { pollingOrder } from '../lib/lifecycle.js';

/**
 * Whether a settled poll may rewrite the run's headline answer.
 *
 * The rule exists so shipment update wins over initial load: "these devices are live and shippable"
 * outranks "they exist". It was written as `stage === 'shipmentUpdate' || !run.result?.stage`, which
 * says something subtly different — *nothing has been recorded yet* — and that made it a one-shot
 * latch. Re-poll the stage that failed, after the failures are fixed, and the second reading was
 * discarded: the run kept reporting `failedDeviceIds` from the first attempt for ever, so the
 * Runbar kept saying "Part failed" over a run where every device had since succeeded.
 */
describe('when a settled poll supersedes the recorded result', () => {
  test('the first result for a run is always recorded', () => {
    assert.equal(supersedesRecordedResult('initialLoad', null), true);
    assert.equal(supersedesRecordedResult('shipmentUpdate', undefined), true);
  });

  test('re-polling the same stage replaces its own earlier reading', () => {
    // This is the bug: a fixed failure must be able to clear itself.
    assert.equal(supersedesRecordedResult('initialLoad', 'initialLoad'), true);
    assert.equal(supersedesRecordedResult('shipmentUpdate', 'shipmentUpdate'), true);
  });

  test('a later stage supersedes an earlier one', () => {
    assert.equal(supersedesRecordedResult('shipmentUpdate', 'initialLoad'), true);
    assert.equal(supersedesRecordedResult('received', 'shipmentUpdate'), true);
    assert.equal(supersedesRecordedResult('dataUpdate', 'initialLoad'), true);
  });

  test('an earlier stage never undoes a later one', () => {
    // The property the original guard was protecting, and it must survive the fix.
    assert.equal(supersedesRecordedResult('initialLoad', 'shipmentUpdate'), false);
    assert.equal(supersedesRecordedResult('initialLoad', 'received'), false);
    assert.equal(supersedesRecordedResult('dataUpdate', 'shipmentUpdate'), false);
  });

  test('an off-chain stage never overwrites a chain result', () => {
    // rmaReturned is pollable but is not on the load chain, so it is not the run's headline.
    assert.ok(!pollingOrder().includes('rmaReturned'), 'precondition: rmaReturned is off-chain');
    assert.equal(supersedesRecordedResult('rmaReturned', 'shipmentUpdate'), false);
    assert.equal(supersedesRecordedResult('rmaReturned', 'rmaReturned'), true, 'but it may refresh its own');
  });

  test('the rank comes from pollingOrder, not a hardcoded list', () => {
    // If the chain is corrected in lifecycle.json, this precedence must move with it.
    const order = pollingOrder();
    for (let i = 1; i < order.length; i += 1) {
      assert.equal(supersedesRecordedResult(order[i], order[i - 1]), true, `${order[i]} over ${order[i - 1]}`);
      assert.equal(supersedesRecordedResult(order[i - 1], order[i]), false, `${order[i - 1]} not over ${order[i]}`);
    }
  });
});

describe('which run statuses a later poll may revise', () => {
  test('a status derived from an earlier poll is revisable', () => {
    // The parallel latch: `else if (status === draft || status === sent)` meant that once a run
    // read `initial-load-partial` it matched neither branch and could never be revised.
    assert.ok(REVISABLE_STATUSES.has('initial-load-partial'));
    assert.ok(REVISABLE_STATUSES.has('initial-load-done'));
    assert.ok(REVISABLE_STATUSES.has('draft'));
    assert.ok(REVISABLE_STATUSES.has('sent'));
  });

  test('a completed run is not downgraded by re-polling an earlier stage', () => {
    assert.ok(!REVISABLE_STATUSES.has('completed'));
    assert.ok(!REVISABLE_STATUSES.has('completed-with-failures'));
  });
});

/**
 * When a single (non-loop) poll may write the run's headline answer.
 *
 * `pollOnce` never finalised at all, so the run's result could only ever be written by a polling
 * loop reaching settled. That left the latch fix half-effective: an operator who fixes the failed
 * devices and clicks "Refresh from org" still saw the old verdict, because a refresh was not
 * allowed to revise it.
 *
 * Two things must stay true. A refresh only finalises when **asked** — Watch tops a tab up in the
 * background on activation, and clicking between tabs must never silently mark a run complete. And
 * it only finalises when the poll is **settled**, exactly as the loop does: the headline means
 * "this is the answer", so writing one while devices are still in flight would report a verdict
 * over an unfinished batch.
 */
describe('whether one poll may finalise the run', () => {
  test('an explicit refresh of a settled batch finalises', () => {
    assert.equal(shouldFinaliseFromSinglePoll(true, true), true);
  });

  test('a background top-up never finalises, settled or not', () => {
    assert.equal(shouldFinaliseFromSinglePoll(false, true), false);
    assert.equal(shouldFinaliseFromSinglePoll(false, false), false);
  });

  test('an explicit refresh mid-flight does not write a verdict', () => {
    assert.equal(shouldFinaliseFromSinglePoll(true, false), false);
  });

  test('a missing flag is treated as background', () => {
    // The route reads this off the request body; an old client sending nothing must not finalise.
    assert.equal(shouldFinaliseFromSinglePoll(undefined, true), false);
  });
});
