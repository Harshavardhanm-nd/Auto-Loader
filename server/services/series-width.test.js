import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRows, primarySeriesOf } from './id-generator.js';
import { TEMPLATES_DIR } from '../lib/paths.js';

/**
 * A descriptor must accept its own `sampleStart`.
 *
 * Every `sampleStart` in `templates/` was copied off a sheet the Apex parser accepted, so it is
 * the one id per series this app *knows* the org takes. That makes it a free oracle: if a
 * descriptor's width rule rejects its own sampleStart, the rule is wrong — no Salesforce round
 * trip needed to prove it.
 *
 * This is the invariant that blocked every VBUS send on 2026-09-03. Commit `a719755` set out to
 * relax the width checks for VBUS, Haptic and Driveri. For `mac_id` it did, with `anyLength`. For
 * `serial_number` it instead moved `digits` 10 → 11 and added `unbounded` — and those two compose
 * into `^\d{11,}$`, an eleven-digit *floor*, where the rule had been exactly ten. VBUS serials are
 * ten digits (`1100401221` on the accepted sheet), so every row of every VBUS run failed
 * validation as a blocker and no VBUS file could be sent at all.
 *
 * Note the trap in the flag pair, since it is easy to repeat: `unbounded` lifts the *ceiling*
 * (`numericCeiling` → Infinity) and `anyLength` drops the *width check*. Reaching for `unbounded`
 * to loosen validation tightens it instead, whenever `digits` moves up with it.
 */

function descriptors() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8')));
}

describe('a descriptor accepts the ids its own sheet was written with', () => {
  for (const template of descriptors()) {
    const series = template.series ?? {};
    if (!Object.keys(series).length) continue;

    test(`${template.id}: every sampleStart passes its own series' rule`, () => {
      // One row holding each series at the value the accepted sheet opened on.
      const row = {};
      for (const [name, def] of Object.entries(series)) {
        assert.ok(def.sampleStart, `${template.id}.${name} declares no sampleStart`);
        row[name] = String(def.sampleStart);
      }

      const problems = validateRows([row], series, primarySeriesOf(template));
      assert.deepEqual(problems, [], `${template.id} rejects its own sampleStart`);
    });
  }
});

describe('the VBUS serial that was blocked', () => {
  test('a ten-digit VBUS serial is accepted by both VBUS descriptors', () => {
    for (const id of ['vbus-initial-load', 'vbus-shipment-update']) {
      const template = JSON.parse(
        fs.readFileSync(path.join(TEMPLATES_DIR, `${id}.json`), 'utf8')
      );
      // The exact pair the operator's run generated and could not send.
      const row = { serial_number: '1100401264', mac_id: '1100928264' };
      const problems = validateRows([row], template.series, primarySeriesOf(template));
      assert.deepEqual(problems, [], `${id} refused a real ten-digit VBUS serial`);
    }
  });
});
