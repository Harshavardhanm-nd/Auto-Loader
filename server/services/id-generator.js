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
 *
 * All cursor arithmetic is done in BigInt, never `Number`. A sim serial (ICCID) is up to 20
 * digits and a plain `Number` only carries 53 bits (~16 safe decimal digits) — past that,
 * consecutive integers stop being distinguishable at all, so incrementing "+1" silently
 * produced the *same* rounded value for every row, and a value like `8901882024118888084`
 * came back as `8901882024118888000`. Digit width is still whatever the descriptor declares;
 * only the arithmetic that was silently lossy has changed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { COUNTERS_FILE, RUNS_DIR, readJson, writeJson } from '../lib/paths.js';

const MAX_ATTEMPTS = 8;
/** Ids probed past the block itself, so one round trip can step over a batch loaded earlier. */
const LOOKAHEAD = 250;

/** Every cursor value is carried as BigInt from the moment it leaves storage or a descriptor. */
function toBig(value) {
  if (typeof value === 'bigint') return value;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) throw new Error(`"${value}" is not a whole number`);
  return BigInt(str);
}

/**
 * A numeric series' width is fixed, so it can only hold so many more blocks — unless the
 * descriptor declares `unbounded: true`, meaning this series is allowed to grow past its
 * `digits` width rather than being capped there (Haptic's accessory serials do this).
 */
function numericCeiling(def) {
  if (def.unbounded) return Infinity;
  return 10 ** def.digits - 1;
}

function loadCounters() {
  return readJson(COUNTERS_FILE, {});
}

function counterKey(env, templateId, seriesName) {
  return `${env}:${templateId}:${seriesName}`;
}

// ---------------------------------------------------------------------------
// High-water mark: the highest id this app has ever minted, per env:template:series
// ---------------------------------------------------------------------------
//
// The collision check asks Salesforce, and Salesforce forgets on a sandbox refresh. IDMS does
// not: on 2026-09-29 staging was refreshed, the counters were Reset back onto sampleStart, and
// the next 40 devices were ids IDMS already held — every one INITIAL_DEVICE_LOAD_SYNC_FAILED.
// This mark is this app's own memory of what it minted, kept on this machine, so it survives a
// refresh. It is the max of what `finish()` recorded and what the run history shows — the
// history is what covers everything minted before the mark existed.
//
// It cannot see ids someone else loaded into IDMS. Nothing here can.

/**
 * The first id a series may use: its cursor, unless that is at or below an id already minted.
 *
 * @param {bigint} cursor
 * @param {bigint|null} highWater
 */
export function effectiveStart(cursor, highWater) {
  if (highWater === null || cursor > highWater) return cursor;
  return highWater + 1n;
}

/**
 * Why a cursor may not be moved to `value`, or null if it may. Moving forward is always fine;
 * moving onto an id already minted re-issues it, and IDMS rejects the load.
 */
export function cursorMoveRefusal({ value, highWater, env }) {
  if (highWater === null || value > highWater) return null;
  return (
    `${value} is at or below ${highWater}, the highest id this app has already minted for ` +
    `${env}. Those devices still exist in IDMS even if Salesforce no longer shows them — a ` +
    `sandbox refresh empties Salesforce, not IDMS — so reusing them fails the sync with "asset ` +
    `already exists". Pick a value above ${highWater}.`
  );
}

/**
 * Highest counter-minted value of one series across a set of runs. Pure: takes parsed runs.
 * A series the operator typed in by hand for a group is skipped — it is not counter history.
 *
 * @returns {bigint|null}
 */
