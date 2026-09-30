/**
 * Undo Dead — the sheet that moves a device from IDMS 9 (Dead) back to 1 (New).
 *
 * The descriptor follows the one accepted sheet we have, `UndoDead.csv` (supplied 2026-09-30),
 * not the column list that came with the request: the sheet is `device_id, Device Type,
 * UndoDead Reason, AccountId` with no `Productcode`, and it spells the first reason
 * "Lost & Found at Inventory" with a capital I. Where the two disagree, the sheet is what the
 * Apex parser has actually accepted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getTemplate } from '../lib/config.js';
import { buildCsv, planUndoDeadRows } from './csv-builder.js';

const DL_DIR = process.env.DL_TEMPLATE_DIR || path.join(os.homedir(), 'BSG', 'DL Template');
const template = getTemplate('undo-dead');

const sampleRow = { deviceId: '1100401843', deviceType: 'VBUS', accountId: '001cW00000WSprlQAD' };
const build = (reason, entries = [sampleRow]) =>
  buildCsv(template, {
    trackingId: 'B3E110005',
    fields: reason === undefined ? {} : { undo_dead_reason: reason },
    rows: planUndoDeadRows(entries),
    family: 'VBUS',
  });

test(
  'regenerating the accepted sheet reproduces it byte for byte',
  { skip: !fs.existsSync(path.join(DL_DIR, template.sourceTemplate)) && 'sample sheet not found' },
  () => {
    const expected = fs.readFileSync(path.join(DL_DIR, template.sourceTemplate));
    const { buffer } = build('Lost & Found at Inventory');
    assert.equal(buffer.toString('hex'), expected.toString('hex'));
  }
);

test('the filename carries the tracking id, so two Undo Dead files in one run cannot collide', () => {
  assert.equal(build('Requested by CSM').filename, 'Undo_Dead_VBUS_B3E110005.csv');
});

test('every declared reason is accepted', () => {
  const reasons = template.columns.find((c) => c.name === 'UndoDead Reason').allowedValues;
  assert.deepEqual(reasons, [
    'Lost & Found at Inventory',
    'Requested by CSM',
    'Requested by Customer',
    'Requested by VVDN',
  ]);
  for (const reason of reasons) assert.doesNotThrow(() => build(reason));
});

test('a reason outside the list is refused, naming the allowed values', () => {
  // The case matters: the sheet spells it "Inventory", and the parser may too.
  assert.throws(() => build('Lost & Found at inventory'), /Lost & Found at Inventory.*Requested by VVDN/s);
});

test('no reason is refused — there is deliberately no default', () => {
  assert.throws(() => build(undefined), /undo_dead_reason/);
});

test('a device with no AccountId is refused by name rather than written blank', () => {
  assert.throws(
    () =>
      planUndoDeadRows([
        sampleRow,
        { deviceId: '4011500001', deviceType: 'DHUB', accountId: null },
        { deviceId: '4011500002', deviceType: 'DHUB', accountId: '  ' },
      ]),
    /4011500001.*4011500002/s
  );
});
