/**
 * Round-trip fidelity: regenerate every real DL template sheet from its descriptor and
 * assert byte equality with the original file.
 *
 * This is the strongest check available on the descriptors. If a column name, its order, a
 * default value, a series' start or a byte rule were wrong, the bytes would differ.
 *
 * Set DL_TEMPLATE_DIR to point at the sheets; the tests skip if the folder is absent so the
 * suite still runs on a machine that only has this repo.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildCsv, planGeneratedRows, planExistingRows, formatDate } from './csv-builder.js';
import { allocateSeries, primarySeriesOf, validateRows, resetCursor } from './id-generator.js';
import { duplicateSendReason } from './validator.js';
import { loadTemplates, getTemplate } from '../lib/config.js';
import { hasBom, lineEndingStats, assertCsvBytes, formatSerialNumberForCsv } from '../lib/bytes.js';

const DL_DIR = process.env.DL_TEMPLATE_DIR || path.join(os.homedir(), 'BSG', 'DL Template');
const haveSheets = fs.existsSync(DL_DIR);

/** Read a sheet and split it the way the generator would. */
function readSheet(file) {
  const raw = fs.readFileSync(path.join(DL_DIR, file));
  const body = hasBom(raw) ? raw.subarray(3) : raw;
  const lines = body.toString('utf8').split('\r\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { raw, header: lines[0], dataLines: lines.slice(1) };
}

/**
 * Build rows for a template using its own sampleStart values, so a regeneration reproduces
 * the source sheet rather than the next block the counter would hand out.
 */
function rowsFromSamples(template, count) {
  return Array.from({ length: count }, (_, i) => {
    const generated = {};
    for (const [name, def] of Object.entries(template.series ?? {})) {
      const n = Number(def.sampleStart) + i;
      generated[name] =
        def.type === 'prefixed'
          ? `${def.prefix}${n}`
          : String(n).padStart(def.digits ?? 0, '0');
    }
    return { generated, line: {} };
  });
}

describe('descriptor headers match their source sheets', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  for (const template of loadTemplates()) {
    test(`${template.id} — header`, () => {
      const { header } = readSheet(template.sourceTemplate);
      assert.equal(template.columns.map((c) => c.name).join(','), header);
    });
  }
});

describe('descriptor byte rules match their source sheets', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  for (const template of loadTemplates()) {
    test(`${template.id} — bytes`, () => {
      const { raw } = readSheet(template.sourceTemplate);
      assert.equal(hasBom(raw), template.bytes.bom, 'BOM');

      const body = hasBom(raw) ? raw.subarray(3) : raw;
      const { crlf, bareLf, bareCr } = lineEndingStats(body);
      assert.equal(bareLf, 0, 'no sheet contains a bare LF');
      assert.equal(bareCr, 0, 'no sheet contains a bare CR');
      assert.ok(crlf > 0, 'every sheet is CRLF');

      const endsWithNewline = body[body.length - 1] === 0x0a;
      assert.equal(endsWithNewline, template.bytes.trailingNewline, 'trailing newline');
    });
  }
});

/**
 * Full regeneration.
 *
 * Every exclusion below is a documented defect in the source sheet, not a shortcut:
 * `rows` bounds the comparison where later rows are Excel-autofilled, `fromRow` skips a
 * hand-edited first row, and `ignoreColumns` names columns the sheet is internally
 * inconsistent about. Each exclusion is asserted separately further down, so a sheet quirk
 * cannot quietly become a generator bug.
 */
