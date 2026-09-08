import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { findTemplate, findTemplateOrNull, loadTemplates } from './config.js';

/**
 * Families that ship a device but have no data-update sheet of their own.
 *
 * A data update is the initial-load format sent to the data-update mailbox for a device that
 * already exists — `octo-data-update.json` is byte-identical to `octo-initial-load.json` apart
 * from its id, operation, label and filename. So these four need no new descriptor; they need
 * their initial-load one re-pointed.
 */
const DERIVED_FAMILIES = ['driveri', 'dhub', 'dms', 'vbus'];

/** Families whose data-update sheet is declared in templates/ and must not be derived over. */
const DECLARED_FAMILIES = ['octo', 'haptic'];

describe('derived data-update templates', () => {
  test('every device family resolves a data-update template', () => {
    for (const family of [...DERIVED_FAMILIES, ...DECLARED_FAMILIES]) {
      const tpl = findTemplate(family, 'dataUpdate');
      assert.equal(tpl.operation, 'dataUpdate', family);
      assert.equal(tpl.family, family, family);
    }
  });

  test('a declared data-update sheet is never derived over', () => {
    for (const family of DECLARED_FAMILIES) {
      const tpl = findTemplate(family, 'dataUpdate');
      assert.equal(tpl.derivedFrom, undefined, family);
      assert.equal(tpl.id, `${family}-data-update`, family);
    }
  });

  test('a derived template records the format it borrowed', () => {
    for (const family of DERIVED_FAMILIES) {
      const tpl = findTemplate(family, 'dataUpdate');
      assert.equal(tpl.derivedFrom, `${family}-initial-load`, family);
      assert.equal(tpl.id, `${family}-data-update`, family);
    }
  });

  test('a derived template carries the exact bytes of the sheet it borrows', () => {
    for (const family of DERIVED_FAMILIES) {
      const derived = findTemplate(family, 'dataUpdate');
      const base = findTemplate(family, 'initialLoad');
      assert.deepEqual(derived.columns, base.columns, family);
      assert.deepEqual(derived.byteContract, base.byteContract, family);
      assert.deepEqual(derived.series, base.series, family);
      assert.equal(derived.status, base.status, family);
    }
  });

  test('no derived filename collides with a declared one', () => {
    // Artifacts are written to data/output/<runId>/ under their own filename with no key prefix,
    // so a derived data update reusing the initial-load pattern would overwrite the run's real
    // initial-load CSV inside one run's output directory.
    const declared = new Set(loadTemplates().map((t) => t.filenamePattern));
    for (const family of DERIVED_FAMILIES) {
      const pattern = findTemplate(family, 'dataUpdate').filenamePattern;
      assert.equal(declared.has(pattern), false, `${family}: ${pattern} collides with a declared sheet`);
      assert.match(pattern, /^Data_Update_/, family);
    }
  });

  test('a derived filename keeps the family segment its own sheet declares', () => {
    assert.equal(findTemplate('dhub', 'dataUpdate').filenamePattern, 'Data_Update_DHUB_{trackingId}.csv');
    assert.equal(findTemplate('vbus', 'dataUpdate').filenamePattern, 'Data_Update_VBUS_{trackingId}.csv');
    assert.equal(findTemplate('driveri', 'dataUpdate').filenamePattern, 'Data_Update_Driveri_{trackingId}.csv');
  });

  test('a family with no sheet at all is still refused by name', () => {
    assert.throws(() => findTemplate('nosuchfamily', 'dataUpdate'), /No "dataUpdate" template/);
  });

  test('a derived template is visible to the non-throwing lookup the UI lists from', () => {
    // Review validates the operation Watch hands it against its own list, and that list is built
    // by resolving (family, operation) pairs. Resolving them from the raw descriptor files would
    // show a derived data update as unsupported, and the hand-off would land on a dead tab.
    const tpl = findTemplateOrNull('driveri', 'dataUpdate');
    assert.equal(tpl?.id, 'driveri-data-update');
  });

  test('the non-throwing lookup answers null instead of throwing', () => {
    assert.equal(findTemplateOrNull('driveri', 'nosuchoperation'), null);
    assert.equal(findTemplateOrNull('nosuchfamily', 'dataUpdate'), null);
  });

  test('the non-throwing lookup still finds family-independent sheets', () => {
    assert.equal(findTemplateOrNull('driveri', 'received')?.family, 'shared');
  });
});
