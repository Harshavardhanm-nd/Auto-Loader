/**
 * Template-driven CSV generation.
 *
 * Knows nothing about any particular format: the column list, byte rules, filename and
 * every column's value source come from a descriptor in templates/, which was derived
 * column-for-column from a real sheet in the DL Template folder.
 */

import { buildRow, encodeCsv, assertCsvBytes, formatSerialNumberForCsv } from '../lib/bytes.js';
import { isTemplateUsable } from '../lib/config.js';
import { primarySeriesOf } from './id-generator.js';

/**
 * Date rendering. Templates default to the form their column name advertises
 * (YYYY-MM-DD); a template may override via `dateFormat` where a sheet demonstrably
 * needs something else.
 */
export function formatDate(now = new Date(), format = 'YYYY-MM-DD') {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  switch (format) {
    case 'DD/MM/YY':
      return `${d}/${m}/${String(y).slice(2)}`;
    case 'DD-MM-YYYY':
      return `${d}-${m}-${y}`;
    case 'MM/DD/YY':
      return `${m}/${d}/${String(y).slice(2)}`;
    case 'YYYY-MM-DD':
    default:
      return `${y}-${m}-${d}`;
  }
}

export const todayIso = (now = new Date()) => formatDate(now, 'YYYY-MM-DD');

function resolveSource(source, ctx, column, template) {
  if (source === 'empty') return '';
  if (source === 'today') return ctx.today;
  if (source === 'trackingId') return ctx.trackingId;
  if (source.startsWith('const:')) return source.slice('const:'.length);

  const dot = source.indexOf('.');
  if (dot === -1) throw new Error(`Template column "${column.name}": unknown source "${source}"`);
  const scope = source.slice(0, dot);
  const key = source.slice(dot + 1);

  switch (scope) {
    case 'generated': {
      const value = ctx.generated?.[key];
      if (value === undefined) {
        throw new Error(
          `Template column "${column.name}": series "${key}" was not allocated. ` +
            `Template "${template.id}" declares: ${Object.keys(template.series ?? {}).join(', ') || '(none)'}`
        );
      }
      return value;
    }
    case 'existing': {
      // Templates that act on devices from a previous load rather than minting new ones.
      const value = ctx.existing?.[key];
      if (value === undefined) {
        throw new Error(
          `Template column "${column.name}": expected an existing ${key} for this row. ` +
            `"${template.id}" operates on devices from an earlier run — pick that run's devices first.`
        );
      }
      return value;
    }
    case 'field': {
      // Run-level values: the descriptor's defaults, overridden by whatever the user set.
      const value = ctx.fields?.[key] ?? template.defaults?.[key];
      if (value === undefined) {
        throw new Error(
          `Template column "${column.name}": field "${key}" has no value and no default in ` +
            `templates/${template.id}.json`
        );
      }
      return value;
    }
    case 'line': {
      const value = ctx.line?.[key];
      if (value === undefined) {
        throw new Error(`Template column "${column.name}": line.${key} is not available`);
      }
      return value;
    }
    default:
      throw new Error(`Template column "${column.name}": unknown source scope "${scope}"`);
  }
}

/**
 * Build one CSV from a template descriptor.
 *
 * @param {object} template
 * @param {object} args
 * @param {string} args.trackingId  the run's shipment tracking id (also used in filenames)
 * @param {object} args.fields      field overrides on top of the descriptor's defaults
 * @param {Array}  args.rows        one entry per output row: { generated, existing, line }
 * @param {Date}   [args.now]
 * @returns {{filename, uploadAs, buffer, header, rowCount, template}}
 */