const ROUND_TRIP = [
  {
    id: 'driveri-initial-load',
    trackingId: 'B3E110005',
    now: [2026, 1, 1],
    rows: 5,
    why: 'rows 6-10 are Excel-autofilled on system_pn, invoice_number and po_number',
  },
  { id: 'driveri-shipment-update', trackingId: 'B3E110005', now: [2026, 1, 1], rows: 5 },
  {
    id: 'octo-initial-load',
    trackingId: 'NAZ110001',
    now: [2025, 2, 12],
    rows: 10,
    fromRow: 2,
    why: 'row 1 has literal single spaces in six columns that rows 2-10 leave empty',
  },
  {
    id: 'octo-update-load',
    trackingId: 'NAZ110001',
    now: [2025, 2, 12],
    rows: 3,
    fromRow: 2,
    ignoreColumns: ['Wired_Speaker_Serial_No(required)', 'Native_Cam_Serial_No(required)'],
    why: 'row 1 has the same single-space contamination, and the two accessory serial columns are hand-shuffled rather than sequential',
  },
  { id: 'dhub-initial-load', trackingId: 'RTS120011', now: [2026, 1, 1], rows: 10 },
  { id: 'dms-initial-load', trackingId: 'RTS120014', now: [2026, 1, 1], rows: 10 },
  { id: 'haptic-initial-load', trackingId: 'NA', now: [2026, 3, 29], rows: 10 },
  {
    id: 'haptic-shipment-update',
    trackingId: 'T5SE110005',
    now: [2026, 3, 29],
    rows: 8,
    ignoreColumns: ['Manufacturing_Date', 'D2C_shipped_date_(YYYY-MM-DD)'],
    why: 'this sheet writes both dates as DD/MM/YY while the Haptic initial-load sheet writes YYYY-MM-DD for the same columns; the descriptor follows the column name',
  },
  { id: 'vbus-initial-load', trackingId: 'RTS120013', now: [2026, 1, 1], rows: 100 },
];

describe('regenerating a sheet reproduces its rows exactly', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  for (const spec of ROUND_TRIP) {
    const label = [
      `${spec.id} — rows ${spec.fromRow ?? 1}-${spec.rows}`,
      spec.ignoreColumns ? `minus ${spec.ignoreColumns.length} column(s)` : null,
    ]
      .filter(Boolean)
      .join(', ');

    test(label, () => {
      const template = getTemplate(spec.id);
      const { header, dataLines } = readSheet(template.sourceTemplate);
      const [y, m, d] = spec.now;

      const artifact = buildCsv(template, {
        trackingId: spec.trackingId,
        rows: rowsFromSamples(template, spec.rows),
        now: new Date(y, m, d),
      });

      const produced = artifact.buffer.toString('utf8').replace(/^﻿/, '').split('\r\n');
      if (produced[produced.length - 1] === '') produced.pop();

      assert.equal(produced[0], header, 'header');

      const skip = new Set(
        (spec.ignoreColumns ?? []).map((name) => {
          const index = template.columns.findIndex((c) => c.name === name);
          assert.notEqual(index, -1, `ignoreColumns names a column not in ${spec.id}: ${name}`);
          return index;
        })
      );

      for (let i = (spec.fromRow ?? 1) - 1; i < spec.rows; i++) {
        const got = produced[i + 1].split(',');
        const want = dataLines[i].split(',');
        assert.equal(got.length, want.length, `row ${i + 1} field count`);
        for (let c = 0; c < want.length; c++) {
          if (skip.has(c)) continue;
          assert.equal(got[c], want[c], `row ${i + 1}, column "${template.columns[c].name}"`);
        }
      }
    });
  }
});

test('the excluded Octo rows really are contaminated', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  // Justifies fromRow: 2 on both Octo templates.
  for (const file of ['Octo Initial Load NAZ110001.csv', 'Octo Update Load NAZ110001.csv']) {
    const { dataLines } = readSheet(file);
    const row1 = dataLines[0].split(',');
    const row2 = dataLines[1].split(',');
    // sdcard_serial and sdcard_size: a literal space in row 1, genuinely empty in row 2.
    assert.equal(row1[6], ' ', `${file} row 1 sdcard_serial is a space`);
    assert.equal(row2[6], '', `${file} row 2 sdcard_serial is empty`);
  }
});

test('the Octo update sheet really has shuffled accessory serials', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  // Justifies ignoreColumns on octo-update-load: …202, …201, …203 is not a sequence.
  const { dataLines } = readSheet('Octo Update Load NAZ110001.csv');
  const speaker = dataLines.map((l) => l.split(',')[29]);
  assert.deepEqual(speaker, ['3300990202', '3300990201', '3300990203']);
});

test('the two Haptic sheets really disagree on date format', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  // Justifies ignoreColumns on haptic-shipment-update.
  const initial = readSheet('Haptic_Initial_Load.csv').dataLines[0].split(',');
  const shipment = readSheet('Haptic_Shipment_Update.csv').dataLines[0].split(',');
  assert.match(initial[12], /^\d{4}-\d{2}-\d{2}$/, 'initial load writes YYYY-MM-DD');
  assert.match(shipment[12], /^\d{2}\/\d{2}\/\d{2}$/, 'shipment update writes DD/MM/YY');
});

