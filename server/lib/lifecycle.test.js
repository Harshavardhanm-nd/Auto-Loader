/**
 * The device life cycle graph.
 *
 * A state machine is exactly the kind of thing that looks right and is wrong, so the properties
 * that the rest of the app leans on are asserted rather than eyeballed:
 *
 *   - The graph is closed: every transition names stages that exist, and every stage except the
 *     entry point is reachable. A stage nothing enters is a modelling mistake, not a dead end.
 *   - The sequence the operator actually walks — initial load, shipment update, received at 3PL
 *     — is a connected chain in the model, not three unrelated operations.
 *   - Stage checking never blocks. `checkOperationAgainstStages` reports, and an initial load on
 *     a device that does not exist yet is the normal case, not a mismatch.
 *   - Every operation that carries a mailbox is either placed on the chart or explicitly marked
 *     as not placed. Silence would let a new operation look modelled when it is not.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadOperations } from './config.js';
import {
  loadLifecycle,
  classifyStage,
  stageByCode,
  transitionsFrom,
  transitionsInto,
  transitionsFor,
  operationMovement,
  operationChain,
  operationForSyncBase,
  operationRole,
  syncStatusBase,
  nextFrom,
  summariseStages,
  checkOperationAgainstStages,
  describeLifecycle,
} from './lifecycle.js';

const model = loadLifecycle();

describe('the graph is closed', () => {
  test('loading it validates every endpoint', () => {
    // index() throws on an unknown stage; reaching here means all 26 transitions resolved.
    assert.ok(model.stages.length >= 14);
    assert.ok(model.transitions.length >= 20);
  });

  test('exactly one entry point, and it is the initial load', () => {
    const entries = model.transitions.filter((t) => t.from === null);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].operation, 'initialLoad');
    assert.equal(entries[0].to, -2, 'an initial load lands in Pre-Production');
  });

  test('every stage is enterable', () => {
    for (const stage of model.stages) {
      assert.ok(
        transitionsInto(stage.code).length > 0,
        `nothing enters ${stage.label} (${stage.code})`
      );
    }
  });

  test('only Dead is terminal, and only Undo mark dead leaves it', () => {
    const terminal = model.stages.filter((s) => s.terminal);
    assert.deepEqual(
      terminal.map((s) => s.code),
      [9]
    );
    const out = transitionsFrom(9);
    assert.equal(out.length, 1);
    assert.equal(out[0].operation, 'undoDead');
  });

  test('stage codes are unique', () => {
    const codes = model.stages.map((s) => s.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  test('no stage transitions to itself', () => {
    for (const t of model.transitions) assert.notEqual(t.from, t.to, `${t.key} is a self-loop`);
  });
});

describe('the sequence the operator walks', () => {
  // The whole point of the model: these three are one chain on the same devices, not three
  // unrelated sends.
  test('initial load → shipment update → received at 3PL is connected', () => {
    const initial = operationMovement('initialLoad');
    const shipment = operationMovement('shipmentUpdate');
    const received = operationMovement('received');

    assert.deepEqual(initial.to, [-2]);
    assert.ok(shipment.from.includes(-2), 'a shipment update acts on a Pre-Production device');
    assert.deepEqual(shipment.to, [-1]);
    assert.ok(received.from.includes(-1), 'a 3PL receipt acts on a Shipped From Vendor device');
    assert.deepEqual(received.to, [1]);
  });

  test('each step names the next one as the operator\'s next move', () => {
    assert.deepEqual(
      nextFrom(-2).mine.map((n) => n.operation),
      ['shipmentUpdate']
    );
    assert.deepEqual(
      nextFrom(-1).mine.map((n) => n.operation),
      ['received']
    );
  });

  test('once the device reaches New, the next moves belong to other systems', () => {
    const next = nextFrom(1);
    assert.equal(next.mine.length, 0, 'nothing for the operator to send from New');
    assert.ok(next.theirs.length >= 2);
    assert.ok(next.theirs.every((n) => n.actor));
  });

  test('Installed hands off entirely — no send moves it', () => {
    assert.equal(nextFrom(4).mine.length, 0);
    assert.ok(
      nextFrom(4).theirs.some((n) => n.actor === 'Installer App' || n.actor === 'Customer'),
      'the Installer App and the customer own what happens at Installed'
    );
  });

  test('Move To Dead is reachable from all three of its stages', () => {
    const dead = transitionsFor('deviceDead');
    assert.deepEqual(dead.map((t) => t.from).sort((a, b) => a - b), [7, 8, 12]);
    assert.ok(dead.every((t) => t.to === 9));
  });
});

describe('reading a stage off an Asset', () => {
  test('a numeric code resolves to its stage', () => {
    const c = classifyStage(-1);
    assert.equal(c.known, true);
    assert.equal(c.label, 'Shipped From Vendor');
  });

  test('SOQL string codes resolve identically to numbers', () => {
    assert.deepEqual(classifyStage('4').stage, classifyStage(4).stage);
  });

  test('a device with no value is absent, not stage 0', () => {
    for (const empty of [null, undefined, '']) {
      const c = classifyStage(empty);
      assert.equal(c.absent, true);
      assert.equal(c.known, false);
      assert.equal(c.code, null);
    }
  });

  test('codes 13 and 14 exist in the org but not on the chart — reported, not guessed', () => {
    const c = classifyStage(13);
    assert.equal(c.known, false);
    assert.equal(c.unmapped, true);
    assert.equal(c.code, 13);
    assert.equal(c.stage, null);
  });

  test('there is no stage 0', () => {
    assert.equal(stageByCode(0), null);
  });
});

describe('where a batch of devices sits', () => {
  test('a run all at one stage reports unanimous', () => {
    const s = summariseStages([-2, -2, -2]);
    assert.equal(s.total, 3);
    assert.equal(s.rows.length, 1);
    assert.equal(s.unanimous.label, 'Pre-Production');
    assert.equal(s.unanimous.count, 3);
  });

  test('a split run has no single next step', () => {
    const s = summariseStages([-2, -1, -1]);
    assert.equal(s.unanimous, null);
    assert.equal(s.rows.length, 2);
  });

  test('rows follow the chart order, not first-seen order', () => {
    const s = summariseStages([9, -2, 4]);
    assert.deepEqual(
      s.rows.map((r) => r.code),
      [-2, 4, 9]
    );
  });

  test('absent and unmapped devices are counted separately from real stages', () => {
    const s = summariseStages([null, 13, -2]);
    assert.equal(s.rows.length, 3);
    assert.equal(s.rows.filter((r) => r.known).length, 1);
    assert.equal(s.rows.find((r) => r.absent).count, 1);
    assert.equal(s.rows.find((r) => r.unmapped).count, 1);
  });
});

describe('checking an operation against real stages', () => {
  const ids = (pairs) => pairs.map(([deviceId, idmsStatus]) => ({ deviceId, idmsStatus }));

  test('an initial load on devices that do not exist yet is not a mismatch', () => {
    const r = checkOperationAgainstStages('initialLoad', ids([['1', null], ['2', null]]));
    assert.equal(r.applicable, true);
    assert.equal(r.mismatched.length, 0);
    assert.equal(r.ok.length, 2);
  });

  test('a shipment update on a Pre-Production device is clean', () => {
    const r = checkOperationAgainstStages('shipmentUpdate', ids([['1', -2], ['2', '-2']]));
    assert.equal(r.mismatched.length, 0);
  });

  test('a shipment update on an already-installed device is flagged with the stage it is in', () => {
    const r = checkOperationAgainstStages('shipmentUpdate', ids([['1', -2], ['2', 4]]));
    assert.equal(r.mismatched.length, 1);
    assert.equal(r.mismatched[0].deviceId, '2');
    assert.match(r.mismatched[0].why, /Installed/);
  });

  test('a 3PL receipt before the shipment update has landed is flagged', () => {
    const r = checkOperationAgainstStages('received', ids([['1', -2]]));
    assert.equal(r.mismatched.length, 1);
    assert.match(r.mismatched[0].why, /Pre-Production/);
  });

  test('a stage-preserving operation is valid at every stage', () => {
    for (const op of ['updateLoad', 'dataUpdate']) {
      const r = checkOperationAgainstStages(op, ids([['1', 4], ['2', -2], ['3', null]]));
      assert.equal(r.applicable, false, `${op} should not be stage-checked`);
      assert.equal(r.mismatched.length, 0);
      assert.match(r.reason, /does not move a device/);
    }
  });

  test('an operation the chart does not cover is reported, not silently passed', () => {
    const r = checkOperationAgainstStages('nonRepairable', ids([['1', 7]]));
    assert.equal(r.applicable, false);
    assert.match(r.reason, /no transition/);
  });

  test('the from/to labels are human stage names, including "no Asset yet"', () => {
    const r = checkOperationAgainstStages('initialLoad', ids([['1', null]]));
    assert.deepEqual(r.fromLabels, ['no Asset yet']);
    assert.deepEqual(r.toLabels, ['Pre-Production']);
  });
});

describe('every mail operation is accounted for', () => {
  const operations = loadOperations();

  for (const [id, meta] of Object.entries(operations)) {
    test(`${id} is either on the chart or marked as not on it`, () => {
      const movement = operationMovement(id);
      const role = operationRole(id);
      assert.ok(
        movement || role?.stagePreserving || role?.unmapped,
        `${id} has no transition and no operationRoles entry — it looks modelled but is not`
      );
    });
  }

  test('an operation without a sync status cannot be polled, and says so', () => {
    // These carry a mailbox but no known Sync_Status__c base, so polling them would wait for a
    // value that never arrives.
    for (const op of ['deviceDead', 'undoDead', 'nonRepairable', 'faultyReturned']) {
      assert.equal(syncStatusBase(op), null, `${op} unexpectedly claims a sync status`);
    }
  });

  test('the three chained operations all have a sync status to watch', () => {
    assert.equal(syncStatusBase('initialLoad'), 'INITIAL_DEVICE_LOAD');
    assert.equal(syncStatusBase('shipmentUpdate'), 'SHIPMENT_UPDATE');
    assert.equal(syncStatusBase('received'), 'DEVICE_RECEIVED_AT_3PL');
  });
});

describe('the shape handed to the client', () => {
  const described = describeLifecycle(loadOperations());

  test('every stage carries a layout slot, so the map cannot lose a node', () => {
    for (const s of described.stages) {
      assert.equal(typeof s.layout?.col, 'number', `${s.label} has no column`);
      assert.equal(typeof s.layout?.row, 'number', `${s.label} has no row`);
    }
  });

  test('no two stages occupy the same grid slot', () => {
    const slots = described.stages.map((s) => `${s.layout.col},${s.layout.row}`);
    assert.equal(new Set(slots).size, slots.length);
  });

  test('a transition is driven by an operation or an actor, never neither', () => {
    for (const t of described.transitions) {
      assert.ok(t.operation || t.actor, `${t.key} has no driver`);
      assert.ok(!(t.operation && t.actor), `${t.key} claims both an operation and an actor`);
    }
  });

  test('inferred arrows are declared, so nothing reads as confirmed when it is not', () => {
    assert.ok(described.uncertainties.length > 0);
    for (const u of described.uncertainties) assert.ok(u.why.length > 20);
  });
});

/**
 * Polling has to tell a device that has run ahead of the stage being watched from one still
 * behind it. On the Asset the two are indistinguishable — each is some `_SYNC_SUCCESS` — so the
 * ordering comes from here, and getting it backwards either invents successes or hangs a run.
 */