export function buildCsv(template, { trackingId, fields = {}, rows, now = new Date(), family = '' }) {
  if (!isTemplateUsable(template)) {
    throw new Error(
      `Template "${template.id}" has status "${template.status}" and cannot be generated. ` +
        (template.awaiting?.what ? `Still needed: ${template.awaiting.what}` : '')
    );
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Template "${template.id}": no rows to write`);
  }

  const columnNames = template.columns.map((c) => c.name);
  const header = columnNames.join(',');
  const today = formatDate(now, template.dateFormat ?? 'YYYY-MM-DD');

  const dataRows = rows.map((row, index) => {
    const ctx = { ...row, fields, trackingId, today };
    const values = template.columns.map((column) => {
      let value = resolveSource(column.source, ctx, column, template);

      if (column.integerOnly) value = formatSerialNumberForCsv(value);

      const asString = value === null || value === undefined ? '' : String(value);

      if (column.required && asString.trim() === '') {
        throw new Error(
          `Template "${template.id}" row ${index + 1}: required column "${column.name}" is empty`
        );
      }
      if (column.noSpaces && /\s/.test(asString)) {
        throw new Error(
          `Template "${template.id}" row ${index + 1}: column "${column.name}" must not contain spaces (got "${asString}")`
        );
      }
      return asString;
    });
    return buildRow(values, columnNames);
  });

  const buffer = encodeCsv([header, ...dataRows], template.bytes);
  assertCsvBytes(buffer, template.bytes, `${template.id} (${template.filenamePattern})`);

  return {
    template: template.id,
    filename: renderFilename(template.filenamePattern, { trackingId, family }),
    uploadAs: template.uploadAs ?? null,
    buffer,
    header,
    rowCount: dataRows.length,
    // Which devices this file actually covers. Derived from the rows that were written rather
    // than from the run, so it cannot drift from the bytes: a shipment update generated for a
    // subset lists that subset, and nothing downstream has to re-derive it and get it wrong.
    deviceIds: deviceIdsOf(template, rows),
  };
}

/**
 * The primary device id of each row.
 *
 * Two row shapes reach here: rows carrying ids this run minted (`generated`), and rows acting on
 * devices an earlier run loaded (`existing`). Templates of the second kind declare no generated
 * column, so `primarySeriesOf` returns null for them and `existing.device_id` is the id.
 */
function deviceIdsOf(template, rows) {
  const primary = primarySeriesOf(template);
  return rows
    .map((row) => row.existing?.device_id ?? (primary ? row.generated?.[primary] : null))
    .filter(Boolean)
    .map(String);
}

export function renderFilename(pattern, values) {
  return pattern.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values?.[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Filename pattern needs a value for {${key}}`);
    }
    return String(value);
  });
}

/**
 * Row plans.
 *
 * A line owns a contiguous block of generated rows, recorded on the line itself when the
 * ids are allocated. Planning reads that assignment rather than inferring it from array
 * position, which keeps it correct when lines are split across templates.
 */
export function planGeneratedRows(lines) {
  const rows = [];
  for (const line of lines) {
    const generated = line.generatedRows ?? [];
    if (generated.length !== line.deviceCount) {
      throw new Error(
        `Line ${line.sku}: ${line.deviceCount} unit(s) requested but ${generated.length} allocated. Regenerate ids.`
      );
    }
    for (const g of generated) rows.push({ generated: g, line });
  }
  return rows;
}

/**
 * Wizard-upload plan: one row per serialized unit the ORDER needs — not per device loaded.
 * These are two different counts and conflating them is what produces a Partially Shipped
 * order that hides the ship button.
 */
export function planWizardRows(lines, primarySeriesName) {
  const rows = [];
  for (const line of lines) {
    const generated = line.generatedRows ?? [];
    if (generated.length < line.quantity) {
      throw new Error(
        `Line ${line.sku}: the order needs ${line.quantity} serial(s) but only ${generated.length} unit(s) were allocated to it. ` +
          'Raise the batch size for this line.'
      );
    }
    for (let i = 0; i < line.quantity; i++) {
      const id = generated[i][primarySeriesName] ?? Object.values(generated[i])[0];
      rows.push({ existing: { device_id: id }, line });
    }
  }
  return rows;
}

/** Plan for templates that act on devices already loaded by an earlier run. */
export function planExistingRows(deviceIds, line = {}) {
  return deviceIds.map((id) => ({ existing: { device_id: String(id) }, line }));
}
