import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from '../lib/paths.js';
import { claimSend, releaseSend, SEND_CLAIM_TTL_MS } from './run-store.js';

/**
 * One pipeline may have only one send in flight at a time.
 *
 * The duplicate-send guard used to be a check-then-act: the handler read `run.sends[key]`, then
 * `await deliver(...)` for several seconds, then wrote the record. Every request that arrived
 * inside that window read the same "not sent yet" state and passed. On 2026-09-03 a single
 * "Send all" put **31 emails** into the org for 10 intended sends — `shipmentUpdate/haptic` and
 * `shipmentUpdate/vbus` went six times each, six deliveries inside 400ms — and the operator was
 * then told three files had *failed to send*, because the only requests that hit the guard were
 * the last ones to arrive, after a record finally existed.
 *
 * The guard cannot be fixed by checking harder: any check followed by an await has this hole.
 * The claim closes it instead. `updateRun` is a synchronous read-modify-write, so a
 * check-and-set built on it cannot interleave with another request on Node's single thread —
 * which makes this safe against any caller, not just the one client bug that exposed it: a
 * double-clicked button, two browser tabs, or a retry fired over a send still in flight.
 */

const RUN_ID = 'run-test-send-claim';
const runPath = path.join(RUNS_DIR, `${RUN_ID}.json`);

beforeEach(() => {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(
    runPath,
    JSON.stringify({ runId: RUN_ID, env: 'testing', sends: {}, events: [], groups: [] })
  );
});

afterEach(() => {
  fs.rmSync(runPath, { force: true });
});

describe('a send claim', () => {
  test('the first claim on a key succeeds', () => {
    assert.equal(claimSend(RUN_ID, 'shipmentUpdate:vbus'), true);
  });

  test('a second claim on a held key is refused', () => {
    claimSend(RUN_ID, 'shipmentUpdate:vbus');
    assert.equal(claimSend(RUN_ID, 'shipmentUpdate:vbus'), false);
  });

  test('the burst that sent six emails yields exactly one claim', () => {
    // Six requests arriving before any of them finishes delivering — the real 400ms burst.
    const granted = [1, 2, 3, 4, 5, 6].map(() => claimSend(RUN_ID, 'shipmentUpdate:haptic'));
    assert.equal(granted.filter(Boolean).length, 1, 'more than one request would have sent mail');
  });

  test('a different pipeline is not blocked by a held one', () => {
    claimSend(RUN_ID, 'shipmentUpdate:vbus');
    assert.equal(claimSend(RUN_ID, 'shipmentUpdate:haptic'), true);
    assert.equal(claimSend(RUN_ID, 'initialLoad:vbus'), true);
  });

  test('releasing lets the next request through', () => {
    claimSend(RUN_ID, 'shipmentUpdate:vbus');
    releaseSend(RUN_ID, 'shipmentUpdate:vbus');
    assert.equal(claimSend(RUN_ID, 'shipmentUpdate:vbus'), true);
  });

  test('releasing a key that was never claimed is harmless', () => {
    releaseSend(RUN_ID, 'shipmentUpdate:vbus');
    assert.equal(claimSend(RUN_ID, 'shipmentUpdate:vbus'), true);
  });

  test('a claim left behind by a crash expires, so a pipeline cannot wedge forever', () => {
    const t0 = Date.parse('2026-09-03T10:00:00.000Z');
    assert.equal(claimSend(RUN_ID, 'shipmentUpdate:vbus', { now: t0 }), true);
    // Still held one second before the TTL.
    assert.equal(
      claimSend(RUN_ID, 'shipmentUpdate:vbus', { now: t0 + SEND_CLAIM_TTL_MS - 1000 }),
      false
    );
    // Past it, the stale claim is taken over rather than blocking the operator indefinitely.
    assert.equal(
      claimSend(RUN_ID, 'shipmentUpdate:vbus', { now: t0 + SEND_CLAIM_TTL_MS + 1 }),
      true
    );
  });

  test('the claim is persisted on the run, so it survives across requests', () => {
    claimSend(RUN_ID, 'shipmentUpdate:vbus');
    const onDisk = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    assert.ok(onDisk.sending?.['shipmentUpdate:vbus']?.startedAt, 'claim was not written to disk');
  });
});