test('the whole Driveri shipment-update sheet is byte-identical', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  // This sheet has no Excel contamination, so the entire file must match byte for byte —
  // BOM, every row, line endings and the absent trailing newline.
  const template = getTemplate('driveri-shipment-update');
  const { raw } = readSheet(template.sourceTemplate);

  const artifact = buildCsv(template, {
    trackingId: 'B3E110005',
    rows: rowsFromSamples(template, 5),
    now: new Date(2026, 1, 1),
  });

  assert.equal(artifact.buffer.toString('hex'), raw.toString('hex'));
  assert.equal(artifact.filename, 'Shipment Update Load_B3E110005.csv');
});

test('the whole VBUS sheet is byte-identical across all 100 rows', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  const template = getTemplate('vbus-initial-load');
  const { raw } = readSheet(template.sourceTemplate);

  const artifact = buildCsv(template, {
    trackingId: 'RTS120013',
    rows: rowsFromSamples(template, 100),
    now: new Date(2026, 1, 1),
  });

  assert.equal(artifact.buffer.toString('hex'), raw.toString('hex'));
});

test('the Excel autofill contamination in the Driveri initial-load sheet is real', { skip: !haveSheets && 'DL Template folder not found' }, () => {
  // Documenting why that sheet is only compared for its first 5 rows: a part number and an
  // invoice number increment per unit from row 6, which cannot be intentional.
  const { dataLines } = readSheet('Initial Load_B3E110005.csv');
  const systemPn = (line) => line.split(',')[20];
  const invoice = (line) => line.split(',')[24];

  assert.equal(systemPn(dataLines[0]), '901-1-02282');
  assert.equal(systemPn(dataLines[4]), '901-1-02282', 'constant through row 5');
  assert.equal(systemPn(dataLines[5]), '901-1-02283', 'starts incrementing at row 6');
  assert.equal(systemPn(dataLines[9]), '901-1-02287');
  assert.equal(invoice(dataLines[5]), 'INV010102');
});

describe('generation invariants', () => {
  test('every descriptor declares byte rules the encoder accepts', () => {
    for (const template of loadTemplates()) {
      const probe = Buffer.concat([
        template.bytes.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
        Buffer.from(`a,b${template.bytes.lineEnding}1,2${template.bytes.trailingNewline ? template.bytes.lineEnding : ''}`, 'utf8'),
      ]);
      assert.ok(assertCsvBytes(probe, template.bytes, template.id));
    }
  });

  test('every generated column maps to a declared series', () => {
    for (const template of loadTemplates()) {
      const declared = Object.keys(template.series ?? {});
      for (const column of template.columns) {
        if (!column.source.startsWith('generated.')) continue;
        const name = column.source.slice('generated.'.length);
        assert.ok(
          declared.includes(name),
          `${template.id}: column "${column.name}" wants series "${name}", declared: [${declared}]`
        );
      }
    }
  });

  test('every field column has a default', () => {
    for (const template of loadTemplates()) {
      for (const column of template.columns) {
        if (!column.source.startsWith('field.')) continue;
        const key = column.source.slice('field.'.length);
        assert.ok(
          template.defaults && key in template.defaults,
          `${template.id}: column "${column.name}" wants field "${key}" with no default`
        );
      }
    }
  });

  test('every filename placeholder is one the builder can fill', () => {
    for (const template of loadTemplates()) {
      const placeholders = [...template.filenamePattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const p of placeholders) {
        assert.equal(p, 'trackingId', `${template.id}: unsupported filename placeholder {${p}}`);
      }
    }
  });

  test('a template that reuses existing devices declares no series', () => {
    for (const template of loadTemplates()) {
      if (!template.reusesExistingDevices) continue;
      assert.equal(
        Object.keys(template.series ?? {}).length,
        0,
        `${template.id} reuses existing devices, so it must not mint new ids`
      );
    }
  });
});

