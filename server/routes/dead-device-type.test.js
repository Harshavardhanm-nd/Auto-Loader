import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadTemplates } from '../lib/config.js';
import { resolveDeadDeviceType, DEAD_DEVICE_TYPES } from './runs.js';

/**
 * The Dead sheet's `Device Type` column accepts six values and nothing else. The value is derived
 * from the group's family — not from the Asset, despite what `device-dead.json`'s own note says —
 * so every family a run can carry must map onto that vocabulary.
 *
 * `octo` did not. The map was written when there were five families and Octo arrived later, and
 * because the resolver returned its input for anything unmapped, an Octo Dead file carried the
 * literal string `octo` with nothing to announce it. This walks the real descriptors so the next
 * family added cannot repeat it.
 */
describe('the Dead sheet device type', () => {
  const families = [...new Set(Object.values(loadTemplates()).map((t) => t.family))]
    .filter((f) => f !== 'shared')
    .sort();

  test('every family in the templates folder maps to an allowed value', () => {
    assert.ok(families.length >= 6, `expected the real families, got ${families.join(', ')}`);
    for (const family of families) {
      const resolved = resolveDeadDeviceType(family);
      assert.ok(
        DEAD_DEVICE_TYPES.has(resolved),
        `family "${family}" resolved to "${resolved}", which the Dead sheet does not accept`,
      );
    }
  });

  test('octo is a Driveri device, because that is what the org calls a D810', () => {
    assert.equal(resolveDeadDeviceType('octo'), 'Driveri');
  });

  test('the five original families keep the values they always had', () => {
    assert.equal(resolveDeadDeviceType('driveri'), 'Driveri');
    assert.equal(resolveDeadDeviceType('dhub'), 'DHUB');
    assert.equal(resolveDeadDeviceType('dms'), 'DMS');
    assert.equal(resolveDeadDeviceType('vbus'), 'VBUS');
    assert.equal(resolveDeadDeviceType('haptic'), 'HAPTIC');
  });

  test('an unmapped family is refused, never passed through', () => {
    // Passing the input through is what made the Octo omission silent: a wrong CSV, no error.
    // A blocked generate is recoverable; a Dead file the parser mishandles is not.
    assert.throws(() => resolveDeadDeviceType('newfamily'), /newfamily/);
  });

  test('a missing family is refused rather than guessed at', () => {
    // This used to default to HAPTIC — a guess about a physical device. It is unreachable from the
    // Dead route today, since runDeviceIds and the id→family map walk the same rows, but a guess
    // that becomes reachable later must fail loudly rather than mislabel a device.
    assert.throws(() => resolveDeadDeviceType(null), /family/i);
  });
});
