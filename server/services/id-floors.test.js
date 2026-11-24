/**
 * A machine that has never run this app must not mint ids that are already loaded.
 *
 * Counters and run history live in `data/`, which is not in git, so a fresh clone used to start
 * every series at its template's `sampleStart` — an id loaded long ago. Two shared sources now
 * stop that: `config/id-floors.json`, committed, which remembers what IDMS holds through a sandbox
 * refresh; and the highest id the org itself holds in the series' band, read at allocation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { floorFor, allocateSeries } from './id-generator.js';
import { highestInBandSoql, highestNumeric, SERIES_FIELD } from './sf-client.js';
import { loadTemplates, loadEnvironments } from '../lib/config.js';
import { CONFIG_DIR } from '../lib/paths.js';

const FLOORS = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'id-floors.json'), 'utf8'));

describe('config/id-floors.json', () => {
  const minting = loadTemplates().filter((t) => t.operation === 'initialLoad' && t.series);

  for (const env of Object.keys(loadEnvironments().environments)) {
    test(`${env} — every series a product type mints has a floor that fits its width`, () => {
      for (const tpl of minting) {
        for (const [name, def] of Object.entries(tpl.series)) {
          if (def.type === 'prefixed') continue;
          const floor = floorFor(FLOORS, env, tpl.family, name);
          assert.ok(floor !== null, `${env} has no floor for ${tpl.family}:${name} — a fresh clone would start at sampleStart`);
          if (!def.unbounded) {
            assert.ok(String(floor).length <= def.digits, `${env} ${tpl.family}:${name} floor ${floor} is wider than ${def.digits} digits`);
          }
        }
      }
    });
  }

  test('no floor names a product type or series that does not exist', () => {
    const known = new Set(minting.flatMap((t) => Object.keys(t.series).map((s) => `${t.family}:${s}`)));
    for (const [env, floors] of Object.entries(FLOORS)) {
      if (env === '$comment') continue;
      for (const key of Object.keys(floors)) assert.ok(known.has(key), `${env}: "${key}" matches no minted series`);
    }
  });

  test('a floor is looked up per environment and product type, or null', () => {
    const floors = { testing: { 'dhub:driveri_hub_id': '4011600001' } };
    assert.equal(floorFor(floors, 'testing', 'dhub', 'driveri_hub_id'), 4011600001n);
    assert.equal(floorFor(floors, 'staging', 'dhub', 'driveri_hub_id'), null);
    assert.equal(floorFor(floors, 'testing', 'dms', 'serial_number'), null);
    assert.equal(floorFor(floors, 'testing', null, 'driveri_hub_id'), null);
  });
});

describe('the highest id the org holds in a band', () => {
  test('the band keeps the length and the leading half of the digits', () => {
    assert.match(highestInBandSoql('Name', '1250730322'), /Name LIKE '12507_____'/);
    assert.match(highestInBandSoql('Name', '125013'), /Name LIKE '125___'/);
    assert.match(highestInBandSoql('SIM_Serial__c', '98765432300'), /SIM_Serial__c LIKE '987654_____'/);
  });

  test("Octo's band does not reach the DMS cameras, nor its camera band the KFOB beacons", () => {
    // Testing holds 15 DMS cameras at 1252400146–160 and KFOB beacons at 70333797 / 70110254.
    const octo = highestInBandSoql('Name', '1250730322').match(/LIKE '([^']+)'/)[1];
    const cam = highestInBandSoql('Name', '70007322').match(/LIKE '([^']+)'/)[1];
    const like = (p, v) => new RegExp(`^${p.replace(/_/g, '.')}$`).test(v);
    assert.ok(!like(octo, '1252400160'));
    assert.ok(!like(cam, '70333797') && !like(cam, '70110254'));
  });

  test('only a non-id field is refused', () => {
    assert.throws(() => highestInBandSoql('Account.Name', '125013'));
    assert.throws(() => highestInBandSoql('Name', "1' OR Name != '"));
  });

  test('the highest value is numeric, of the exact width, compared as a number', () => {
    const records = [{ Name: '4011600005' }, { Name: '40116ABCDE' }, { Name: '4011699' }, { Name: '4011600012' }];
    assert.equal(highestNumeric(records, 'Name', 10), 4011600012n);
    assert.equal(highestNumeric([], 'Name', 10), null);
  });

  test('every minted series knows which Asset field to look in', () => {
    for (const tpl of loadTemplates()) {
      for (const name of Object.keys(tpl.series ?? {})) assert.ok(SERIES_FIELD[name], `${name} has no field`);
    }
  });
});

describe('allocation starts past what the org already holds', () => {
  test('each series starts one past the org highest, offline collision check aside', async () => {
    const series = { serial_number: { type: 'numeric', digits: 9, sampleStart: '700000000' } };
    const seen = [];
    const result = await allocateSeries({
      env: 'test-org-highest',
      templateId: 'org-highest-test',
      series,
      count: 3,
      orgHighest: async (name, start) => {
        seen.push(name);
        return start + 1000n;
      },
    });
    const from = BigInt(result.ranges.serial_number.from);
    assert.deepEqual(seen, ['serial_number']);
    assert.equal(BigInt(result.orgHighest.serial_number) + 1n, from);
  });

  test('an org with nothing in the band leaves the start alone', async () => {
    const series = { serial_number: { type: 'numeric', digits: 9, sampleStart: '700000000' } };
    const result = await allocateSeries({
      env: 'test-org-highest',
      templateId: 'org-highest-empty',
      series,
      count: 1,
      orgHighest: async () => null,
    });
    assert.equal(result.orgHighest.serial_number, null);
  });
});