describe('id allocation', () => {
  // Counters persist to disk by design, so each test clears its own before running —
  // otherwise a second `npm test` would start where the first left off.
  const fresh = (templateId, series) => {
    for (const [name, def] of Object.entries(series)) {
      resetCursor('test-alloc', templateId, name, def);
    }
    return { env: 'test-alloc', templateId, series };
  };

  test('allocates one contiguous block per declared series', async () => {
    const template = getTemplate('octo-initial-load');
    const result = await allocateSeries({
      ...fresh('octo-test', template.series),
      count: 4,
    });

    assert.equal(result.rows.length, 4);
    // All five numeric series plus the two prefixed ones.
    assert.deepEqual(Object.keys(result.rows[0]).sort(), Object.keys(template.series).sort());

    // Numeric series are contiguous and width-preserving.
    assert.equal(result.rows[0].device_id.length, 9);
    assert.equal(Number(result.rows[3].device_id) - Number(result.rows[0].device_id), 3);

    // Prefixed series keep their prefix and case.
    assert.ok(result.rows[0].wifi_mac.startsWith('1c:ce:51:b1:05:c'));
    assert.ok(result.rows[0].bt_mac.startsWith('1C:CE:51:B1:05:C'));

    assert.equal(validateRows(result.rows, template.series, 'device_id').length, 0);
  });

  test('the counter advances past a collision instead of rerolling', async () => {
    const series = { serial_number: { type: 'numeric', digits: 6, sampleStart: '500000' } };
    const taken = new Set(['500000', '500001']);
    let queries = 0;

    const result = await allocateSeries({
      ...fresh('collide-test', series),
      count: 2,
      checkTaken: async (ids) => {
        queries++;
        return ids.filter((id) => taken.has(id));
      },
    });

    assert.equal(result.rows[0].serial_number, '500002', 'moved past both taken ids');
    assert.equal(queries, 1, 'the lookahead span covers the collisions and the free run after them');
    assert.ok(result.collisions.length > 0);
  });

  test('a dense block of taken ids is cleared without exhausting the attempts', async () => {
    // What the real org looks like: every descriptor's sampleStart is an id from a sheet that
    // was already loaded, so a fresh counter opens on top of that whole batch.
    const series = { serial_number: { type: 'numeric', digits: 9, sampleStart: '401130100' } };
    const taken = new Set();
    for (let i = 401130100; i <= 401130137; i++) taken.add(String(i));
    let queries = 0;

    const result = await allocateSeries({
      ...fresh('dense-test', series),
      count: 2,
      checkTaken: async (ids) => {
        queries++;
        return ids.filter((id) => taken.has(id));
      },
    });

    assert.equal(result.rows[0].serial_number, '401130138', 'landed on the first free id past the block');
    assert.equal(result.attempts, 1, 'one wide probe, not a crawl');
    assert.equal(queries, 1);
  });

  test('a failed allocation still advances the counter, so a retry does not repeat it', async () => {
    // Everything within reach is taken. The attempt fails, but the ground it rejected is
    // genuinely occupied, so the next call must resume past it rather than re-walk it.
    const series = { serial_number: { type: 'numeric', digits: 9, sampleStart: '700000000' } };
    const windows = [];

    const attempt = () =>
      allocateSeries({
        env: 'exhaust-test',
        templateId: 'exhaust-test',
        series,
        count: 2,
        checkTaken: async (ids) => {
          windows.push(Number(ids[0]));
          return ids; // every probed id is taken
        },
      });

    for (const [name, def] of Object.entries(series)) resetCursor('exhaust-test', 'exhaust-test', name, def);

    await assert.rejects(attempt(), /Could not find 2 free ids/);
    const firstRun = [...windows];
    windows.length = 0;

    await assert.rejects(attempt(), /Could not find 2 free ids/);

    assert.ok(
      windows[0] > firstRun[firstRun.length - 1],
      `retry resumed at ${windows[0]}, past the ${firstRun[firstRun.length - 1]} the first run reached`
    );
  });

  test('a series refuses to overflow its digit width', async () => {
    await assert.rejects(
      allocateSeries({
        ...fresh('overflow-test', { s: { type: 'numeric', digits: 4, sampleStart: '9998' } }),
        count: 10,
      }),
      /would overflow 4 digits/
    );
  });

  test('templates with no series still yield rows', async () => {
    const result = await allocateSeries({
      env: 'test-alloc',
      templateId: 'received-load',
      series: {},
      count: 3,
    });
    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.ranges, {});
  });

  test('primarySeriesOf finds the id column each family is keyed by', () => {
    assert.equal(primarySeriesOf(getTemplate('driveri-initial-load')), 'device_id');
    assert.equal(primarySeriesOf(getTemplate('dhub-initial-load')), 'driveri_hub_id');
    assert.equal(primarySeriesOf(getTemplate('haptic-initial-load')), 'serial_number');
    assert.equal(primarySeriesOf(getTemplate('vbus-initial-load')), 'serial_number');
    assert.equal(primarySeriesOf(getTemplate('received-load')), null);
  });
});

