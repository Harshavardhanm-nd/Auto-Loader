/**
 * Which next operation each polled device may be handed to.
 *
 * A stage step is an operation that runs at a stage without moving the device, and whose
 * `requiredFor` names the families that owe it — Octo corrects device data at Pre-Production
 * before it ships, and nobody else does. The rule is per **device**: one Octo group in a run must
 * not hold that run's Driveri devices behind Octo's data update, which is what asking "does this
 * run contain Octo" did.
 *
 * Two buckets come back and a device can be in both:
 *
 * - `dataUpdate` — every device. The format is the family's own initial-load sheet sent to the
 *   data-update mailbox, so every family can take one. Mandatory for the families that owe it,
 *   available to the rest.
 * - `shipmentUpdate` — every device that does not *still* owe the step.
 *
 * "Still" is measured on the device's own `Sync_Status__c`, not on whether an email went out: a
 * send that the integration has not yet acted on has changed nothing in the org, and releasing on
 * it would ship a device whose data was never corrected.
 *
 * Rows are passed through by reference, not rebuilt — the caller reads `deviceId`, `accessories`
 * and `syncStatus` back off them.
 */
export function partitionHandoff(rows, model) {
  const empty = { dataUpdate: [], shipmentUpdate: [] };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  const steps = model?.stageSteps ?? [];
  const successStatus = model?.successStatus ?? {};

  /**
   * The step this device's own family owes before shipment update, or null.
   *
   * A device whose family could not be identified owes nothing: an unknown must not manufacture a
   * conclusion, and blocking work on a guess is worse than one extra click.
   */
  const owed = (row) =>
    steps.find(
      (s) => s.before === 'shipmentUpdate' && (s.requiredFor ?? []).includes(row.family)
    ) ?? null;

  const stillOwes = (row) => {
    const step = owed(row);
    return Boolean(step) && row.syncStatus !== successStatus[step.operation];
  };

  return {
    dataUpdate: rows,
    shipmentUpdate: rows.filter((row) => !stillOwes(row)),
  };
}

/**
 * Split the DEAD tab's ticked devices by what can be done to them.
 *
 * The tab lists both devices on their way to Dead (non-repairable at the repair partner) and
 * devices already there (IDMS 9). The first can be marked dead; only the second can be undone.
 * Offering Mark Dead over an already-dead device, as the tab once did for any selection, does
 * nothing useful; offering Undo Dead over one that is not provably dead would move a live
 * device back to New. So IDMS 9 is required, exactly — an unknown status is never undone.
 *
 * @param {Array<{deviceId: string, idmsStatus: unknown}>} rows  the DEAD tab's rows
 * @param {Set<string>} selectedIds
 * @returns {{undoDead: object[], markDead: object[]}}
 */
export function partitionDeadSelection(rows, selectedIds) {
  const undoDead = [];
  const markDead = [];
  for (const row of rows ?? []) {
    if (!selectedIds.has(row.deviceId)) continue;
    (String(row.idmsStatus) === '9' ? undoDead : markDead).push(row);
  }
  return { undoDead, markDead };
}
