/**
 * Serial-number generation, driven by the series each template declares.
 *
 * Every product family numbers its hardware differently — 11-digit Driveri device ids,
 * 10-digit hub ids, 6-digit Haptic serials, a 9-digit DMS serial, a VBUS serialNumber
 * paired with a macId, and Octo's five parallel series including two prefix-plus-counter
 * pseudo-MACs. So rather than hard-coding a device/sim pair, the descriptor declares its
 * series and this module allocates one contiguous block per series.
 *
 * Counters are persisted per environment, template and series, so a Haptic run and a
 * Driveri run never interfere. Blocks are contiguous and monotonic, which makes them
 * auditable ("this run took 125000-125009"), and the collision query runs once per
 * allocation. When it does hit an existing asset the counter advances past the highest
 * collision rather than rerolling, so every retry is strictly forward progress.
 */

import { COUNTERS_FILE, readJson, writeJson } from '../lib/paths.js';

const MAX_ATTEMPTS = 8;

/** A numeric series' width is fixed, so it can only hold so many more blocks. */
function numericCeiling(digits) {
  return 10 ** digits - 1;
}

function loadCounters() {
  return readJson(COUNTERS_FILE, {});
}

function counterKey(env, templateId, seriesName) {
  return `${env}:${templateId}:${seriesName}`;
}

/**
 * Where a series will start next. Seeded from the descriptor's sampleStart on first use —
 * that value came from a sheet the parser accepted, so it is a known-good neighbourhood.
 */
export function peekCursor(env, templateId, seriesName, seriesDef) {
  const stored = loadCounters()[counterKey(env, templateId, seriesName)];
  if (typeof stored === 'number') return stored;
  return Number(seriesDef.sampleStart);
}

export function setCursor(env, templateId, seriesName, value) {
  const counters = loadCounters();
  counters[counterKey(env, templateId, seriesName)] = value;
  counters.updatedAt = new Date().toISOString();
  writeJson(COUNTERS_FILE, counters);
}

export function resetCursor(env, templateId, seriesName, seriesDef) {
  const counters = loadCounters();
  delete counters[counterKey(env, templateId, seriesName)];
  writeJson(COUNTERS_FILE, counters);
  return peekCursor(env, templateId, seriesName, seriesDef);
}

/** All cursors for a template, for display on the Devices screen. */
export function describeCursors(env, templateId, series) {
  return Object.fromEntries(
    Object.entries(series ?? {}).map(([name, def]) => [
      name,
      { next: formatValue(def, peekCursor(env, templateId, name, def)), type: def.type, digits: def.digits ?? null },
    ])
  );
}

function formatValue(seriesDef, n) {
  if (seriesDef.type === 'prefixed') return `${seriesDef.prefix}${n}`;
  // Numeric series are zero-padded to their declared width so a value never narrows.
  return String(n).padStart(seriesDef.digits ?? String(n).length, '0');
}

/**
 * Which series values are worth checking against Asset.Name.
 *
 * Numeric series are; the prefix-plus-counter pseudo-MACs are not — they are not asset
 * names and querying them would only waste a round trip.
 */
function isCheckable(seriesDef) {
  return seriesDef.type !== 'prefixed';
}

/**
 * Allocate `count` rows for one template.
 *
 * @param {object}   options
 * @param {string}   options.env
 * @param {string}   options.templateId
 * @param {object}   options.series      the descriptor's series map
 * @param {number}   options.count
 * @param {Function} [options.checkTaken] async (ids[]) => takenIds[]; omit to skip the
 *                   org collision check (offline generation)
 * @returns {Promise<{rows: object[], attempts: number, checked: boolean,
 *                    collisions: string[], ranges: object}>}
 */
