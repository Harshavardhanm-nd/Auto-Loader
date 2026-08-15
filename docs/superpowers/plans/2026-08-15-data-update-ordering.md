# Data Update Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make data update an ordered step that precedes shipment update, required for Octo and optional elsewhere, and hold an Octo device back until it and its accessories are synced.

**Architecture:** `dataUpdate` stops being a self-loop in the stage graph and becomes a declared *stage step* — an operation that runs at a stage without moving the device. That restores `operationChain()` to the movement chain it is supposed to be, and a second derived order, `pollingOrder()`, splices stage steps back in for position comparison. Family only decides whether the step is *required*, never where it sits.

**Tech Stack:** Node 24 ESM, `node:test` + `node:assert/strict`, React 18 (no router, no state library), Vite.

**Spec:** `docs/superpowers/specs/2026-08-15-data-update-ordering-design.md`

## Global Constraints

- Stages **are** `IDMS_Status__c` values. Never invent a stage code.
- `positionInChain` must fail toward **not ahead**. It may under-report a success; it must never invent one.
- The six currently-failing `lifecycle.test.js` assertions must pass **unedited**. If a task tempts you to change them, the modelling is wrong — stop.
- Tests run with `node --test <file>`. Node prints tallies with `ℹ`, not TAP `#`.
- The suite has **45 pre-existing failures** (`templates.test.js` and `config.test.js`). Baseline before this plan: **177 tests, 132 pass, 45 fail**. A task must not increase the failure count.
- No server restart is available via `node --watch` on this machine — it does not reload. Verify server behaviour on a throwaway instance: `PORT=4399 NODE_ENV=production STARTUP_SESSION_CHECK=off node server/index.js`.

---

### Task 1: Take `dataUpdate` out of the movement graph

**Files:**
- Modify: `config/lifecycle.json` (remove one transition, add `stageSteps`)
- Modify: `server/lib/lifecycle.js:37-70` (`index()` — expose `stageSteps`)
- Test: `server/lib/lifecycle.test.js` (existing, unedited)

**Interfaces:**
- Consumes: nothing
- Produces: `loadLifecycle().stageSteps` — `Array<{operation: string, at: number, before: string, requiredFor: string[], note?: string}>`

- [ ] **Step 1: Run the six failing tests to see them fail**

Run: `node --test server/lib/lifecycle.test.js 2>&1 | grep -E "^  ✖"`

Expected — exactly these six:
```
✖ no stage transitions to itself
✖ each step names the next one as the operator's next move
✖ a stage-preserving operation is valid at every stage
✖ is walked from the entry of the graph, in the order a device meets it
✖ stops where the chain leaves this app — nothing after Received at 3PL is ours
✖ dataUpdate moves no device, so it is deliberately off the chain
```

- [ ] **Step 2: Delete the self-loop transition from `config/lifecycle.json`**

Remove this entire object from the `transitions` array (it sits between the `initialLoad` entry and the `-2 → -1` shipment arrow):

```json
    {
      "from": -2,
      "to": -2,
      "label": "Data Update",
      "driver": { "kind": "operation", "operation": "dataUpdate" },
      "note": "Octo requires this data correction step after initial load. Other families may skip it."
    },
```

- [ ] **Step 3: Add `stageSteps` to `config/lifecycle.json`**

Add as a new top-level key, immediately after the `transitions` array closes and before `operationRoles`:

```json
  "stageSteps": [
    {
      "$comment": "Operations that run at a stage without moving the device. They are not transitions — a self-loop breaks operationChain(), which walks the graph taking the first arrow out of each stage and would follow this one straight back to where it started.",
      "operation": "dataUpdate",
      "at": -2,
      "before": "shipmentUpdate",
      "requiredFor": ["octo"],
      "note": "Octo corrects device data at Pre-Production before shipping. Haptic has a data-update sheet and may run it; families without one cannot."
    }
  ],
```

- [ ] **Step 4: Expose `stageSteps` from `index()` in `server/lib/lifecycle.js`**

In the object returned by `index()` (currently ends with `syncStatus: stripComments(raw.syncStatus),`), add:

```js
    // Operations that run at a stage without moving the device. Deliberately not in `transitions`:
    // a self-loop there truncates operationChain(), which is what this change repairs.
    stageSteps: (raw.stageSteps ?? []).filter((s) => s.operation),
```

- [ ] **Step 5: Run the lifecycle tests — the six must now pass, unedited**

Run: `node --test server/lib/lifecycle.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`

If any of the six still fails, do not edit the test — re-read `index()` and the JSON.

- [ ] **Step 6: Confirm the chain is repaired**

Run:
```bash
node -e "import('./server/lib/lifecycle.js').then(m=>console.log(JSON.stringify(m.operationChain())))"
```
Expected: `["initialLoad","shipmentUpdate","received"]`

- [ ] **Step 7: Confirm the whole suite has not regressed**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 45` or fewer. Never more.

- [ ] **Step 8: Commit**

```bash
git add config/lifecycle.json server/lib/lifecycle.js
git commit -m "Model dataUpdate as a stage step, not a self-loop

operationChain() walks transitions taking the first arrow out of each stage.
A -2 -> -2 self-loop sent it straight back, truncating the chain to
[initialLoad, dataUpdate] and switching off the ahead/behind guard for
shipmentUpdate and received. Six lifecycle tests were already reporting this
and now pass unedited."
```

---

### Task 2: `pollingOrder()` — the movement chain with stage steps spliced in

**Files:**
- Modify: `server/lib/lifecycle.js` (add export after `operationChain`, ~line 184)
- Test: `server/lib/stage-steps.test.js` (create)

**Interfaces:**
- Consumes: `loadLifecycle().stageSteps` (Task 1)
- Produces: `pollingOrder(): string[]`

- [ ] **Step 1: Write the failing test**

Create `server/lib/stage-steps.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { operationChain, pollingOrder } from './lifecycle.js';

/**
 * Two orders, deliberately different.
 *
 * `operationChain` is the movement chain — what actually carries a device from stage to stage.
 * `pollingOrder` is what positions are compared in, and includes operations that run *at* a stage
 * without moving it. A device carrying DATA_UPDATE_SYNC_SUCCESS sits between initial load and
 * shipment update, and has to be placed there or it reads as "unknown" and is treated as not done.
 */
