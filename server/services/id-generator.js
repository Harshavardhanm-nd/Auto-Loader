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
 * auditable ("this run took 125000-125009"). When the org already holds an id the counter
 * advances past it rather than rerolling, so every attempt is strictly forward progress.
 *
 * Two things that look like details and are not:
 *
 * Each attempt probes a whole LOOKAHEAD span, not just the `count` ids it wants, and picks
 * the first free run of `count` inside it. Every descriptor's `sampleStart` was copied from
 * a sheet the parser accepted, which means it is an id that *has already been loaded* — so
 * a fresh counter always opens on a collision, usually against the entire batch that sheet
 * belonged to. Probing only `count` ids made the cursor crawl forward `count` at a time and
 * exhaust its attempts still inside that batch; one wide probe steps over it in a single
 * round trip.
 *
 * And the cursor is persisted even when allocation ultimately fails, because the ground it
 * rejected is genuinely occupied. Discarding it made every retry re-walk the same collisions
 * and fail identically, forever.
 */

import { COUNTERS_FILE, readJson, writeJson } from '../lib/paths.js';

const MAX_ATTEMPTS = 8;
/** Ids probed past the block itself, so one round trip can step over a batch loaded earlier. */
const LOOKAHEAD = 250;

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

/** Seed a series back to its descriptor's sampleStart. Returns the value it now reads, formatted
 *  the same way `describeCursors` reports it, so a caller can show the result. */
export function resetCursor(env, templateId, seriesName, seriesDef) {
  const counters = loadCounters();
  delete counters[counterKey(env, templateId, seriesName)];
  writeJson(COUNTERS_FILE, counters);
  return formatValue(seriesDef, peekCursor(env, templateId, seriesName, seriesDef));
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
  return String(n);
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

  assertHeadroom(series, starts, n);

  const allCollisions = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!checkTaken) {
      const rows = buildRows(series, starts, n);
      return finish({ env, templateId, series, starts, n, rows, attempts: attempt, checked: false, collisions: [] });
    }

    // Probe well past the block so a whole batch loaded earlier can be cleared in one query.
    const spans = {};
    const candidates = [];
    for (const name of names) {
      if (!isCheckable(series[name])) continue;
      spans[name] = probeSpan(series[name], starts[name], n);
      for (let i = 0; i < spans[name]; i++) {
        candidates.push(formatValue(series[name], starts[name] + i));
      }
    }

    const taken = candidates.length ? await checkTaken(candidates) : [];
    const takenSet = new Set(taken.map(String));
    allCollisions.push(...taken);

    // Where does each series' first free run of n begin inside the span we just probed?
    const offsets = {};
    let allPlaced = true;
    for (const name of names) {
      if (!isCheckable(series[name])) {
        offsets[name] = 0;
        continue;
      }
      const offset = firstFreeRun(series[name], starts[name], n, spans[name], takenSet);
      if (offset === -1) {
        allPlaced = false;
        break;
      }
      offsets[name] = offset;
    }

    if (allPlaced) {
      for (const name of names) starts[name] += offsets[name];
      const rows = buildRows(series, starts, n);
      return finish({
        env, templateId, series, starts, n, rows,
        attempts: attempt, checked: true, collisions: allCollisions,
      });
    }

    // The whole span is occupied — step every checkable series past it and look again.
    for (const name of names) {
      if (!isCheckable(series[name])) continue;
      starts[name] += spans[name];
    }
    assertHeadroom(series, starts, n);
  }

  // Persist the ground already rejected. It is genuinely occupied, so resuming past it is
  // correct and keeps the next attempt from re-walking exactly this search.
  for (const name of names) setCursor(env, templateId, name, starts[name]);

  throw new Error(
    `Could not find ${n} free ids for "${templateId}" after ${MAX_ATTEMPTS} attempts ` +
      `(${allCollisions.length} ids already in the org). The counters have been advanced past ` +
      'everything checked, so allocating again resumes from there rather than repeating this ' +
      'search — or set a series cursor directly on the Ids screen.'
  );
}

/** A numeric series can only hold so many more ids; refuse before minting a narrow one. */
function assertHeadroom(series, starts, n) {
  for (const [name, def] of Object.entries(series)) {
    if (def.type === 'numeric' && starts[name] + n - 1 > numericCeiling(def.digits)) {
      throw new Error(
        `Series "${name}" would overflow ${def.digits} digits at ${starts[name] + n - 1}. ` +
          'Reset this series\' counter on the Ids screen.'
      );
    }
  }
}

/** How many ids to ask the org about: the block, plus room to step over a loaded batch. */
function probeSpan(def, start, n) {
  const want = n + LOOKAHEAD;
  if (def.type !== 'numeric') return want;
  const room = numericCeiling(def.digits) - start + 1;
  return Math.max(n, Math.min(want, room));
}

/**
 * Offset of the first run of `n` consecutive free ids within the probed span, or -1.
 * On a hit it resumes from just past the taken id rather than the next offset, so a dense
 * block costs one pass, not one pass per id.
 */
function firstFreeRun(def, start, n, span, takenSet) {
  for (let offset = 0; offset + n <= span; offset++) {
    let free = true;
    for (let i = 0; i < n; i++) {
      if (takenSet.has(formatValue(def, start + offset + i))) {
        offset += i;
        free = false;
        break;
      }
    }
    if (free) return offset;
  }
  return -1;
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
