# Data update: ordering, per-family requirement, and Octo completeness

**Date:** 2026-08-15
**Status:** approved, ready for implementation planning

## The ask

1. Data update comes **before** shipment update.
2. It is **mandatory for Octo**, optional for other families.
3. For Octo, a device may not proceed until **it and its related assets are synced**.

## Why this is not a small change

`dataUpdate` is a step that does not move the device: it sits at IDMS `-2` before and after. The
stage graph in `config/lifecycle.json` currently expresses that as a **self-loop** — a transition
`from: -2, to: -2` — inserted above the `-2 → -1` shipment arrow by `73fe338`.

`operationChain()` walks that graph with `transitions.find((t) => t.from === stage && t.operation)`,
taking the **first match in array order**. From `-2` it finds `dataUpdate`, follows it back to `-2`,
and halts on its own `seen` guard. Verified live:

```
operationChain() -> ["initialLoad", "dataUpdate"]
```

`shipmentUpdate` and `received` have fallen off the chain. The consequence is in `positionInChain`
(`sf-client.js`): `chain.indexOf(stage)` is `-1` for both, so it returns `'unknown'` before it looks
at the device. For those two stages `behindStage` can never be true and `aheadOfStage` falls back
entirely to a numeric IDMS comparison added later — the guard that stops a device being counted as
loaded when it has not had the operation applied is **switched off**.

Six `lifecycle.test.js` assertions currently fail because of this. They are correct; the code is
wrong. **This design must make them pass without being edited** — that is the check on whether the
modelling is right.

It also means requirement 1 cannot be met by reordering the array. The representation itself is
wrong.

## Design

### 1. `dataUpdate` leaves `transitions`, and is declared as a stage step

`transitions` returns to being a pure movement graph — every entry moves a device from one stage to
a different one. Stage-preserving operations are declared separately:

```json
"stageSteps": [
  {
    "operation": "dataUpdate",
    "at": -2,
    "before": "shipmentUpdate",
    "requiredFor": ["octo"],
    "note": "Octo corrects device data at Pre-Production before shipping. Other families with a
             data-update sheet may run it; families without one cannot."
  }
]
```

- `at` — the stage the device is at while this runs, and stays at.
- `before` — the movement operation it precedes, which is what "comes before shipment update" means.
- `requiredFor` — families that must complete it before `before` is offered.

Rejected alternatives:

- **Keep the self-loop, teach the walk to skip `from === to`.** Smaller edit, but leaves a self-loop
  in a graph whose own invariant test forbids them, and the chart has to special-case drawing it.
- **Give `dataUpdate` its own stage code.** Stages *are* `IDMS_Status__c` values. Inventing one
  would misreport what the org holds, which is the class of error this app exists to prevent.

### 2. Two chains, not one

> **Revised during planning.** This section originally proposed `chainForFamily(family)` and
> threading a `deviceId → family` lookup through `summarisePolling` and `rescoreSnapshot`. That is
> unnecessary, and the simpler form is also the safer one — see the note below.

| Function | Returns | Purpose |
|---|---|---|
| `operationChain()` | `[initialLoad, shipmentUpdate, received]` | the movement chain, derived from `transitions` alone — **restored by removing the self-loop**. Unchanged semantics; the tests assert it excludes `dataUpdate`. |
| `pollingOrder()` | `[initialLoad, dataUpdate, shipmentUpdate, received]` | the movement chain with stage steps spliced in at `before`. The order positions are compared in. |

`positionInChain` switches from `operationChain()` to `pollingOrder()`. It is the sole production
consumer of the former (`sf-client.js:686`), so the blast radius is one line.

**Why no family is needed.** A device's position depends on which operation last wrote its sync
status, not on its family. `DATA_UPDATE_SYNC_SUCCESS` sits between initial load and shipment update
for *any* device carrying it, and a family with no data-update sheet never produces that status —
so including the step in one shared order is correct for every family, and inert where the family
cannot reach it. Family matters only for **blocking** (section 4), never for position.

This matters because `positionInChain` decides whether a device counts as loaded — the
highest-consequence logic in the app. Threading a per-device family lookup through
`summarisePolling` and `rescoreSnapshot` to reach it would have been the riskiest part of this
change, and it buys nothing. An unknown position must continue to be treated as **not ahead**: it
may under-report a success, never invent one.

### 3. Which families can run a data update

From the descriptors, only two have a `dataUpdate` template:

| Family | Data update |
|---|---|
| `octo` | **required** — `octo-data-update` |
| `haptic` | optional — `haptic-data-update` |
| `driveri`, `dhub`, `dms`, `vbus` | **not possible** — no sheet exists |

