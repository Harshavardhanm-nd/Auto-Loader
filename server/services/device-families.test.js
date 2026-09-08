import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deviceFamilyMap, attachFamilies } from './device-families.js';

/** A run group as `run.groups[]` holds it, with ids already minted onto its lines. */
const group = (family, templateId, ids, primarySeries = 'device_id') => ({
  family,
  templateId,
  primarySeries,
  lines: [{ generatedRows: ids.map((id) => ({ [primarySeries]: id })) }],
});

describe('device families', () => {
  test('maps every minted id to the family that minted it', () => {
    const run = { groups: [group('octo', 'octo-initial-load', ['1', '2'])] };
    assert.deepEqual([...deviceFamilyMap(run)], [['1', 'octo'], ['2', 'octo']]);
  });

  test('a mixed run keeps each group on its own family', () => {
    const run = {
      groups: [
        group('octo', 'octo-initial-load', ['1', '2']),
        group('driveri', 'driveri-initial-load', ['3']),
      ],
    };
    const map = deviceFamilyMap(run);
    assert.equal(map.get('1'), 'octo');
    assert.equal(map.get('3'), 'driveri');
  });

  test('reads the primary series off the template when the group omits it', () => {
    const run = {
      groups: [
        {
          family: 'vbus',
          templateId: 'vbus-initial-load',
          lines: [{ generatedRows: [{ serial_number: '900' }] }],
        },
      ],
    };
    assert.equal(deviceFamilyMap(run).get('900'), 'vbus');
  });

  test('stamps each row with its own family', () => {
    const map = new Map([['1', 'octo'], ['3', 'driveri']]);
    const rows = attachFamilies([{ deviceId: '1' }, { deviceId: '3' }], map);
    assert.deepEqual(rows.map((r) => r.family), ['octo', 'driveri']);
  });

  test('a row whose id the run never minted gets a null family, not a guess', () => {
    // An unknown must not manufacture a conclusion — the same rule positionInChain follows for a
    // status it cannot place. A null family owes no stage step and blocks nothing.
    const rows = attachFamilies([{ deviceId: '99' }], new Map());
    assert.equal(rows[0].family, null);
  });

  test('keeps every other field on the row it decorates', () => {
    // Accessory enrichment runs alongside this; rebuilding rows would drop what it attached.
    const rows = attachFamilies(
      [{ deviceId: '1', syncStatus: 'DATA_UPDATE_SYNC_SUCCESS', accessories: [{ present: true }] }],
      new Map([['1', 'octo']])
    );
    assert.equal(rows[0].syncStatus, 'DATA_UPDATE_SYNC_SUCCESS');
    assert.deepEqual(rows[0].accessories, [{ present: true }]);
  });

  test('no rows is not an error', () => {
    assert.deepEqual(attachFamilies(null, new Map()), null);
    assert.deepEqual(attachFamilies([], new Map()), []);
  });
});
