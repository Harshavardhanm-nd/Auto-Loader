import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPricebookEntrySoql, isSalesforceId } from './sf-client.js';

/**
 * The pricebook membership query.
 *
 * `pricebookId` is the only value in this app that reaches SOQL straight from an HTTP query string,
 * so it is validated as a Salesforce id rather than escaped — the same choice `safeSeries` makes for
 * config-supplied series names. A value that could terminate the string literal is refused.
 *
 * Real ids from the testing org, 2026-08-27: Standard Price Book is `01s36000005K1LMAA0` (18 chars),
 * Netradyne CPQ is `01s1Q000007FOQ3QAO`.
 */

const STANDARD = '01s36000005K1LMAA0';

describe('validating a Salesforce id', () => {
  test('15 and 18 character ids are accepted', () => {
    assert.equal(isSalesforceId('01s36000005K1LM'), true);
    assert.equal(isSalesforceId(STANDARD), true);
  });

  test('anything that could break out of a SOQL literal is refused', () => {
    for (const bad of ["01s3'", "x' OR Id != '", '01s3\\', '01s3 OR', '', null, undefined, 42, {}]) {
      assert.equal(isSalesforceId(bad), false, `refused: ${JSON.stringify(bad)}`);
    }
  });

  test('a plausible but wrong length is refused', () => {
    assert.equal(isSalesforceId('01s360'), false);
    assert.equal(isSalesforceId('01s36000005K1LMAA0XXX'), false);
  });
});

describe('building the membership query', () => {
  test('it asks only for Product2Id', () => {
    const soql = buildPricebookEntrySoql(STANDARD);
    // Id-only keeps the URL far inside QUERY_URL_LIMIT even for a book with thousands of entries.
    assert.match(soql, /^SELECT Product2Id\b/);
    assert.equal(
      soql.includes('Product2.'),
      false,
      'no relationship fields — this is a membership probe'
    );
  });

  test('it scopes to the book and to active entries', () => {
    const soql = buildPricebookEntrySoql(STANDARD);
    assert.ok(soql.includes('FROM PricebookEntry'));
    assert.ok(soql.includes(`Pricebook2Id = '${STANDARD}'`));
    assert.ok(soql.includes('IsActive = true'));
  });

  test('an invalid id throws rather than reaching the org', () => {
    assert.throws(() => buildPricebookEntrySoql("x' OR Id != '"), /not a Salesforce id/);
    assert.throws(() => buildPricebookEntrySoql(null), /not a Salesforce id/);
  });
});
