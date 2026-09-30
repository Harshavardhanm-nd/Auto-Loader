/**
 * Watch's read-only Asset views: which devices of this run's initial-load snapshot each tab shows.
 *
 * These are not stages — nothing is polled for them and they own no snapshot. Each is a filter
 * over the rows the initial-load poll already fetched, keyed on the device's own `IDMS_Status__c`
 * (and, for two of them, its `Sync_Status__c`). Pure, so it is tested without a browser.
 *
 * `selectable` marks the views whose devices can be handed to an operation this app sends. A
 * view without one is informational: ticking a device there would lead to a button with nothing
 * to generate.
 *
 * `group` places the tab in Watch's strip: `rma` views sit before the RMA Returned stage tab,
 * `nonRma` after it — the same order a device meets them on the chart — and `dead` is last, so
 * the destructive operation is never adjacent to the ordinary ones.
 */
export const ASSET_VIEW_TABS = [
  { id: 'shippedActive',   label: 'Shipped Active',    title: 'NEW_ORDER_FULFILMENT or IDMS 2 + success', group: 'rma' },
  { id: 'installed',       label: 'Installed',         title: 'IDMS status 4',  group: 'rma' },
  { id: 'rmaPending',      label: 'RMA Pending',       title: 'IDMS status 10', group: 'rma' },
  { id: 'rmaInitiated',    label: 'RMA Initiated',     title: 'IDMS status 5',  group: 'rma', selectable: true },
  { id: 'nonRmaPending',   label: 'Non-RMA Pending',   title: 'IDMS status 11 — out of warranty or contract expired', group: 'nonRma' },
  { id: 'nonRmaInitiated', label: 'Non-RMA Initiated', title: 'IDMS status 6 — Return Initiated Non-RMA', group: 'nonRma', selectable: true },
  { id: 'returnedNonRma',  label: 'Returned Non-RMA',  title: 'IDMS status 8 — back with Netradyne outside warranty', group: 'nonRma', selectable: true },
  { id: 'deadView',        label: 'DEAD',              title: 'Non-Repairable by Repair Partner sync status', group: 'dead', selectable: true },
];

export const ASSET_VIEW_TAB_IDS = new Set(ASSET_VIEW_TABS.map((t) => t.id));

export function isSelectableView(tab) {
  return Boolean(ASSET_VIEW_TABS.find((t) => t.id === tab)?.selectable);
}

// No stage has code 0, so the 0 that null and '' convert to can never match.
const atIdms = (code) => (r) => Number(r.idmsStatus) === code;

// The RMA Returned email has already gone out for this device: the integration has written its
// status, and the IDMS move follows. Both Initiated views leave such a device out, so it cannot
// be ticked and sent back a second time while its stage catches up.
const alreadyReturned = (r) =>
  r.syncStatus === 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER' ||
  r.syncStatus === 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER_SYNC_SUCCESS' ||
  r.syncStatus === 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER_SYNC_FAILED';

export function filterViewRows(rows, tab) {
  if (!rows) return [];
  switch (tab) {
    case 'shippedActive':
      return rows.filter(
        (r) =>
          r.syncStatus === 'NEW_ORDER_FULFILMENT' ||
          r.syncStatus === 'NEW_ORDER_FULFILMENT_SYNC_FAILED' ||
          (Number(r.idmsStatus) === 2 && r.syncStatus === 'NEW_ORDER_FULFILMENT_SYNC_SUCCESS'),
      );
    case 'installed':  return rows.filter(atIdms(4));
    case 'rmaPending': return rows.filter(atIdms(10));
    case 'rmaInitiated':    return rows.filter((r) => atIdms(5)(r) && !alreadyReturned(r));
    // The non-RMA path, 11 → 6 → 8. 11 → 6 is Support raising the return, not an email. 6 → 8 is
    // the same RMA Returned email and sheet as the RMA leg (5 → 7) — confirmed 2026-09-30.
    case 'nonRmaPending':   return rows.filter(atIdms(11));
    case 'nonRmaInitiated': return rows.filter((r) => atIdms(6)(r) && !alreadyReturned(r));
    case 'returnedNonRma':  return rows.filter(atIdms(8));
    case 'deadView':
      return rows.filter(
        (r) =>
          r.syncStatus === 'NON_REPAIRABLE_BY_REPAIR_PARTNER' ||
          r.syncStatus === 'NON_REPAIRABLE_BY_REPAIR_PARTNER_SYNC_FAILED' ||
          (r.syncStatus === 'NON_REPAIRABLE_BY_REPAIR_PARTNER_SYNC_SUCCESS' && Number(r.idmsStatus) === 9),
      );
    default: return [];
  }
}
