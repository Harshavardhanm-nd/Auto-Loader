/**
 * Which account an Undo Dead row names: the customer the device belonged to before it came back,
 * not the account it sits on now.
 *
 * A returned device is moved onto the org's Install Check account, and it stays there through
 * Dead — so `Asset.AccountId` on a dead device is the holding account, never the customer.
 * Salesforce records the customer in `Prior_to_RMA_AccountId__c` when the return starts, on the
 * non-RMA path as well as the RMA one. Verified in staging 2026-09-30 on 1250800000: AccountId is
 * Install Check Account, Prior_to_RMA_AccountId__c is 001ib000000ksqGAAQ, and the Asset's field
 * history shows exactly that move (Install Check → 001ib000000ksqGAAQ → Install Check).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { undoDeadAccount } from './undo-dead-account.js';

const INSTALL_CHECK = '001Hp00002d4iLpIAI';
const CUSTOMER = '001ib000000ksqGAAQ';

test('the prior account is used, not the current one', () => {
  assert.deepEqual(
    undoDeadAccount({ currentAccountId: INSTALL_CHECK, priorAccountId: CUSTOMER }),
    { accountId: CUSTOMER }
  );
});

test('no prior account is refused — the current one is the holding account, not a fallback', () => {
  const { problem } = undoDeadAccount({ currentAccountId: INSTALL_CHECK, priorAccountId: null });
  assert.match(problem, /Prior_to_RMA_AccountId__c is empty/);
});

test('a blank prior account is refused like a missing one', () => {
  assert.ok(undoDeadAccount({ currentAccountId: INSTALL_CHECK, priorAccountId: '  ' }).problem);
});

test('a prior account equal to the current one is refused', () => {
  // Seen on older dead devices in both orgs: the field holds the Install Check account itself.
  // Writing it would "restore" the device to the account it is already parked on.
  const { problem } = undoDeadAccount({ currentAccountId: INSTALL_CHECK, priorAccountId: INSTALL_CHECK });
  assert.match(problem, /same as its current account/);
});

test('a device with no Asset is refused', () => {
  assert.match(undoDeadAccount(null).problem, /No Asset/);
});