"Optional for other families" therefore means optional *where a sheet exists*. A family with no
template must say so ("no CSV format for this family") rather than silently omitting the step, so
the absence reads as a known gap rather than a decision.

### 4. Blocking, for Octo

Shipment update is **not offered** for an Octo device until it carries `DATA_UPDATE_SYNC_SUCCESS`.
The device stays on its current tab with the data-update hand-off as its only forward move.

This is deliberately stricter than `validateDeviceStages`, which is always a warning because another
system can move a device between the read and the send. The difference: that check is about a stage
written by somebody else, whereas this one is about an operation **this app** either sent or did
not. There is no race to lose.

### 5. Octo completeness, per device

A device is eligible to proceed only when:

- its own sync status is a success for the operation just polled, **and**
- every entry in `row.accessories` is `present` and at a success sync status.

Rows already carry, per accessory: `{ type, serialId, present, stage, syncStatus, assetStatus }`.

**Per-device, not per-run.** Four devices proceed while the one whose speaker failed is held back.
This preserves the existing rule that a partially-failed load is not a dead end — the ~⅓ that fail
stay behind and the rest move on.

A held-back device must be **named, with the accessory that blocked it**. "4 of 5 selected" with no
explanation reads as a bug; "device 1250730291 — Wired Speaker 330099291 not synced" reads as a
decision.

### 6. Where the family *is* needed

Only for the block in section 4, and only in the UI layer, which already knows each group's family.

`summarisePolling(stage, deviceIds, assets)` and `rescoreSnapshot(stage, snapshot)` keep their
current signatures. No `familyOf` plumbing — see the revision note in section 2.

The block is decided per **group**, not per run. Today's `isOctoRun` test is
`groups.every(g => g.family === 'octo')`, which reads a mixed-family run as non-Octo and would skip
the block for its Octo devices.

### 7. What "synced" means for an accessory

An accessory counts as synced when `present` is true **and** `classifySyncStatus(syncStatus)`
reports terminal and not failed — the same test applied to the device itself. A `null` sync status
is *not* synced: it means the integration has not written anything yet, which is a reason to wait,
not to proceed.

### 8. How an optional data update is reached

No new choice control. `dataUpdate` is already a pollable stage with its own tab, so a Haptic
operator selects that tab and uses its hand-off. "Optional" means the shipment-update hand-off is
not withheld — not that a second button appears beside it.

## Behaviour matrix

| Family | At `-2`, initial load succeeded | Next offered |
|---|---|---|
| octo, device + accessories synced | yes | **Data update** |
| octo, data update succeeded, accessories synced | yes | Shipment update |
| octo, data update not run | yes | Data update only — shipment update withheld |
| octo, an accessory unsynced | yes | device held back, named in a notice |
| haptic | yes | Shipment update; data update available as a choice |
| driveri / dhub / dms / vbus | yes | Shipment update |

## Edge cases

- **Mixed-family run.** `requiredFor` is per family, so a run containing Octo and non-Octo groups
  applies the block only to the Octo devices. The existing `isOctoRun` check
  (`groups.every(g => g.family === 'octo')`) treats a mixed run as non-Octo, which would skip the
  block for its Octo devices; the replacement must be per group.
- **An Octo device with no accessories recorded.** `run.accessories[deviceId]` absent means nothing
  to wait on — the device is not held back. Absence of a record is not evidence of an unsynced part.
- **Snapshots predating this change** carry no `accessories`. They must keep their existing reading
  rather than being judged as incomplete.
- **A stage step whose operation has no template for the family** is reported as unavailable, never
  silently dropped.

## Testing

- The six failing `lifecycle.test.js` assertions **pass unedited**. Non-negotiable: they are the
  regression test for the truncation.
- `operationChain()` returns `[initialLoad, shipmentUpdate, received]`.
- `chainForFamily('octo')` splices `dataUpdate` in at the right position; other families unchanged.
- `no stage transitions to itself` holds again.
- Octo without `DATA_UPDATE_SYNC_SUCCESS` is not offered shipment update; with it, is.
- Per-device accessory completeness: one failed accessory holds one device, not the batch.
- A device with no accessory record is not held back.
- Mixed-family run blocks only its Octo devices.

## Out of scope

- Changing what the data-update CSV contains.
- The `alreadySent` / `no sheet yet` states in the next-step panel, which lost their button earlier.
- Backfilling `run.accessories` for runs that predate accessory capture.
