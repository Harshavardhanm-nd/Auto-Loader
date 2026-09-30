/**
 * The allocator never mints an id this app has already minted in the same environment.
 *
 * On 2026-09-29 Salesforce staging was refreshed and lost almost every Asset, while IDMS kept
 * every device it had ever been sent. The collision check asks only Salesforce, so it saw the
 * old ids as free. Counters were then Reset — every series went back to its descriptor's
 * sampleStart, an id copied from a sheet that was already loaded — and the next two runs
 * minted ids IDMS already held: 40 devices, all INITIAL_DEVICE_LOAD_SYNC_FAILED with "asset
 * already exists".
 *
 * The high-water mark is the app's own memory of what it has minted, which survives a sandbox
 * refresh because it lives on this machine rather than in the org. It cannot see ids somebody
 * else loaded into IDMS; nothing in this app can.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { effectiveStart, cursorMoveRefusal, highestMinted } from './id-generator.js';

// --- effectiveStart ---------------------------------------------------------------------------

test('a cursor above the high-water mark is used as-is', () => {
  assert.equal(effectiveStart(250n, 245n), 250n);
});

test('a cursor at or below the high-water mark starts just past it', () => {
  // The 2026-09-29 case: Reset put Driveri back on sampleStart 22600379190 while the app had
  // already minted up to 22600379245.
  assert.equal(effectiveStart(22600379190n, 22600379245n), 22600379246n);
  assert.equal(effectiveStart(245n, 245n), 246n);
});

test('with no history the cursor is used as-is', () => {
  assert.equal(effectiveStart(125000n, null), 125000n);
});

// --- cursorMoveRefusal ------------------------------------------------------------------------

test('moving a cursor past the high-water mark is allowed', () => {
  assert.equal(cursorMoveRefusal({ value: 246n, highWater: 245n, env: 'staging' }), null);
});

test('moving a cursor onto or below an id already minted is refused, naming the mark', () => {
  const reason = cursorMoveRefusal({ value: 22600379190n, highWater: 22600379245n, env: 'staging' });
  assert.match(reason, /22600379245/);
  assert.match(reason, /staging/);
  assert.ok(cursorMoveRefusal({ value: 245n, highWater: 245n, env: 'staging' }));
});

test('with no history any cursor move is allowed', () => {
  assert.equal(cursorMoveRefusal({ value: 1n, highWater: null, env: 'staging' }), null);
});

// --- highestMinted ----------------------------------------------------------------------------

const run = (env, groups, allocations = []) => ({ env, groups, idGeneration: { allocations } });
const group = (family, templateId, rows) => ({ family, templateId, lines: [{ generatedRows: rows }] });

test('the highest id minted is found across runs of that environment only', () => {
  const runs = [
    run('staging', [group('driveri', 'driveri-initial-load', [{ device_id: '22600379236' }, { device_id: '22600379245' }])]),
    run('staging', [group('driveri', 'driveri-initial-load', [{ device_id: '22600379190' }])]),
    run('testing', [group('driveri', 'driveri-initial-load', [{ device_id: '99999999999' }])]),
  ];
  assert.equal(highestMinted(runs, 'staging', 'driveri-initial-load', 'device_id'), 22600379245n);
});

test('ids are compared as numbers, not strings', () => {
  const runs = [run('staging', [group('dms', 'dms-initial-load', [{ serial_number: '99' }, { serial_number: '110001445' }])])];
  assert.equal(highestMinted(runs, 'staging', 'dms-initial-load', 'serial_number'), 110001445n);
});

test('a series typed in by hand is not counter history', () => {
  // Manual ids are the operator's choice — often a real device's serial far from the counter's
  // range. Counting one would silently push the counter out to wherever that value happens to be.
  const runs = [
    run(
      'staging',
      [group('dms', 'dms-initial-load', [{ serial_number: '900000000' }])],
      [{ family: 'dms', manualSeries: ['serial_number'] }]
    ),
  ];
  assert.equal(highestMinted(runs, 'staging', 'dms-initial-load', 'serial_number'), null);
});

test('rows nested under `generated` are read too', () => {
  const runs = [run('staging', [group('dhub', 'dhub-initial-load', [{ generated: { driveri_hub_id: '4011301054' } }])])];
  assert.equal(highestMinted(runs, 'staging', 'dhub-initial-load', 'driveri_hub_id'), 4011301054n);
});

test('malformed runs and values are ignored rather than fatal', () => {
  const runs = [
    null,
    { env: 'staging' },
    run('staging', [group('dhub', 'dhub-initial-load', [{ driveri_hub_id: 'not-a-number' }, {}])]),
  ];
  assert.equal(highestMinted(runs, 'staging', 'dhub-initial-load', 'driveri_hub_id'), null);
});