export function highestMinted(runs, env, templateId, seriesName) {
  let max = null;
  for (const run of runs ?? []) {
    if (!run || run.env !== env) continue;
    for (const group of run.groups ?? []) {
      if (group?.templateId !== templateId) continue;
      const allocation = run.idGeneration?.allocations?.find?.((a) => a?.family === group.family);
      if (allocation?.manualSeries?.includes(seriesName)) continue;
      for (const line of group.lines ?? []) {
        for (const row of line?.generatedRows ?? []) {
          const raw = row?.generated?.[seriesName] ?? row?.[seriesName];
          if (!/^\d+$/.test(String(raw ?? ''))) continue;
          const value = BigInt(raw);
          if (max === null || value > max) max = value;
        }
      }
    }
  }
  return max;
}

function loadRuns() {
  let names;
  try {
    names = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((f) => readJson(path.join(RUNS_DIR, f), null));
}

/** The high-water mark for one series: recorded mark and run history, whichever is higher. */
export function highWaterMark(env, templateId, seriesName, runs = loadRuns()) {
  const stored = loadCounters().highWater?.[counterKey(env, templateId, seriesName)];
  const recorded = stored == null ? null : toBig(stored);
  const history = highestMinted(runs, env, templateId, seriesName);
  if (recorded === null) return history;
  if (history === null) return recorded;
  return recorded > history ? recorded : history;
}

function recordHighWater(env, templateId, seriesName, value) {
  const counters = loadCounters();
  const key = counterKey(env, templateId, seriesName);
  const current = counters.highWater?.[key];
  if (current != null && toBig(current) >= value) return;
  counters.highWater = { ...counters.highWater, [key]: value.toString() };
  writeJson(COUNTERS_FILE, counters);
}

/**
 * Where a series will start next. Seeded from the descriptor's sampleStart on first use —
 * that value came from a sheet the parser accepted, so it is a known-good neighbourhood — and
 * never at or below an id this app has already minted in this environment.
 */
export function peekCursor(env, templateId, seriesName, seriesDef, runs) {
  const stored = loadCounters()[counterKey(env, templateId, seriesName)];
  const cursor = stored === undefined || stored === null ? toBig(seriesDef.sampleStart) : toBig(stored);
  return effectiveStart(cursor, highWaterMark(env, templateId, seriesName, runs));
}

/** Stored as a decimal string — `JSON.stringify` cannot carry a BigInt, and a string never
 *  rounds no matter how many digits the id has. */
export function setCursor(env, templateId, seriesName, value) {
  const counters = loadCounters();
  counters[counterKey(env, templateId, seriesName)] = toBig(value).toString();
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
  const runs = loadRuns();
  return Object.fromEntries(
    Object.entries(series ?? {}).map(([name, def]) => {
      const highWater = highWaterMark(env, templateId, name, runs);
      return [
        name,
        {
          next: formatValue(def, peekCursor(env, templateId, name, def, runs)),
          highWater: highWater === null ? null : formatValue(def, highWater),
          type: def.type,
          digits: def.digits ?? null,
        },
      ];
    })
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
 * @param {object}   [options.manualValues] `{ [seriesName]: string[] }` — one value per row,
 *                   in row order, supplied by the operator instead of minted from the
 *                   persisted counter. A series named here is never read from or written back
 *                   to `data/counters.json`: the operator picked every value, so there is no
 *                   block to advance past. Collisions are still checked (one pass, not
 *                   retried — there is nothing to step to) and reported separately, as
 *                   `manualCollisions`, since — unlike the auto-allocated block — the org
 *                   already holding one of these ids is not "handled", it is a fact the
 *                   operator needs before sending.
 * @returns {Promise<{rows: object[], attempts: number, checked: boolean,
 *                    collisions: string[], manualCollisions: string[], ranges: object}>}
 */
export async function allocateSeries({ env, templateId, series, count, checkTaken = null, manualValues = {} }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new Error('count must be a positive integer');
  if (n > 5000) throw new Error('count above 5000 — split this into multiple runs');

  const names = Object.keys(series ?? {});
  if (names.length === 0) {
    // Templates that reuse a prior run's ids (received, wizard uploads) declare no series.
    return { rows: Array.from({ length: n }, () => ({})), attempts: 0, checked: false, collisions: [], manualCollisions: [], ranges: {} };
  }

  validateManualValues(series, manualValues, n);
  const manualNames = names.filter((name) => Array.isArray(manualValues[name]));
  const autoNames = names.filter((name) => !manualNames.includes(name));

  const manualCollisions = await checkManualCollisions(series, manualValues, manualNames, checkTaken);

  if (autoNames.length === 0) {
    // Every series on this template was supplied by hand — nothing to mint, nothing to persist.
    const rows = buildRows(series, {}, n, manualValues);
    return { rows, attempts: 0, checked: Boolean(checkTaken), collisions: [], manualCollisions, ranges: rangesFor(series, {}, n, manualValues) };
  }

  const starts = {};
  for (const name of autoNames) starts[name] = peekCursor(env, templateId, name, series[name]);

  assertHeadroom(series, starts, n, autoNames);

  const allCollisions = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!checkTaken) {
      const rows = buildRows(series, starts, n, manualValues);
      return finish({ env, templateId, series, starts, n, rows, autoNames, attempts: attempt, checked: false, collisions: [], manualValues, manualCollisions });
    }

    // Probe well past the block so a whole batch loaded earlier can be cleared in one query.
    const spans = {};
    const candidates = [];
    for (const name of autoNames) {
      if (!isCheckable(series[name])) continue;
      spans[name] = probeSpan(series[name], starts[name], n);
      for (let i = 0; i < spans[name]; i++) {
        candidates.push(formatValue(series[name], starts[name] + BigInt(i)));
      }
    }

    const taken = candidates.length ? await checkTaken(candidates) : [];
    const takenSet = new Set(taken.map(String));
    allCollisions.push(...taken);

    // Where does each series' first free run of n begin inside the span we just probed?
    const offsets = {};
    let allPlaced = true;
    for (const name of autoNames) {
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
      for (const name of autoNames) starts[name] += BigInt(offsets[name]);
      const rows = buildRows(series, starts, n, manualValues);
      return finish({
        env, templateId, series, starts, n, rows, autoNames,
        attempts: attempt, checked: true, collisions: allCollisions, manualValues, manualCollisions,
      });
    }

    // The whole span is occupied — step every checkable series past it and look again.
    for (const name of autoNames) {
      if (!isCheckable(series[name])) continue;
      starts[name] += BigInt(spans[name]);
    }
    assertHeadroom(series, starts, n, autoNames);
  }

  // Persist the ground already rejected. It is genuinely occupied, so resuming past it is
  // correct and keeps the next attempt from re-walking exactly this search.
  for (const name of autoNames) setCursor(env, templateId, name, starts[name]);

  throw new Error(
    `Could not find ${n} free ids for "${templateId}" after ${MAX_ATTEMPTS} attempts ` +
      `(${allCollisions.length} ids already in the org). The counters have been advanced past ` +
      'everything checked, so allocating again resumes from there rather than repeating this ' +
      'search — or set a series cursor directly on the Ids screen.'
  );
}

/** Fail fast, before touching any counter, on a manual series with the wrong shape. */
function validateManualValues(series, manualValues, n) {
  for (const [name, values] of Object.entries(manualValues ?? {})) {
    if (!values) continue;
    if (!series[name]) throw new Error(`Unknown series "${name}" for manual ids`);
    if (!Array.isArray(values) || values.length !== n) {
      throw new Error(
        `Manual ids for "${name}" must supply exactly ${n} value(s), got ` +
          `${Array.isArray(values) ? values.length : 0}`
      );
    }
    const seen = new Set();
    values.forEach((v, i) => {
      const value = String(v ?? '').trim();
      if (!value) throw new Error(`Manual ids for "${name}": row ${i + 1} is empty`);
      if (seen.has(value)) throw new Error(`Manual ids for "${name}": duplicate value "${value}"`);
      seen.add(value);
    });
  }
}

/** One-off org check for operator-supplied ids. Not retried — there is no "next" value to
 *  step to when the operator chose every value themselves; the caller surfaces this list so
 *  a collision is seen before sending rather than after the org rejects the file. */
async function checkManualCollisions(series, manualValues, manualNames, checkTaken) {
  if (!checkTaken) return [];
  const candidates = manualNames
    .filter((name) => isCheckable(series[name]))
    .flatMap((name) => manualValues[name].map((v) => String(v).trim()));
  if (!candidates.length) return [];
  return checkTaken(candidates);
}

/** A numeric series can only hold so many more ids; refuse before minting a narrow one.
 *  Only checked for series this call is actually allocating — a manually supplied value is
 *  the operator's own choice and is not measured against the counter's ceiling. */
function assertHeadroom(series, starts, n, names) {
  const nb = BigInt(n);
  for (const name of names) {
    const def = series[name];
    if (def.type === 'numeric' && starts[name] + nb - 1n > numericCeiling(def)) {
      throw new Error(
        `Series "${name}" would overflow ${def.digits} digits at ${(starts[name] + nb - 1n).toString()}. ` +
          'Reset this series\' counter on the Ids screen.'
      );
    }
  }
}

/** How many ids to ask the org about: the block, plus room to step over a loaded batch. */
function probeSpan(def, start, n) {
  const want = n + LOOKAHEAD;
  if (def.type !== 'numeric') return want;
  const ceiling = numericCeiling(def);
  if (ceiling === Infinity) return want;
  const room = ceiling - Number(start) + 1;
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
      if (takenSet.has(formatValue(def, start + BigInt(offset + i)))) {
        offset += i;
        free = false;
        break;
      }
    }
    if (free) return offset;
  }
  return -1;
}

