import { fetchAssetsByDeviceId } from './sf-client.js';
import { classifyStage } from '../lib/lifecycle.js';

// An Octo device's `run.accessories[deviceId]` record names up to two other Assets — a wired
// speaker and a native camera — by their own serial. Both are optional per device.
const ACCESSORY_KINDS = [
  { field: 'wiredSpeaker', type: 'Wired Speaker' },
  { field: 'nativeCam', type: 'Native Camera' },
];

/** Every accessory serial named on the run's accessories record — what to fetch from Salesforce. */
export function accessorySerialsFor(accessoriesRecord) {
  if (!accessoriesRecord) return [];
  const serials = [];
  for (const acc of Object.values(accessoriesRecord)) {
    for (const { field } of ACCESSORY_KINDS) {
      if (acc[field]) serials.push(acc[field]);
    }
  }
  return serials;
}

/**
 * Decorate rows with `.accessories`, given the accessories record and the Asset records already
 * fetched for the serials it names. Pure — takes fetched Assets rather than fetching them itself,
 * so it's testable with plain objects and no Salesforce involved. A row with no entry in
 * `accessoriesRecord` (a non-Octo device, or an Octo device with nothing recorded) passes through
 * unchanged; absence of a record is not evidence of a missing accessory.
 */
export function attachAccessories(rows, accessoriesRecord, accessoryAssets) {
  if (!accessoriesRecord || !rows?.length) return rows;
  const byAccessoryId = new Map((accessoryAssets ?? []).map((a) => [String(a.deviceId), a]));

  return rows.map((row) => {
    const acc = accessoriesRecord[row.deviceId];
    if (!acc) return row;

    const deviceAccessories = ACCESSORY_KINDS.filter(({ field }) => acc[field]).map(({ field, type }) => {
      const serialId = acc[field];
      const accAsset = byAccessoryId.get(String(serialId)) ?? null;
      return {
        type,
        serialId,
        present: Boolean(accAsset),
        // An accessory is an Asset in its own right, so its serial links to its own record.
        // Null until the Asset exists — `present: false` and no id are the same fact seen from
        // two sides.
        assetId: accAsset?.id ?? null,
        stage: classifyStage(accAsset?.idmsStatus ?? null),
        syncStatus: accAsset?.syncStatus ?? null,
        assetStatus: accAsset?.assetStatus ?? null,
      };
    });

    return { ...row, accessories: deviceAccessories.length > 0 ? deviceAccessories : undefined };
  });
}

/**
 * Fetch accessory Assets and attach them to rows keyed by `deviceId`. A failed fetch degrades to
 * the rows unenriched rather than surfacing — the same way a device with nothing recorded in
 * `accessoriesRecord` passes through untouched, so a caller's own read is never tainted by this
 * one failing. Callers that gate this behind their own `isOctoRun`/etc. check do so only to skip
 * an unnecessary round trip: an empty or absent `accessoriesRecord` is already a no-op here.
 */
export async function enrichWithAccessories(env, rows, accessoriesRecord) {
  const serials = accessorySerialsFor(accessoriesRecord);
  if (!serials.length || !rows?.length) return rows;
  try {
    const accessoryAssets = await fetchAssetsByDeviceId(env, serials);
    return attachAccessories(rows, accessoriesRecord, accessoryAssets);
  } catch {
    return rows;
  }
}
