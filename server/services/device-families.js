import { getTemplate } from '../lib/config.js';
import { primarySeriesOf } from './id-generator.js';

/**
 * Which family each device id in a run belongs to.
 *
 * A run holds several groups and one group is one family, so the family of a *device* is a fact
 * the run already carries — it is just not written down anywhere a snapshot row can read it. The
 * walk is the same one `runDeviceIds` does: each group's primary series, over every generated row
 * on every line.
 *
 * Needed because the rules that decide what an operator may do next are per family — Octo owes a
 * data update before it ships and nobody else does — while a poll snapshot is per device. Asking
 * "does this *run* contain Octo" is how a mixed run came to hold its Driveri devices back behind
 * Octo's data update.
 */
export function deviceFamilyMap(run) {
  const map = new Map();
  for (const group of run?.groups ?? []) {
    const primary = group.primarySeries ?? primarySeriesOf(getTemplate(group.templateId));
    if (!primary) continue;
    for (const line of group.lines ?? []) {
      for (const row of line.generatedRows ?? []) {
        if (row[primary]) map.set(String(row[primary]), group.family);
      }
    }
  }
  return map;
}

/**
 * Stamp each row with the family that minted its device id.
 *
 * Spreads rather than rebuilds, so anything already attached to a row — accessory enrichment runs
 * over the same rows — survives. A device id the run never minted gets `null`: an unknown must not
 * manufacture a conclusion, and a null family owes no stage step, so it blocks nothing.
 */
export function attachFamilies(rows, familyMap) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => ({ ...row, family: familyMap.get(String(row.deviceId)) ?? null }));
}
