import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { archiveCurrentSend, sendsForKey } from './run-store.js';

/**
 * No send record is ever overwritten out of existence.
 *
 * `run.sends[key]` holds one object per pipeline, and roughly fifteen readers — the duplicate
 * guard, the Watch tabs, the History page, `summariseRun` — depend on that shape, so it stays as
 * it is: the latest send. What changes is that the record it replaces is appended to
 * `run.sendHistory[key]` rather than dropped.
 *
 * This is the gap the 2026-09-03 incident exposed. Thirty-one emails went out for ten intended
 * sends, but each delivery overwrote the last, so the run afterwards showed exactly one send per
 * pipeline. Six real loads of the same devices were invisible in the run; only the event log
 * still knew. A send record is evidence that devices reached the org — losing one loses the
 * only structured account of a load that actually happened.
 */

const send = (ids, at) => ({ ok: true, deviceIds: ids, sentAt: at, filename: 'f.csv' });

describe('archiving a send', () => {
  test('the replaced record is kept, not dropped', () => {
    const run = { sends: { 'shipmentUpdate:vbus': send(['1'], 't1') } };
    archiveCurrentSend(run, 'shipmentUpdate:vbus');
    assert.equal(run.sendHistory['shipmentUpdate:vbus'].length, 1);
    assert.deepEqual(run.sendHistory['shipmentUpdate:vbus'][0].deviceIds, ['1']);
  });

  test('repeated sends accumulate in order, oldest first', () => {
    const run = { sends: {}, sendHistory: {} };
    for (const t of ['t1', 't2', 't3']) {
      run.sends['shipmentUpdate:vbus'] = send(['1100401265'], t);
      archiveCurrentSend(run, 'shipmentUpdate:vbus');
    }
    assert.deepEqual(
      run.sendHistory['shipmentUpdate:vbus'].map((s) => s.sentAt),
      ['t1', 't2', 't3']
    );
  });

  test('archiving when nothing has been sent is a no-op', () => {
    const run = { sends: {} };
    assert.equal(archiveCurrentSend(run, 'shipmentUpdate:vbus'), false);
    assert.equal(run.sendHistory?.['shipmentUpdate:vbus'], undefined);
  });

  test('a record with no deviceIds falls back rather than archiving an unusable one', () => {
    // The guard can only reason about a send whose devices it knows; an archived record with no
    // ids blocks every later send for the key on principle.
    const run = { sends: { 'initialLoad:vbus': { ok: true, sentAt: 't1' } } };
    archiveCurrentSend(run, 'initialLoad:vbus', { fallbackDeviceIds: ['1100401265'] });
    assert.deepEqual(run.sendHistory['initialLoad:vbus'][0].deviceIds, ['1100401265']);
  });

  test('other pipelines are untouched', () => {
    const run = {
      sends: { 'shipmentUpdate:vbus': send(['1'], 't1'), 'shipmentUpdate:haptic': send(['2'], 't1') },
    };
    archiveCurrentSend(run, 'shipmentUpdate:vbus');
    assert.equal(run.sendHistory['shipmentUpdate:haptic'], undefined);
    assert.ok(run.sends['shipmentUpdate:haptic']);
  });
});

describe('reading the full record for a pipeline', () => {
  test('history then the current send, oldest first', () => {
    const run = {
      sends: { 'shipmentUpdate:vbus': send(['1'], 't3') },
      sendHistory: { 'shipmentUpdate:vbus': [send(['1'], 't1'), send(['1'], 't2')] },
    };
    assert.deepEqual(sendsForKey(run, 'shipmentUpdate:vbus').map((s) => s.sentAt), ['t1', 't2', 't3']);
  });

  test('a pipeline that was sent once reads as one send', () => {
    const run = { sends: { 'initialLoad:dhub': send(['4011301093'], 't1') } };
    assert.equal(sendsForKey(run, 'initialLoad:dhub').length, 1);
  });

  test('a pipeline never sent reads as empty', () => {
    assert.deepEqual(sendsForKey({ sends: {} }, 'initialLoad:dhub'), []);
  });

  test('the six-email burst would read as six', () => {
    const run = {
      sends: { 'shipmentUpdate:haptic': send(['125006'], 't6') },
      sendHistory: {
        'shipmentUpdate:haptic': ['t1', 't2', 't3', 't4', 't5'].map((t) => send(['125006'], t)),
      },
    };
    assert.equal(sendsForKey(run, 'shipmentUpdate:haptic').length, 6);
  });
});
