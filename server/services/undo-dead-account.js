/**
 * The account an Undo Dead row names: the customer the device belonged to before it was returned.
 *
 * A returned device is moved onto the org's Install Check account and stays there through Dead,
 * so its current `AccountId` is the holding account. Salesforce records the customer in
 * `Prior_to_RMA_AccountId__c` when the return starts — on the non-RMA path too, despite the name.
 * See `undo-dead-account.test.js` for the staging evidence.
 *
 * Refuses rather than falls back. Using the current account would write the holding account into
 * the file and park the device there for good; the operator has to see the gap and decide.
 *
 * @param {{currentAccountId: string|null, priorAccountId: string|null}|null} asset
 * @returns {{accountId: string} | {problem: string}}
 */
export function undoDeadAccount(asset) {
  if (!asset) return { problem: 'No Asset found in Salesforce.' };
  const prior = String(asset.priorAccountId ?? '').trim();
  if (!prior) {
    return {
      problem:
        'Prior_to_RMA_AccountId__c is empty, so the account it belonged to before the return is ' +
        'not recorded.',
    };
  }
  if (prior === String(asset.currentAccountId ?? '').trim()) {
    return {
      problem:
        `Prior_to_RMA_AccountId__c (${prior}) is the same as its current account — the holding ` +
        'account, not the customer it came back from.',
    };
  }
  return { accountId: prior };
}
