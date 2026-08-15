import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadLifecycle } from './lifecycle.js';

describe('the stage-step shape the model exposes', () => {
  test('carries no $-prefixed documentation keys', () => {
    // $comment is documentation for whoever edits config/lifecycle.json. It belongs in the file
    // and not in the model — three later tasks read this array, and one of them serialises it.
    for (const step of loadLifecycle().stageSteps) {
      assert.deepEqual(
        Object.keys(step).filter((k) => k.startsWith('$')),
        [],
        `stage step "${step.operation}" leaks a documentation key`
      );
    }
  });

  test('every entry names an operation', () => {
    for (const step of loadLifecycle().stageSteps) {
      assert.ok(step.operation, 'a stage step with no operation should have been filtered out');
    }
  });
});