describe('templates that operate on an earlier run', () => {
  test('received-load consumes existing device ids', () => {
    const template = getTemplate('received-load');
    const artifact = buildCsv(template, {
      trackingId: 'NDA110043',
      rows: planExistingRows(['25731244657', '25731244658']),
      now: new Date(2024, 10, 22),
    });

    const lines = artifact.buffer.toString('utf8').replace(/^﻿/, '').split('\r\n');
    assert.equal(lines[0], 'device_id(required),Date Received(YYYY-MM-DD),Tracking#,shipment_to_3pl(required),device_category(required)');
    assert.equal(lines[1], '25731244657,2024-11-22,NDA110043,DCL,NAMZ');
    assert.equal(artifact.filename, 'Received Load NDA110043.csv');
  });

  test('order-load reproduces its sheet and has no BOM', () => {
    const template = getTemplate('order-load');
    const artifact = buildCsv(template, {
      trackingId: 'unused',
      rows: [{ existing: { device_id: '110001401' }, line: { sku: 'ACCCM1DMSCAM' } }],
    });

    assert.equal(hasBom(artifact.buffer), false, 'the real order_load.csv carries no BOM');
    assert.equal(artifact.buffer.toString('utf8'), 'SKU,Serial_Number\r\nACCCM1DMSCAM,110001401');
  });

  test('partner-order-load reproduces its sheet and does have a BOM', () => {
    const template = getTemplate('partner-order-load');
    const artifact = buildCsv(template, {
      trackingId: 'unused',
      rows: [{ existing: { device_id: '22600379190' }, line: {} }],
    });

    assert.ok(hasBom(artifact.buffer), 'the real partner_order_load.csv carries a BOM');
    assert.equal(
      artifact.buffer.subarray(3).toString('utf8'),
      'Device_Type,Serial_Number\r\nDriveri,22600379190'
    );
  });

  test('a template needing an existing device id says so instead of inventing one', () => {
    assert.throws(
      () => buildCsv(getTemplate('received-load'), { trackingId: 'X', rows: [{ line: {} }] }),
      /operates on devices from an earlier run/
    );
  });
});

describe('guard rails', () => {
  test('field overrides beat descriptor defaults', () => {
    const template = getTemplate('haptic-initial-load');
    const artifact = buildCsv(template, {
      trackingId: 'NA',
      fields: { device_region: 'IN', po_number: 'POIN1947' },
      rows: rowsFromSamples(template, 1),
    });
    const fields = artifact.buffer.toString('utf8').replace(/^﻿/, '').split('\r\n')[1].split(',');
    assert.equal(fields[5], 'IN');
    assert.equal(fields[15], 'POIN1947');
  });

  test('a missing tracking id is refused rather than written as blank', () => {
    const template = getTemplate('driveri-initial-load');
    assert.throws(
      () => buildCsv(template, { trackingId: '', rows: rowsFromSamples(template, 1) }),
      /required column "shipment_tracking_id\(required\)" is empty/
    );
  });

  test('a required field blanked by the user is refused', () => {
    const template = getTemplate('driveri-initial-load');
    assert.throws(
      () => buildCsv(template, { trackingId: 'B3E110005', fields: { product_type: '' }, rows: rowsFromSamples(template, 1) }),
      /required column "product_type\(required\)" is empty/
    );
  });

  test('a SKU with a space is refused by the wizard upload', () => {
    assert.throws(
      () =>
        buildCsv(getTemplate('order-load'), {
          trackingId: 'x',
          rows: [{ existing: { device_id: '1' }, line: { sku: 'ACC CM1' } }],
        }),
      /must not contain spaces/
    );
  });

  test('Excel-mangled serials are repaired or rejected, never guessed', () => {
    assert.equal(formatSerialNumberForCsv('23259776084'), '23259776084');
    assert.equal(formatSerialNumberForCsv('23259776084.000'), '23259776084');
    assert.throws(() => formatSerialNumberForCsv('2.32598E+10'), /scientific notation/);
    assert.throws(() => formatSerialNumberForCsv('23,259,776,084'), /separators/);
    assert.throws(() => formatSerialNumberForCsv('23259776084.5'), /not an integer/);
  });

  test('a comma inside a field is refused rather than silently quoted', () => {
    const template = getTemplate('haptic-initial-load');
    assert.throws(
      () => buildCsv(template, { trackingId: 'NA', fields: { batch_number: 'Batch 02, rev B' }, rows: rowsFromSamples(template, 1) }),
      /contains a comma/
    );
  });

  test('the two counts stay independent: batch of 5, wizard upload of 1', () => {
    const template = getTemplate('driveri-initial-load');
    const line = {
      sku: 'K2I132USASI10Y4S',
      quantity: 1,
      deviceCount: 5,
      generatedRows: rowsFromSamples(template, 5).map((r) => r.generated),
    };

    const initialLoad = buildCsv(template, { trackingId: 'B3E110005', rows: planGeneratedRows([line]) });
    assert.equal(initialLoad.rowCount, 5, 'the initial load is a manufacturer batch');

    const wizard = buildCsv(getTemplate('order-load'), {
      trackingId: 'B3E110005',
      rows: [{ existing: { device_id: line.generatedRows[0].device_id }, line }],
    });
    assert.equal(wizard.rowCount, 1, 'the upload must equal the order line quantity');
  });

  test('date formats render as declared', () => {
    const d = new Date(2026, 4, 20);
    assert.equal(formatDate(d, 'YYYY-MM-DD'), '2026-05-20');
    assert.equal(formatDate(d, 'DD/MM/YY'), '20/05/26');
    assert.equal(formatDate(d, 'DD-MM-YYYY'), '20-05-2026');
  });
});