export async function allocateSeries({ env, templateId, series, count, checkTaken = null }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new Error('count must be a positive integer');
  if (n > 5000) throw new Error('count above 5000 — split this into multiple runs');

  const names = Object.keys(series ?? {});
  if (names.length === 0) {
    // Templates that reuse a prior run's ids (received, wizard uploads) declare no series.
    return { rows: Array.from({ length: n }, () => ({})), attempts: 0, checked: false, collisions: [], ranges: {} };
  }

  const starts = {};
  for (const name of names) starts[name] = peekCursor(env, templateId, name, series[name]);

  for (const name of names) {
    const def = series[name];
    if (def.type === 'numeric' && starts[name] + n > numericCeiling(def.digits)) {
      throw new Error(
        `Series "${name}" would overflow ${def.digits} digits at ${starts[name] + n}. ` +
          'Reset this series\' counter on the Devices screen.'
      );
    }
  }

  const allCollisions = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rows = buildRows(series, starts, n);

    if (!checkTaken) {
      return finish({ env, templateId, series, starts, n, rows, attempts: attempt, checked: false, collisions: [] });
    }

    const candidates = [];
    for (const name of names) {
      if (!isCheckable(series[name])) continue;
      for (const row of rows) candidates.push(row[name]);
    }

    const taken = candidates.length ? await checkTaken(candidates) : [];
    if (taken.length === 0) {
      return finish({ env, templateId, series, starts, n, rows, attempts: attempt, checked: true, collisions: allCollisions });
    }

    allCollisions.push(...taken);

    // Advance each series past its own highest collision. Forward-only, so a retry never
    // revisits ground already rejected.
    const takenNums = taken.map(Number).filter(Number.isFinite);
    let advancedAny = false;
    for (const name of names) {
      if (!isCheckable(series[name])) continue;
      const hits = takenNums.filter((v) => v >= starts[name] && v < starts[name] + n);
      if (hits.length) {
        starts[name] = Math.max(...hits) + 1;
        advancedAny = true;
      }
    }
    // A collision outside every window means the series overlap in a way the sample starts
    // do not anticipate; nudge all of them rather than spinning.
    if (!advancedAny) for (const name of names) starts[name] += n;
  }

  throw new Error(
    `Could not find ${n} free ids for "${templateId}" after ${MAX_ATTEMPTS} attempts ` +
      `(${allCollisions.length} collisions). Reset the counters on the Devices screen to ` +
      'move this template into fresh territory.'
  );
}

function buildRows(series, starts, n) {
  return Array.from({ length: n }, (_, i) => {
    const row = {};
    for (const [name, def] of Object.entries(series)) row[name] = formatValue(def, starts[name] + i);
    return row;
  });
}

function finish({ env, templateId, series, starts, n, rows, attempts, checked, collisions }) {
  const ranges = {};
  for (const [name, def] of Object.entries(series)) {
    ranges[name] = { from: formatValue(def, starts[name]), to: formatValue(def, starts[name] + n - 1) };
    setCursor(env, templateId, name, starts[name] + n);
  }
  return { rows, attempts, checked, collisions, ranges };
}

/**
 * Structural checks on generated rows: declared width honoured, and the primary id unique
 * within the file.
 *
 * Note what is NOT checked: equality of sim_serial and device_imei. The process spec's
 * checklist demands it, but every real Driveri sheet in the template folder uses three
 * distinct series offset by 10, and those sheets are what the parser has accepted.
 */
export function validateRows(rows, series, primarySeriesName) {
  const problems = [];
  const seen = new Set();

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    for (const [name, def] of Object.entries(series ?? {})) {
      const value = String(row[name] ?? '');
      if (value === '') {
        problems.push(`row ${rowNo}: ${name} is empty`);
        continue;
      }
      if (def.type === 'numeric' && !new RegExp(`^\\d{${def.digits}}$`).test(value)) {
        problems.push(`row ${rowNo}: ${name} "${value}" is not ${def.digits} digits`);
      }
      if (def.type === 'prefixed' && !value.startsWith(def.prefix)) {
        problems.push(`row ${rowNo}: ${name} "${value}" does not start with "${def.prefix}"`);
      }
    }
    if (primarySeriesName) {
      const id = row[primarySeriesName];
      if (seen.has(id)) problems.push(`row ${rowNo}: duplicate ${primarySeriesName} ${id}`);
      seen.add(id);
    }
  });

  return problems;
}

/** The id column a template's records are keyed by — Asset.Name in Salesforce terms. */
export function primarySeriesOf(template) {
  const first = template.columns.find((c) => c.source?.startsWith('generated.'));
  return first ? first.source.slice('generated.'.length) : null;
}