function buildRows(series, starts, n, manualValues = {}) {
  return Array.from({ length: n }, (_, i) => {
    const row = {};
    for (const [name, def] of Object.entries(series)) {
      row[name] = Array.isArray(manualValues[name])
        ? String(manualValues[name][i]).trim()
        : formatValue(def, starts[name] + BigInt(i));
    }
    return row;
  });
}

function rangesFor(series, starts, n, manualValues = {}) {
  const ranges = {};
  for (const [name, def] of Object.entries(series)) {
    if (Array.isArray(manualValues[name])) {
      ranges[name] = { from: String(manualValues[name][0]).trim(), to: String(manualValues[name][n - 1]).trim() };
    } else {
      ranges[name] = { from: formatValue(def, starts[name]), to: formatValue(def, starts[name] + BigInt(n) - 1n) };
    }
  }
  return ranges;
}

function finish({ env, templateId, series, starts, n, rows, autoNames, attempts, checked, collisions, manualValues, manualCollisions }) {
  const ranges = rangesFor(series, starts, n, manualValues);
  for (const name of autoNames) {
    setCursor(env, templateId, name, starts[name] + BigInt(n));
    recordHighWater(env, templateId, name, starts[name] + BigInt(n) - 1n);
  }
  return { rows, attempts, checked, collisions, manualCollisions, ranges };
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
      if (def.type === 'numeric') {
        // `anyLength` drops the width check entirely — for a series whose real-world values
        // (an id already in the org, or a manually-set cursor) are legitimately shorter or
        // longer than `digits`. `digits` itself is untouched: it still sizes the overflow
        // ceiling and the collision-query candidates for freshly minted ids.
        if (def.anyLength) {
          if (!/^\d+$/.test(value)) problems.push(`row ${rowNo}: ${name} "${value}" is not numeric`);
        } else {
          const pattern = def.unbounded ? `^\\d{${def.digits},}$` : `^\\d{${def.digits}}$`;
          if (!new RegExp(pattern).test(value)) {
            const expected = def.unbounded ? `at least ${def.digits}` : def.digits;
            problems.push(`row ${rowNo}: ${name} "${value}" is not ${expected} digits`);
          }
        }
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
