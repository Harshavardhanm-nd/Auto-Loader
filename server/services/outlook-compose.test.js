/**
 * The compose-open retry decision.
 *
 * Outlook in this tenant takes 16.6–18.8s to render the recipient box (measured against the live
 * mailbox on 2026-08-19, three cold starts). The budget was 20s, so an ordinary slowdown expired
 * it on a window that was about to appear — and the recovery then pressed Escape and clicked
 * "New email" again, putting a *second* compose on screen. Every fill/attach/send helper resolves
 * `.first()`, so recipients went into one panel and Send was pressed on the other, empty one:
 * "This message must have at least one recipient", nothing sent, and on 2026-08-17 two real
 * untracked sends to staging.
 *
 * These tests pin the rule that makes a second panel structurally impossible: a panel that exists
 * is used, never discarded; only a genuine absence is retried; two panels are never worked with.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeRetryDecision, sendControlDecision } from './outlook-web-service.js';

test('a panel that rendered late is used, not discarded', () => {
  // The bug: this case used to Escape the panel and click New email again.
  assert.equal(composeRetryDecision(1), 'use');
});

test('a genuine absence is retried — a swallowed click must still recover', () => {
  assert.equal(composeRetryDecision(0), 'retry');
});

test('two panels are never worked with, because .first() is not a stable identity', () => {
  assert.equal(composeRetryDecision(2), 'ambiguous');
  assert.equal(composeRetryDecision(5), 'ambiguous');
});

test('an unreadable count is treated as absent, never as ambiguous', () => {
  // countComposePanels() swallows its own errors to 0; a failed count must not abort a send.
  assert.equal(composeRetryDecision(NaN), 'retry');
  assert.equal(composeRetryDecision(undefined), 'retry');
  assert.equal(composeRetryDecision(null), 'retry');
});

test('a negative count cannot be read as ambiguous', () => {
  assert.equal(composeRetryDecision(-1), 'retry');
});

/**
 * Which control may be clicked as "Send".
 *
 * Outlook renders Send as two adjacent buttons: `<button aria-label="Send">` and, beside it,
 * `<button role="button" aria-label="More send options" aria-haspopup="menu">` — the caret that
 * opens Send / Schedule send / Start mail merge. Verified against the live mailbox 2026-09-16.
 *
 * On 2026-09-16 a Driveri initial load failed after 207s with "Outlook did not confirm that the
 * message was sent", and the diagnostic screenshot showed the message fully composed with that
 * menu hanging open. Send had been greyed out (Outlook does this while it finishes an attachment),
 * so every selector meaning the real Send was correctly skipped as disabled — and the last rung of
 * the selector ladder, `[role="button"][aria-label*="Send" i]`, matches "More send options" and
 * nothing else, because the real Send button carries no literal `role` attribute. The caret is
 * never disabled, so it was the only thing left that looked clickable. Clicking it opened a menu
 * and sent nothing.
 *
 * These tests pin the rule that makes that structurally impossible: a control that opens a menu
 * is not a control that performs an action, whatever its label says.
 */

test('the real Send button is clicked', () => {
  assert.equal(
    sendControlDecision({ visible: true, disabled: false, ariaDisabled: null, hasPopup: null }),
    'click'
  );
});

test('a control that opens a menu is never clicked, however its label reads', () => {
  // The bug: "More send options" matched a Send selector and was clicked instead of Send.
  assert.equal(
    sendControlDecision({ visible: true, disabled: false, ariaDisabled: null, hasPopup: 'menu' }),
    'skip'
  );
});

test('any popup kind is refused, not just a menu', () => {
  // Outlook renames things; the fix must not depend on this one value.
  assert.equal(
    sendControlDecision({ visible: true, disabled: false, ariaDisabled: null, hasPopup: 'true' }),
    'skip'
  );
  assert.equal(
    sendControlDecision({ visible: true, disabled: false, ariaDisabled: null, hasPopup: 'dialog' }),
    'skip'
  );
});

test('aria-haspopup="false" is not a popup — it is the real button saying so', () => {
  // Tri-state, the same rule notForSale follows: absent and "false" are both "not a popup".
  assert.equal(
    sendControlDecision({ visible: true, disabled: false, ariaDisabled: null, hasPopup: 'false' }),
    'click'
  );
});

test('a greyed-out Send is skipped rather than clicked', () => {
  assert.equal(
    sendControlDecision({ visible: true, disabled: true, ariaDisabled: null, hasPopup: null }),
    'skip'
  );
  assert.equal(
    sendControlDecision({ visible: true, disabled: false, ariaDisabled: 'true', hasPopup: null }),
    'skip'
  );
});

test('an invisible control is skipped', () => {
  assert.equal(
    sendControlDecision({ visible: false, disabled: false, ariaDisabled: null, hasPopup: null }),
    'skip'
  );
});

test('a control that could not be read is skipped, never clicked', () => {
  // A refused send is recoverable; a click on an unidentified control next to Send is not.
  assert.equal(sendControlDecision(null), 'skip');
  assert.equal(sendControlDecision(undefined), 'skip');
  assert.equal(sendControlDecision({}), 'skip');
});
