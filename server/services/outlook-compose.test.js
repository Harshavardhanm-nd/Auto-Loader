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

import { composeRetryDecision } from './outlook-web-service.js';

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
