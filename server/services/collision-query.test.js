import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { COLLISION_FIELDS, collisionChunkSize, collisionQueryPlan, QUERY_URL_LIMIT } from './sf-client.js';

/**
 * The shape of the collision check, which is the whole cost of allocating ids.
 *
 * Allocation is 100% network wait — measured against testing on 2026-08-15, Octo took **33.7 s**
 * of which 33.7 s was Salesforce. Three facts from that measurement drive this plan:
 *
 *   1. A query's cost is almost flat in the number of ids: `Name IN (300)` took 654 ms and
 *      `Name IN (900)` took 686 ms. The ~1–2.4 s is *fixed per round trip*, so chunking at 75 ids
 *      multiplied a fixed cost by the chunk count and bought nothing.
 *   2. One `OR` across all four fields cost ~2.4 s where a single-field query cost ~1.1 s. `Asset`
 *      holds 860,748 rows in this org, and an OR over four fields cannot be served from one index.
 *   3. The chunks are independent, and were awaited one at a time. Twelve queries took 10.3 s
 *      serially and 1.95 s at concurrency 8, with no failures.
 *
 * So: one field per query, chunks as large as the URL allows, run concurrently.
 */

const ids = (start, n, pad = 11) =>
  Array.from({ length: n }, (_, i) => String(start + i).padStart(pad, '0'));

/** What the driver actually sends: the SOQL is URL-encoded into a GET. */
const encodedLength = (soql) => encodeURIComponent(soql).length;

describe('how many ids go in one query', () => {
  test('scales with how wide the ids are', () => {
    // A 6-digit Haptic serial costs less per entry than an 11-digit Driveri id, so more fit.
    assert.ok(collisionChunkSize(ids(100000, 5, 6)) > collisionChunkSize(ids(22600379190, 5, 11)));
  });

  test('never chunks so small that allocation goes chatty again', () => {
    // The bug being fixed: 75 ids per query meant 14 round trips for one Octo allocation.
    assert.ok(collisionChunkSize(ids(22600379190, 5, 11)) >= 200, 'a chunk this small is the old bug');
  });

  test('is stable whatever the caller passes', () => {
    assert.ok(collisionChunkSize([]) >= 25);
    assert.ok(collisionChunkSize() >= 25);
  });
});

describe('the query plan for a batch of candidates', () => {
  const CANDIDATES = ids(22600379190, 1300, 11);

  test('asks about every candidate exactly once per field', () => {
    const plan = collisionQueryPlan(CANDIDATES);
    for (const field of COLLISION_FIELDS) {
      const forField = plan.filter((q) => q.includes(`WHERE ${field} IN`));
      const asked = new Set();
      for (const q of forField) for (const m of q.matchAll(/'(\d+)'/g)) asked.add(m[1]);
      assert.equal(asked.size, CANDIDATES.length, `${field} must cover every candidate`);
    }
  });

  test('no query ORs across fields — that is what made each one twice as slow', () => {
    for (const q of collisionQueryPlan(CANDIDATES)) {
      const where = q.slice(q.indexOf('WHERE'));
      assert.equal(where.includes(' OR '), false, `a collision query must name one field: ${where.slice(0, 80)}`);
      assert.equal(
        COLLISION_FIELDS.filter((f) => where.includes(`${f} IN`)).length,
        1,
        'exactly one field per query'
      );
    }
  });

  test('every query still SELECTs all four fields', () => {
    // A row matched on `Name` may carry a taken `SIM_Serial__c`, and `takenFromRecords` reads all
    // four off every record. Narrowing the SELECT to the field being matched would miss those.
    for (const q of collisionQueryPlan(CANDIDATES)) {
      for (const field of COLLISION_FIELDS) assert.ok(q.includes(field), `${field} must be selected`);
    }
  });

  test('no query can exceed the URL limit Salesforce enforces', () => {
    // Measured: 900 eleven-digit ids is 14,588 chars and works; 1,200 is 19,388 and comes back as
    // an HTML error page rather than JSON.
    for (const q of collisionQueryPlan(CANDIDATES)) {
      assert.ok(encodedLength(q) < QUERY_URL_LIMIT, `query is ${encodedLength(q)} encoded chars`);
    }
  });

  test('holds under the limit for the widest ids a descriptor mints', () => {
    for (const width of [6, 8, 9, 10, 11]) {
      for (const q of collisionQueryPlan(ids(1, 2000, width))) {
        assert.ok(encodedLength(q) < QUERY_URL_LIMIT, `${width}-digit ids overflow the URL`);
      }
    }
  });

  test('a whole Octo allocation costs far fewer round trips than it did', () => {
    // Octo probes 5 series × (10 + 250) = 1,300 candidates. That was 14 sequential queries.
    const plan = collisionQueryPlan(CANDIDATES);
    assert.ok(plan.length <= COLLISION_FIELDS.length * 3, `plan is ${plan.length} queries`);
  });

  test('a single-series family is one round trip per field', () => {
    // DHUB/DMS/Haptic probe 260 candidates — that used to be 4 sequential queries and is now
    // 4 concurrent ones, which is a single wave.
    assert.equal(collisionQueryPlan(ids(4011301001, 260, 10)).length, COLLISION_FIELDS.length);
  });

  test('duplicates are asked about once', () => {
    const plan = collisionQueryPlan(['123', '123', '456']);
    const asked = new Set();
    for (const m of plan[0].matchAll(/'(\d+)'/g)) asked.add(m[1]);
    assert.deepEqual([...asked].sort(), ['123', '456']);
  });

  test('nothing to check is no queries at all', () => {
    assert.deepEqual(collisionQueryPlan([]), []);
    assert.deepEqual(collisionQueryPlan(), []);
    assert.deepEqual(collisionQueryPlan([null, undefined, '']), []);
  });
});
