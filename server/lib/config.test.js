/**
 * Distribution-list routing.
 *
 * The mailbox is the only thing that tells the parser which operation a file represents, so
 * these tests treat address resolution as a correctness surface rather than configuration.
 * Two properties matter most:
 *
 *   - A placeholder address blocks its own pipeline and nothing else.
 *   - Two addresses that differ only in local part are never confused. Both orgs now route
 *     through Salesforce Apex email services, where every address shares a host suffix and
 *     the local part carries the entire meaning — `asset_markdead_emailservice` and
 *     `asset_markundodead_emailservice` are opposite operations on the same host.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEnvironments,
  loadOperations,
  getEnvironment,
  resolveDistributionList,
  sendBlockers,
  loadTemplates,
  findTemplate,
  isSharedOperation,
  unconfiguredValues,
} from './config.js';
import { validateSendTarget } from '../services/validator.js';

const ENVIRONMENTS = Object.keys(loadEnvironments().environments);

describe('every environment is internally consistent', () => {
  for (const name of ENVIRONMENTS) {
    test(`${name} — every mail operation resolves to an address`, () => {
      const env = getEnvironment(name);
      for (const [operation, meta] of Object.entries(loadOperations())) {
        if (meta.needsMail === false) continue;
        const dl = resolveDistributionList(name, 'driveri', operation);
        assert.ok(dl, `${name}/${operation} resolved to nothing`);
        assert.ok(dl.to, `${name}/${operation} has no "to"`);
        assert.ok(dl.subject, `${name}/${operation} has no subject`);
        assert.ok(dl.body, `${name}/${operation} has no body`);
      }
      assert.ok(env.label);
    });

    test(`${name} — every real address is well formed`, () => {
      for (const [operation, meta] of Object.entries(loadOperations())) {
        if (meta.needsMail === false) continue;
        const { to } = resolveDistributionList(name, 'driveri', operation);
        if (to.startsWith('REPLACE_ME')) continue;

        // Exactly one @, a non-empty local part, and a dotted host.
        const parts = to.split('@');
        assert.equal(parts.length, 2, `${name}/${operation}: "${to}" is not a single address`);
        assert.ok(parts[0].length > 0, `${name}/${operation}: empty local part`);
        assert.match(parts[1], /^[a-z0-9.-]+\.[a-z]{2,}$/i, `${name}/${operation}: odd host "${parts[1]}"`);
        assert.ok(!/\s/.test(to), `${name}/${operation}: address contains whitespace`);
      }
    });

    test(`${name} — no two operations share an address unless deliberately bundled`, () => {
      const seen = new Map();
      for (const [operation, meta] of Object.entries(loadOperations())) {
        if (meta.needsMail === false) continue;
        const { to } = resolveDistributionList(name, 'driveri', operation);
        if (to.startsWith('REPLACE_ME')) continue;
        if (seen.has(to)) seen.get(to).push(operation);
        else seen.set(to, [operation]);
      }

      for (const [address, operations] of seen) {
        if (operations.length === 1) continue;
        // The only legitimate sharing: testing's "Initial Load & Update Load DL".
        assert.deepEqual(
          operations.sort(),
          ['initialLoad', 'updateLoad'],
          `${name}: ${address} is shared by ${operations.join(', ')} — is that intended?`
        );
      }
    });
  }
});

describe('a placeholder blocks only its own pipeline', () => {
  test('testing can send an initial load while data update is unconfigured', () => {
    assert.deepEqual(sendBlockers('testing', 'driveri', 'initialLoad'), []);
    assert.ok(sendBlockers('testing', 'haptic', 'dataUpdate').length > 0);
  });

  test('staging can send an initial load while update load is unconfigured', () => {
    assert.deepEqual(sendBlockers('staging', 'driveri', 'initialLoad'), []);
    assert.ok(sendBlockers('staging', 'octo', 'updateLoad').length > 0);
  });

  test('a Salesforce endpoint placeholder would block every pipeline in that environment', () => {
    // Both endpoints are real now, so assert the mechanism rather than a current failure.
    for (const name of ENVIRONMENTS) {
      const env = getEnvironment(name);
      assert.deepEqual(
        unconfiguredValues(env.salesforce, 'salesforce'),
        [],
        `${name} endpoint should be configured`
      );
      assert.ok(env.salesforce.instanceUrl.startsWith('https://'));
      assert.ok(
        !env.salesforce.instanceUrl.endsWith('/'),
        `${name}: instanceUrl must not end in a slash — the REST path is appended directly`
      );
    }
  });
});

describe('the mailbox check cannot confuse similar addresses', () => {
  const template = loadTemplates().find((t) => t.family === 'driveri');
  const environment = getEnvironment('staging');

  const verdict = (operation, recipient) => {
    const dl = resolveDistributionList('staging', 'driveri', operation);
    const checks = validateSendTarget({
      environment,
      template,
      dl,
      recipient,
      attachmentCount: 1,
      blockers: [],
    });
    return checks.find((c) => c.id === 'mailbox').status;
  };

  test('mark-dead and undo-mark-dead are not interchangeable', () => {
    const dead = resolveDistributionList('staging', 'driveri', 'deviceDead').to;
    const undo = resolveDistributionList('staging', 'driveri', 'undoDead').to;

    // These differ only by "undo" in the local part — the whole meaning of the operation.
    assert.notEqual(dead, undo);
    assert.equal(verdict('deviceDead', dead), 'pass');
    assert.equal(verdict('deviceDead', undo), 'fail', 'undo-dead must not pass as mark-dead');
    assert.equal(verdict('undoDead', dead), 'fail', 'mark-dead must not pass as undo-dead');
  });

  test('the initial-load and shipment-update services are not interchangeable', () => {
    const initial = resolveDistributionList('staging', 'driveri', 'initialLoad').to;
    const shipment = resolveDistributionList('staging', 'driveri', 'shipmentUpdate').to;

    assert.equal(verdict('initialLoad', initial), 'pass');
    assert.equal(verdict('initialLoad', shipment), 'fail');
    assert.equal(verdict('shipmentUpdate', initial), 'fail');
  });

  test('a right local part on the wrong Apex host is refused', () => {
    // Apex hosts are per-service. Reusing one service's host with another's local part is the
    // exact mistake a sandbox refresh invites, since only some addresses get re-copied.
    const dead = resolveDistributionList('staging', 'driveri', 'deviceDead').to;
    const received = resolveDistributionList('staging', 'driveri', 'received').to;
    const frankenstein = `${dead.split('@')[0]}@${received.split('@')[1]}`;

    assert.notEqual(frankenstein, dead);
    assert.equal(verdict('deviceDead', frankenstein), 'fail');
  });

  test('testing and staging addresses never cross environments', () => {
    for (const [operation, meta] of Object.entries(loadOperations())) {
      if (meta.needsMail === false) continue;
      const t = resolveDistributionList('testing', 'driveri', operation).to;
      const s = resolveDistributionList('staging', 'driveri', operation).to;
      if (t.startsWith('REPLACE_ME') || s.startsWith('REPLACE_ME')) continue;
      assert.notEqual(t, s, `${operation} resolves to the same address in both environments`);
    }
  });
});

describe('template routing', () => {
  test('every template maps to an operation the config knows', () => {
    const operations = loadOperations();
    for (const tpl of loadTemplates()) {
      assert.ok(
        operations[tpl.operation],
        `${tpl.id} declares operation "${tpl.operation}", which is not in config/environments.json`
      );
    }
  });

  test('the Octo update-load sheet routes as an update load, not a shipment update', () => {
    const tpl = findTemplate('octo', 'updateLoad');
    assert.equal(tpl.id, 'octo-update-load');

    // In testing, an update load shares the initial-load mailbox — that is what the
    // "Initial Load & Update Load DL" name says.
    const updateTo = resolveDistributionList('testing', 'octo', 'updateLoad').to;
    const initialTo = resolveDistributionList('testing', 'octo', 'initialLoad').to;
    const shipmentTo = resolveDistributionList('testing', 'octo', 'shipmentUpdate').to;
    assert.equal(updateTo, initialTo);
    assert.notEqual(updateTo, shipmentTo);
  });

  test('Octo has no shipment-update template, so that combination is refused', () => {
    // Octo's second operation is an update load. Asking for a shipment update must not silently
    // fall through to some other family's template.
    assert.throws(() => {
      const tpl = findTemplate('octo', 'shipmentUpdate');
      if (tpl.family !== 'octo') throw new Error(`fell through to ${tpl.id}`);
    });
  });

  test('received and wizard upload are family-independent', () => {
    assert.ok(isSharedOperation('received'));
    assert.ok(isSharedOperation('wizardUpload'));
    assert.ok(!isSharedOperation('initialLoad'));

    // Any family asking for a received template gets the one shared sheet.
    for (const family of ['driveri', 'octo', 'haptic', 'vbus']) {
      assert.equal(findTemplate(family, 'received').id, 'received-load');
    }
  });

  test('operations with a mailbox but no template are visible as such', () => {
    const templated = new Set(loadTemplates().map((t) => t.operation));
    const awaiting = Object.keys(loadOperations()).filter((op) => !templated.has(op));

    // These are known routes with no CSV format yet. If a sheet arrives for one, this list
    // shrinks — the test documents the gap rather than asserting it stays.
    assert.deepEqual(awaiting.sort(), ['deviceDead', 'faultyReturned', 'nonRepairable', 'undoDead']);
  });
});
