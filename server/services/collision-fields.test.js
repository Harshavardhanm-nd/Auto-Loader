import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COLLISION_FIELDS, takenFromRecords, collisionChunkSize } from './sf-client.js';
import { TEMPLATES_DIR } from '../lib/paths.js';

/**
 * The collision check has to look wherever a minted id can land on the Asset.
 *
 * This is the invariant that broke a real VBUS load on 2026-08-15. The run generated
 * `serialNumber 1100401222 / macId 1100928221`, and the org rejected it:
 *
 *     Following VBUSs Data have duplicate Values.
 *     macId(required)   1100928221   1100401222<>1100401221
 *
 * A VBUS device loaded in May already held `Wifi_Mac__c = 1100928221`. The allocator never saw it,
 * because the query asked only about Name, SIM_Serial__c and Device_IMEI__c. The serial advanced
 * past its collision (it lives in `Name`, which *is* checked) while the mac sat at its start value
 * — the two series moving differently is the signature of this bug.
 */

describe('the fields a collision is looked for in', () => {
  test('covers every Asset field a minted series lands in', () => {
    for (const field of ['Name', 'SIM_Serial__c', 'Device_IMEI__c', 'Wifi_Mac__c']) {
      assert.ok(COLLISION_FIELDS.includes(field), `${field} must be collision-checked`);
    }
  });

  test('includes Wifi_Mac__c, where a VBUS mac_id lands', () => {
    // Named on its own because this is the one that was missing. `mac_id` is minted by both VBUS
    // descriptors and is written to Wifi_Mac__c by the parser — verified against testing.
    assert.ok(COLLISION_FIELDS.includes('Wifi_Mac__c'));
  });

  test('every numeric series in every descriptor has somewhere to be caught', () => {
    // A cheap guard against adding a series with no corresponding Asset field: if a new series
    // name appears that is not in this map, this test fails and someone has to decide where its
    // values land rather than discovering it from a rejected load.
    const SERIES_TO_FIELD = {
      device_id: 'Name',
      driveri_hub_id: 'Name',
      serial_number: 'Name',
      sim_serial: 'SIM_Serial__c',
      device_imei: 'Device_IMEI__c',
      mac_id: 'Wifi_Mac__c',
      // Octo's accessories become Assets in their own right, keyed by Name.
      wired_speaker_serial: 'Name',
      native_cam_serial: 'Name',
    };

    const minted = new Set();
    for (const file of fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json'))) {
      const descriptor = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
      for (const name of Object.keys(descriptor.series ?? {})) minted.add(name);
    }

    for (const series of minted) {
      const field = SERIES_TO_FIELD[series];
      assert.ok(field, `series "${series}" has no known Asset field — where do its values land?`);
      assert.ok(
        COLLISION_FIELDS.includes(field),
        `series "${series}" lands in ${field}, which is not collision-checked`
      );
    }
  });
});

describe('reading taken ids out of the query result', () => {
  test('a value held in Wifi_Mac__c counts as taken', () => {
    // The exact record that broke the VBUS load.
    const records = [
      { Name: '1100401221', SIM_Serial__c: null, Device_IMEI__c: null, Wifi_Mac__c: '1100928221' },
    ];
    const taken = takenFromRecords(records, ['1100401222', '1100928221']);
    assert.deepEqual(taken.sort(), ['1100928221']);
  });

  test('only values that were asked about come back', () => {
    // A matched Asset carries its own values in the other fields too. Returning those told the
    // allocator to skip ids nobody had taken.
    const records = [
      { Name: '1100401221', SIM_Serial__c: '999', Device_IMEI__c: '888', Wifi_Mac__c: '1100928221' },
    ];
    assert.deepEqual(takenFromRecords(records, ['1100401221']), ['1100401221']);
  });

  test('a value taken in more than one field is reported once', () => {
    const records = [{ Name: '55', Serial__c: '55', Wifi_Mac__c: '55' }];
    assert.deepEqual(takenFromRecords(records, ['55']), ['55']);
  });

  test('empty input is not an error', () => {
    assert.deepEqual(takenFromRecords([], ['1']), []);
    assert.deepEqual(takenFromRecords([{ Name: '1' }], []), []);
  });
});

describe('query size', () => {
  test('the chunk size keeps the URL under Salesforce\'s limit for every field checked', () => {
    // One OR clause per field, so widening the field list has to shrink the chunk. An id is ~11
    // digits plus quotes and a comma; the encoded URL is what actually hits the 8 KB ceiling.
    const chunk = collisionChunkSize();
    const perId = "'12345678901',".length;
    const estimated = COLLISION_FIELDS.length * chunk * perId;
    assert.ok(estimated < 6000, `estimated ${estimated} bytes of IN lists is too close to the limit`);
    assert.ok(chunk >= 25, 'chunking this small would make allocation needlessly chatty');
  });
});