/**
 * The duplicate-send guard.
 *
 * Its job is stopping a *device* being loaded twice, which is not the same as stopping a key
 * being reused. Half a batch pushed forward, then the other half, is two legitimate emails to
 * one mailbox; refusing the second stalls the flow with no way past but force.
 */
describe('duplicate send detection', () => {
  const sent = (ids, extra = {}) => ({
    ok: true,
    to: 'Asset-Shipped-From-MFR-Testing@netradyne.com',
    sentAt: '2026-08-07T10:00:00.000Z',
    deviceIds: ids,
    ...extra,
  });
  const file = (ids) => ({ filename: 'Shipment_Update_DHUB_RTS120011.csv', deviceIds: ids });

  test('nothing sent yet is never a duplicate', () => {
    assert.equal(duplicateSendReason({ artifact: file(['1', '2']) }), null);
  });

  test('the other half of a batch is a new send, not a repeat', () => {
    const reason = duplicateSendReason({
      currentSend: undefined,
      archivedSends: [sent(['1'])],
      artifact: file(['2']),
    });
    assert.equal(reason, null, 'device 2 has never been sent for this operation');
  });

  test('the same device again is refused, and named', () => {
    const reason = duplicateSendReason({ currentSend: sent(['1']), artifact: file(['1']) });
    assert.match(reason, /already sent for this operation/);
    assert.match(reason, /\b1\b/);
  });

  test('a partial overlap is refused — one repeated device is still a double load', () => {
    const reason = duplicateSendReason({
      archivedSends: [sent(['1', '2'])],
      artifact: file(['2', '3']),
    });
    assert.match(reason, /1 device\(s\)/);
    assert.match(reason, /\b2\b/);
  });

  test('every superseded send counts, not just the most recent', () => {
    const reason = duplicateSendReason({
      archivedSends: [sent(['1']), sent(['2'])],
      currentSend: sent(['3']),
      artifact: file(['1']),
    });
    assert.match(reason, /already sent/, 'the first send must still block, two regenerations later');
  });

  test('an unknown device list falls back to blocking, never to allowing', () => {
    // Records written before artifacts carried ids. Refusing a legitimate send is recoverable;
    // a silent double load is not.
    const noIdsOnSend = duplicateSendReason({
      currentSend: sent(undefined),
      artifact: file(['1']),
    });
    assert.match(noIdsOnSend, /cannot be checked for overlap/);

    const noIdsOnFile = duplicateSendReason({
      currentSend: sent(['1']),
      artifact: { filename: 'x.csv', deviceIds: [] },
    });
    assert.match(noIdsOnFile, /cannot be checked for overlap/);
  });

  test('a send that failed does not block a retry', () => {
    const reason = duplicateSendReason({
      currentSend: { ...sent(['1']), ok: false },
      artifact: file(['1']),
    });
    assert.equal(reason, null);
  });
});