describe('the order operations are compared in', () => {
  test('the movement chain carries no stage-preserving step', () => {
    assert.deepEqual(operationChain(), ['initialLoad', 'shipmentUpdate', 'received']);
  });

  test('the polling order splices dataUpdate in before shipment update', () => {
    assert.deepEqual(pollingOrder(), ['initialLoad', 'dataUpdate', 'shipmentUpdate', 'received']);
  });

  test('every movement operation keeps its relative order', () => {
    const order = pollingOrder();
    const positions = operationChain().map((op) => order.indexOf(op));
    assert.ok(
      positions.every((p, i) => i === 0 || p > positions[i - 1]),
      'splicing a stage step must not reorder the movements'
    );
  });

  test('is stable across calls', () => {
    assert.deepEqual(pollingOrder(), pollingOrder());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/lib/stage-steps.test.js`
Expected: FAIL — `does not provide an export named 'pollingOrder'`

- [ ] **Step 3: Implement `pollingOrder` in `server/lib/lifecycle.js`**

Add immediately after `operationChain()`:

```js
/**
 * The order operations are compared in when deciding whether a device is ahead of, at, or behind
 * the stage being watched.
 *
 * `operationChain()` is the movement chain and deliberately excludes anything that does not move a
 * device. But a device carrying `DATA_UPDATE_SYNC_SUCCESS` *is* somewhere — between initial load
 * and shipment update — and leaving it out of the order makes `positionInChain` answer "unknown",
 * which is then treated as not-done. So stage steps are spliced back in at the operation they
 * precede.
 *
 * No family is involved. Position depends on which operation last wrote the sync status, and a
 * family with no data-update sheet never produces that status, so one shared order is correct for
 * every family and inert where a family cannot reach the step.
 */
export function pollingOrder() {
  const model = loadLifecycle();
  if (!model.pollingOrderCache) {
    const order = [...operationChain()];
    for (const step of model.stageSteps) {
      if (order.includes(step.operation)) continue;
      const at = order.indexOf(step.before);
      // An unknown `before` appends rather than throwing: a step nobody can order is still better
      // placed at the end than dropped, and dropping it is what causes the silent misreads above.
      if (at === -1) order.push(step.operation);
      else order.splice(at, 0, step.operation);
    }
    model.pollingOrderCache = order;
  }
  return model.pollingOrderCache;
}
```

- [ ] **Step 4: Run the test — it must pass**

Run: `node --test server/lib/stage-steps.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`

- [ ] **Step 5: Commit**

```bash
git add server/lib/lifecycle.js server/lib/stage-steps.test.js
git commit -m "Add pollingOrder(): the movement chain with stage steps spliced in"
```

---

### Task 3: `positionInChain` compares against `pollingOrder()`

**Files:**
- Modify: `server/services/sf-client.js:22` (import), `:686` (the one call)
- Test: `server/services/position.test.js` (create)

**Interfaces:**
- Consumes: `pollingOrder()` (Task 2)
- Produces: no signature change. `positionInChain(stage, syncStatus)` stays private; behaviour changes.

- [ ] **Step 1: Write the failing test**

Create `server/services/position.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarisePolling } from './sf-client.js';

/**
 * Where a device sits relative to the stage being watched.
 *
 * On the Asset a device ahead of the watched stage and one behind it look identical — each carries
 * some `_SYNC_SUCCESS`. The answer comes from the order in `lifecycle.json`, so a device that has
 * only had its data update must not read as having been shipped.
 */
const asset = (deviceId, syncStatus, idmsStatus) => ({
  deviceId, syncStatus, idmsStatus, id: 'a' + deviceId, assetStatus: null,
  cpqOrderNumber: null, phase: 'synced',
});

describe('placing a device against the watched stage', () => {
  test('a data-updated device is behind shipment update, not done', () => {
    const s = summarisePolling('shipmentUpdate', ['1'], [asset('1', 'DATA_UPDATE_SYNC_SUCCESS', -2)]);
    const row = s.rows[0];
    assert.equal(row.aheadOfStage, false, 'a data update is not a shipment update');
    assert.equal(s.counts.succeeded, 0, 'it must not be counted as loaded');
  });

  test('a shipped device is ahead of the data-update stage', () => {
    const s = summarisePolling('dataUpdate', ['1'], [asset('1', 'SHIPMENT_UPDATE_SYNC_SUCCESS', -1)]);
    assert.equal(s.rows[0].aheadOfStage, true);
  });

  test('a device at the watched stage is done', () => {
    const s = summarisePolling('dataUpdate', ['1'], [asset('1', 'DATA_UPDATE_SYNC_SUCCESS', -2)]);
    assert.equal(s.counts.succeeded, 1);
  });

  test('an unmodelled status is never read as progress', () => {
    const s = summarisePolling('shipmentUpdate', ['1'], [asset('1', 'SOMETHING_ELSE_SYNC_SUCCESS', -2)]);
    assert.equal(s.rows[0].aheadOfStage, false);
  });
});
```

- [ ] **Step 2: Run it and record which assertions fail**

Run: `node --test server/services/position.test.js 2>&1 | grep -E "^  (✔|✖)"`
Expected: `a data-updated device is behind shipment update` and `a shipped device is ahead of the data-update stage` FAIL — with the movement chain alone, `dataUpdate` is not in the order so both read `unknown`.

- [ ] **Step 3: Point `positionInChain` at `pollingOrder`**

In `server/services/sf-client.js`, change the import on line 22 from `operationChain,` to:

```js
  pollingOrder,
```

and in `positionInChain` (line ~686) change:

```js
  const chain = operationChain();
```

to:

```js
  // The polling order, not the movement chain: a device that has only had its data update is
  // somewhere real, and comparing against a chain that omits that step reads it as "unknown".
  const chain = pollingOrder();
```

- [ ] **Step 4: Run the test — all four must pass**

Run: `node --test server/services/position.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`

- [ ] **Step 5: Confirm no regression**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 45` or fewer.

- [ ] **Step 6: Commit**

```bash
git add server/services/sf-client.js server/services/position.test.js
git commit -m "Compare device positions against pollingOrder, not the movement chain"
```

---

### Task 4: `requiredStepsBefore(operation, family)` and exposing it to the UI

**Files:**
- Modify: `server/lib/lifecycle.js` (add export), `:352-395` (`describeLifecycle`)
- Test: `server/lib/stage-steps.test.js` (extend, from Task 2)

**Interfaces:**
- Consumes: `loadLifecycle().stageSteps` (Task 1)
- Produces:
  - `requiredStepsBefore(operation: string, family: string): string[]` — operation ids that must complete first
  - `describeLifecycle()` gains `stageSteps: Array<{operation, operationLabel, at, before, requiredFor, note}>`

- [ ] **Step 1: Write the failing test**

Append to `server/lib/stage-steps.test.js`:

```js
import { requiredStepsBefore, describeLifecycle } from './lifecycle.js';

describe('which steps a family must complete first', () => {
  test('Octo must data-update before shipping', () => {
    assert.deepEqual(requiredStepsBefore('shipmentUpdate', 'octo'), ['dataUpdate']);
  });

  test('no other family is required to', () => {
    for (const family of ['driveri', 'dhub', 'dms', 'vbus', 'haptic']) {
      assert.deepEqual(requiredStepsBefore('shipmentUpdate', family), [], family);
    }
  });

  test('nothing is required before the step itself, or before an unrelated operation', () => {
    assert.deepEqual(requiredStepsBefore('dataUpdate', 'octo'), []);
    assert.deepEqual(requiredStepsBefore('received', 'octo'), []);
  });

  test('an unknown family requires nothing rather than throwing', () => {
    assert.deepEqual(requiredStepsBefore('shipmentUpdate', 'nosuchfamily'), []);
    assert.deepEqual(requiredStepsBefore('shipmentUpdate', null), []);
  });

  test('the UI payload carries the steps, so the rule is not re-implemented in the browser', () => {
    const step = describeLifecycle({ dataUpdate: { label: 'Data update' } })
      .stageSteps.find((s) => s.operation === 'dataUpdate');
    assert.ok(step, 'dataUpdate must appear in the lifecycle payload');
    assert.equal(step.before, 'shipmentUpdate');
    assert.deepEqual(step.requiredFor, ['octo']);
    assert.equal(step.operationLabel, 'Data update');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/lib/stage-steps.test.js`
Expected: FAIL — `does not provide an export named 'requiredStepsBefore'`

- [ ] **Step 3: Implement `requiredStepsBefore`**

Add to `server/lib/lifecycle.js`, after `pollingOrder()`:

```js
/**
 * Stage steps a family must complete before `operation` may be offered.
 *
 * Family decides *whether* a step is required, never where it sits in the order — see
 * `pollingOrder`. An unknown or missing family requires nothing: refusing to offer an operation
 * because a family could not be identified would block work on a guess.
 */
export function requiredStepsBefore(operation, family) {
  if (!operation || !family) return [];
  return loadLifecycle()
    .stageSteps.filter((s) => s.before === operation && (s.requiredFor ?? []).includes(family))
    .map((s) => s.operation);
}
```

- [ ] **Step 4: Add `stageSteps` to `describeLifecycle`**

In the object `describeLifecycle` returns, after the `transitions:` array, add:

```js
    stageSteps: model.stageSteps.map((s) => ({
      operation: s.operation,
      operationLabel: operations[s.operation]?.label ?? s.operation,
      at: s.at,
      before: s.before,
      requiredFor: s.requiredFor ?? [],
      note: s.note ?? null,
    })),
```

- [ ] **Step 5: Run the test — all must pass**

Run: `node --test server/lib/stage-steps.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`

- [ ] **Step 6: Confirm the API actually serves it**

Run:
```bash
PORT=4399 NODE_ENV=production STARTUP_SESSION_CHECK=off node server/index.js &
sleep 4
curl -s "http://localhost:4399/api/catalog/lifecycle" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).stageSteps)))"
kill %1
```
Expected: `[{"operation":"dataUpdate","operationLabel":"Data update","at":-2,"before":"shipmentUpdate","requiredFor":["octo"],"note":"..."}]`

- [ ] **Step 7: Commit**

```bash
git add server/lib/lifecycle.js server/lib/stage-steps.test.js
git commit -m "Declare which families must complete a stage step before moving on"
```

---

### Task 5: Watch page — model-driven next operation, and the Octo block

**Files:**
- Modify: `web/src/pages/WatchPage.jsx` — `getNextOperation` (~line 301), `shipmentEligibleRows` (~line 213)

**Interfaces:**
- Consumes: `model.stageSteps` from `api.lifecycle()` (Task 4). `model` is already fetched into state at the top of the component.
- Produces: `stepsRequiredBefore(operation)` and `octoFamilies` locals used by Task 6.

- [ ] **Step 1: Replace the hardcoded `getNextOperation`**

Delete this entire function:

```js
  const getNextOperation = () => {
    // For Octo: initialLoad → dataUpdate → shipmentUpdate
    // For others: initialLoad → shipmentUpdate
    const isOctoRun = run.groups.length > 0 && run.groups.every((g) => g.family === 'octo');

    if (stage === 'initialLoad') {
      return isOctoRun ? 'dataUpdate' : 'shipmentUpdate';
    }
    if (stage === 'dataUpdate') {
      return 'shipmentUpdate';
    }
    return 'shipmentUpdate'; // default
  };
```

and replace with:

```js
  /**
   * Families in this run that must complete `operation`'s prerequisite steps.
   *
   * Per group, not per run: the old test was `groups.every(g => g.family === 'octo')`, which read a
   * mixed run as non-Octo and skipped the block for its Octo devices.
   */
  const familiesNeeding = (operation) =>
    (run.groups ?? [])
      .map((g) => g.family)
      .filter((family) => (model?.stageSteps ?? []).some(
        (s) => s.before === operation && (s.requiredFor ?? []).includes(family)
      ));

  /** Which stage step a family must finish before `operation`, or null. */
  const stepRequiredBefore = (operation) =>
    (model?.stageSteps ?? []).find(
      (s) => s.before === operation && familiesNeeding(operation).length > 0
    ) ?? null;

  const getNextOperation = () => {
    if (stage === 'dataUpdate') return 'shipmentUpdate';
    // A family that owes a step before shipment update is sent to that step first. The rule is in
    // config/lifecycle.json, not here — this reads it.
    const owed = stepRequiredBefore('shipmentUpdate');
    if (stage === 'initialLoad' && owed) return owed.operation;
    return 'shipmentUpdate';
  };
```

- [ ] **Step 2: Withhold shipment update until the required step has synced**

Replace `shipmentEligibleRows` (currently accepts either success status unconditionally):

```js
  // Rows eligible for shipment update: IDMS -2 + fully synced (after initial load or data update).
  const shipmentEligibleRows = (snapshot?.rows ?? []).filter(
    (r) =>
      (stage === 'initialLoad' || stage === 'dataUpdate') &&
      Number(r.idmsStatus) === -2 &&
      (r.syncStatus === 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS' || r.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS')
  );
```

with:

```js
  // Rows eligible for shipment update: at Pre-Production and fully synced. A family that owes a
  // stage step first (Octo owes its data update) is only eligible once *that* step's status is on
  // the device — an initial-load success is not enough for them.
  const owesBeforeShipment = stepRequiredBefore('shipmentUpdate');
  const shipmentEligibleRows = (snapshot?.rows ?? []).filter((r) => {
    if (stage !== 'initialLoad' && stage !== 'dataUpdate') return false;
    if (Number(r.idmsStatus) !== -2) return false;
    if (owesBeforeShipment) return r.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS';
    return (
      r.syncStatus === 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS' ||
      r.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS'
    );
  });
```

- [ ] **Step 3: Build**

Run: `npx vite build --config web/vite.config.js 2>&1 | tail -3`
Expected: `✓ built in …` with no errors.

- [ ] **Step 4: Verify in the running app**

Run a throwaway server and open an Octo run's Watch page on the Initial load tab.

```bash
npx vite build --config web/vite.config.js
PORT=4399 NODE_ENV=production STARTUP_SESSION_CHECK=off node server/index.js &
```

Open `http://localhost:4399/`, History → open `run-20260815-044550-7800` (family `octo`) → Watch → Initial load, tick a device.

Expected: the hand-off reads **Data Update**, not Shipment update. On a non-Octo run (`run-20260815-041636-4433`, haptic) it still reads Shipment update.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/WatchPage.jsx
git commit -m "Drive the next operation from lifecycle.json, per group not per run

The Octo ordering was hardcoded in the browser as groups.every(family==='octo'),
which read a mixed-family run as non-Octo and skipped the step for its Octo
devices."
```

---

### Task 6: Octo accessory completeness, per device

**Files:**
- Modify: `web/src/pages/WatchPage.jsx` — `shipmentEligibleRows` (from Task 5), and the hand-off panel (~line 690)

**Interfaces:**
- Consumes: `stepRequiredBefore` (Task 5); `row.accessories` — `Array<{type, serialId, present, stage, syncStatus, assetStatus}>`, already attached by `GET /:runId/poll/:stage`
- Produces: nothing downstream

- [ ] **Step 1: Add the completeness helpers**

Add above `shipmentEligibleRows` in `web/src/pages/WatchPage.jsx`:

```js
  /**
   * Is a related asset synced?
   *
   * `present` false means the accessory has no Asset in the org yet, and a null sync status means
   * the integration has written nothing — both are reasons to wait, not to proceed.
   */
  const accessorySynced = (a) => Boolean(a?.present) && /_SYNC_SUCCESS$/.test(a?.syncStatus ?? '');

  /**
   * A device is complete when it and every accessory recorded against it are synced.
   *
   * Per device, not per run: the four devices whose speakers landed move on while the one that
   * failed is held back. A device with no accessories recorded has nothing to wait on — absence of
   * a record is not evidence of an unsynced part. A snapshot taken before accessories were captured
   * carries none, and must keep its old reading rather than being judged incomplete.
   */
  const accessoriesComplete = (r) => (r.accessories ?? []).every(accessorySynced);

  /** Devices held back only by an accessory, so the notice can name what is missing. */
  const heldByAccessory = (snapshot?.rows ?? []).filter(
    (r) => (r.accessories ?? []).length > 0 && !accessoriesComplete(r)
  );
```

- [ ] **Step 2: Require completeness in `shipmentEligibleRows`**

In the filter written in Task 5, add `accessoriesComplete(r)` as the final condition of both branches:

```js
  const shipmentEligibleRows = (snapshot?.rows ?? []).filter((r) => {
    if (stage !== 'initialLoad' && stage !== 'dataUpdate') return false;
    if (Number(r.idmsStatus) !== -2) return false;
    if (!accessoriesComplete(r)) return false;
    if (owesBeforeShipment) return r.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS';
    return (
      r.syncStatus === 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS' ||
      r.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS'
    );
  });
```

- [ ] **Step 3: Name the held-back devices**

Immediately after the `<Sheet>` that contains the per-device table (the one closing just before `{selected.size > 0 && handoff ? (`), insert:

```jsx
          {heldByAccessory.length ? (
            <Callout
              tone="warn"
              title={`${heldByAccessory.length} device(s) waiting on a related asset`}
            >
              <ul style={{ margin: '0.2rem 0 0', paddingLeft: '1.1rem' }}>
                {heldByAccessory.map((r) => (
                  <li key={r.deviceId} className="small">
                    <span className="mono">{r.deviceId}</span> —{' '}
                    {(r.accessories ?? [])
                      .filter((a) => !accessorySynced(a))
                      .map((a) => `${a.type} ${a.serialId}${a.present ? '' : ' (no asset yet)'}`)
                      .join(', ')}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}
```

- [ ] **Step 4: Build**

Run: `npx vite build --config web/vite.config.js 2>&1 | tail -3`
Expected: `✓ built in …`

- [ ] **Step 5: Verify against the Octo run**

```bash
PORT=4399 NODE_ENV=production STARTUP_SESSION_CHECK=off node server/index.js &
```

Open the Octo run `run-20260815-044550-7800` (5 devices, each with a Wired Speaker and a Native Camera) → Watch → Initial load → tick all.

Expected: devices whose accessories are all synced are offered; any held back appear in the warning callout, named with the accessory blocking them. Confirm no page errors in the console.

- [ ] **Step 6: Confirm no regression**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 45` or fewer.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/WatchPage.jsx
git commit -m "Hold an Octo device back until its related assets are synced

Per device, not per run: a failed speaker holds its own device and names itself
in a notice, while the rest of the batch moves on."
```

---

### Task 7: Record the model in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — the "Known defect" subsection under the life cycle section, and the chaining section

- [ ] **Step 1: Delete the "Known defect: the `dataUpdate` self-loop truncates the operation chain" subsection**

It is fixed. Leaving it would send the next reader hunting for a bug that no longer exists.

- [ ] **Step 2: Add the replacement, after the `operationChain()` paragraph**

```markdown
**Stage steps are operations that run at a stage without moving the device.** They live in
`stageSteps` in `config/lifecycle.json`, deliberately *not* in `transitions`: `operationChain()`
walks the graph taking the first arrow out of each stage, so a self-loop sends it straight back and
truncates the chain. That is exactly what a `-2 → -2` `dataUpdate` transition did until 2026-08-15 —
the chain became `[initialLoad, dataUpdate]`, and the ahead/behind guard was silently off for
`shipmentUpdate` and `received`. Six `lifecycle.test.js` assertions were reporting it the whole time.

Two orders come out of this, and they are not interchangeable:

- `operationChain()` — the movement chain, `[initialLoad, shipmentUpdate, received]`.
- `pollingOrder()` — the same with stage steps spliced in at their `before`,
  `[initialLoad, dataUpdate, shipmentUpdate, received]`. **`positionInChain` uses this one**: a
  device carrying `DATA_UPDATE_SYNC_SUCCESS` is somewhere real, and an order that omits the step
  reads it as `unknown`, which is then treated as not-done.

No family is involved in the order. Position depends on which operation last wrote the sync status,
and a family with no data-update sheet never produces that status. Family decides only whether a
step is *required*: `requiredStepsBefore(operation, family)` reads `requiredFor`, and Octo owes a
data update before shipment update. **The check is per group, not per run** — `groups.every(g =>
g.family === 'octo')` read a mixed run as non-Octo and skipped the block for its Octo devices.

Only `haptic` and `octo` have a data-update sheet, so it is required for Octo, optional for Haptic,
and impossible for the rest.

**An Octo device is held back until its related assets are synced** — every entry in
`row.accessories` present and at a `_SYNC_SUCCESS`. Per device, not per run: the batch's successes
still move on, which is the same rule a partially-failed load has always followed. A device with no
accessories recorded has nothing to wait on; absence of a record is not evidence of an unsynced part.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document stage steps, the two orders, and the Octo completeness rule"
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. `dataUpdate` leaves `transitions` | 1 |
| 2. Two chains (`operationChain` / `pollingOrder`) | 2, 3 |
| 3. Which families can run a data update | 4 (`requiredFor`), 7 (documented) |
| 4. Blocking for Octo | 5 |
| 5. Octo completeness, per device | 6 |
| 6. Where the family is needed (per group) | 5 |
| 7. What "synced" means for an accessory | 6 (`accessorySynced`) |
| 8. Optional data update reached via its own tab | no code — the tab already exists; recorded in 7 |
| Edge: mixed-family run | 5 (`familiesNeeding` maps over groups) |
| Edge: device with no accessories | 6 (`.every()` on an empty list is true) |
| Edge: snapshot predating accessories | 6 (same — no `accessories` key means no constraint) |
| Edge: no template for the family | 4 — `requiredFor` omits them; surfaced by the existing "no sheet yet" badge |

**Placeholder scan:** no TBD/TODO; every code step carries the actual code; no "similar to Task N".

**Type consistency:** `stageSteps` shape is defined in Task 1 and consumed unchanged in 2, 4, 5. `pollingOrder()` defined in 2, used in 3. `requiredStepsBefore` defined in 4 (server) and mirrored in the browser as `stepRequiredBefore` in 5 — **different names on purpose**, because the browser reads the payload rather than importing server code; Task 5 says so.

**Known gap, stated rather than hidden:** Tasks 5 and 6 have no automated tests. This repo has no React test harness, and adding one is out of scope for this change. They are verified by build plus driving the running app, with the exact run ids to open. If a harness is wanted, it should be its own plan.