describe('the operator chain, which orders polling', () => {
  test('is walked from the entry of the graph, in the order a device meets it', () => {
    assert.deepEqual(operationChain(), ['initialLoad', 'shipmentUpdate', 'received']);
  });

  test('stops where the chain leaves this app — nothing after Received at 3PL is ours', () => {
    const chain = operationChain();
    assert.equal(chain[chain.length - 1], 'received');
    // 1 New is where the customer, installer and network take over.
    assert.deepEqual(operationMovement('received').to, [1]);
  });

  test('each link is a real transition out of the previous one, not an assumed sequence', () => {
    const chain = operationChain();
    for (let i = 1; i < chain.length; i++) {
      const previous = operationMovement(chain[i - 1]);
      const current = operationMovement(chain[i]);
      assert.ok(
        current.from.some((stage) => previous.to.includes(stage)),
        `${chain[i]} does not start where ${chain[i - 1]} ends`
      );
    }
  });

  test('every chain operation can actually be polled, or ordering it is pointless', () => {
    for (const operation of operationChain()) {
      assert.ok(syncStatusBase(operation), `${operation} has no Sync_Status__c base`);
    }
  });

  test('a sync base maps back to the operation that wrote it', () => {
    for (const operation of operationChain()) {
      assert.equal(operationForSyncBase(syncStatusBase(operation)), operation);
    }
  });

  test('the $comment entry in the sync map is not mistaken for a status', () => {
    assert.equal(operationForSyncBase('$comment'), null);
    assert.equal(operationForSyncBase('SOMETHING_UNMODELLED'), null);
  });

  test('dataUpdate moves no device, so it is deliberately off the chain', () => {
    assert.equal(operationMovement('dataUpdate'), null);
    assert.ok(!operationChain().includes('dataUpdate'));
    // It is still pollable — it just cannot be ordered against the others.
    assert.equal(syncStatusBase('dataUpdate'), 'DATA_UPDATE');
  });
});
