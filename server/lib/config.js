import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, TEMPLATES_DIR, readJson } from './paths.js';

const REPLACE_ME = 'REPLACE_ME';

export function loadEnvironments() {
  return readJson(path.join(CONFIG_DIR, 'environments.json'));
}

export function loadProfiles() {
  return readJson(path.join(CONFIG_DIR, 'profiles.json'));
}

export function loadOperations() {
  return loadEnvironments().operations;
}

/**
 * Every value in a config subtree that is still a placeholder. Sending is refused while the
 * pipeline in play has any, which is what makes an unconfirmed address safe to leave in the
 * file rather than a wrong-mailbox hazard.
 */
export function unconfiguredValues(node, trail = '') {
  const found = [];
  for (const [key, value] of Object.entries(node ?? {})) {
    if (key.startsWith('$')) continue;
    const at = trail ? `${trail}.${key}` : key;
    if (typeof value === 'string' && value.startsWith(REPLACE_ME)) found.push(at);
    else if (value && typeof value === 'object') found.push(...unconfiguredValues(value, at));
  }
  return found;
}

export function getEnvironment(envName) {
  const { environments } = loadEnvironments();
  const env = environments[envName];
  if (!env) {
    throw new Error(
      `Unknown environment "${envName}". Available: ${Object.keys(environments).join(', ')}`
    );
  }
  return { name: envName, ...env, unconfigured: unconfiguredValues(env) };
}

/**
 * Resolve the mailbox for one pipeline.
 *
 * A family gets its own entry only when it does not use the shared mailbox for that
 * operation; otherwise the operation-level address applies. Returning the resolution source
 * lets the UI show *why* an address was chosen, which matters when the only thing
 * distinguishing two operations is the address itself.
 *
 * @returns {{to, subject, body, source, key, unconfigured: string[]}|null}
 *          null when the operation sends no mail at all (the wizard upload).
 */
export function resolveDistributionList(envName, family, operation) {
  const env = getEnvironment(envName);
  const operations = loadOperations();

  if (operations[operation]?.needsMail === false) return null;

  const lists = env.distributionLists ?? {};
  const familyKey = `${family}:${operation}`;

  const override = lists.byFamilyOperation?.[familyKey];
  const shared = lists.byOperation?.[operation];
  const chosen = override ?? shared;

  if (!chosen) {
    throw new Error(
      `No distribution list configured for ${familyKey} in ${envName}. Add it to ` +
        'config/environments.json under distributionLists.byOperation or byFamilyOperation.'
    );
  }

  return {
    ...chosen,
    source: override ? 'byFamilyOperation' : 'byOperation',
    key: override ? familyKey : operation,
    unconfigured: unconfiguredValues(chosen),
  };
}

/** Everything blocking a send for this pipeline: the mailbox and the SF endpoint. */
export function sendBlockers(envName, family, operation) {
  const env = getEnvironment(envName);
  const blockers = [];

  const sfPlaceholders = unconfiguredValues(env.salesforce, 'salesforce');
  blockers.push(...sfPlaceholders);

  const dl = resolveDistributionList(envName, family, operation);
  if (dl) blockers.push(...dl.unconfigured.map((p) => `distributionLists.${dl.key}.${p}`));

  return blockers;
}

export function getSmtpConfig() {
  return loadEnvironments().smtp;
}

export function getMailConfig() {
  return loadEnvironments().mail ?? { transport: 'smtp', autoSend: false };
}

/** All template descriptors, including any still awaiting a real format. */
export function loadTemplates() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson(path.join(TEMPLATES_DIR, f)));
}

export function getTemplate(id) {
  const tpl = loadTemplates().find((t) => t.id === id);
  if (!tpl) throw new Error(`Unknown template "${id}"`);
  return tpl;
}

export function isTemplateUsable(tpl) {
  return tpl.status === 'verified';
}

/** Templates grouped for the picker: family → operation → template. */
export function templateIndex() {
  const templates = loadTemplates();
  const families = new Map();

  for (const tpl of templates) {
    if (!families.has(tpl.family)) {
      families.set(tpl.family, {
        family: tpl.family,
        label: tpl.familyLabel,
        kind: tpl.kind,
        operations: {},
      });
    }
    families.get(tpl.family).operations[tpl.operation] = tpl.id;
  }

  return { templates, families: [...families.values()] };
}

export const SHARED_FAMILY = 'shared';

/**
 * The template for one (family, operation) pair.
 *
 * Falls back to a `shared` template, because some operations are family-independent: the
 * received-at-3PL sheet has an identical 5-column header for Driveri, Octo and Haptic, and
 * the wizard uploads carry only a SKU and a serial. Those are one template used by everyone,
 * not one per family.
 */
/**
 * Operations whose CSV format is the family's own format for another operation.
 *
 * A data update is the initial-load sheet sent for a device that already exists — the mailbox is
 * what tells the parser which operation a file represents, and `dataUpdate` and `initialLoad`
 * share one. `octo-data-update.json` is byte-identical to `octo-initial-load.json` apart from its
 * id, operation, label and filename, which is the evidence for this rather than an assumption.
 *
 * Declaring it here rather than copying four more descriptors into `templates/` keeps one format
 * per family: a correction to a family's initial-load columns reaches its data update for free,
 * where a copy would silently drift.
 */
const FORMAT_BORROWED_FROM = { dataUpdate: 'initialLoad' };

/** `dataUpdate` -> `Data Update`, the form an operation takes in a label. */
function operationWords(operation) {
  return operation.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** `dataUpdate` -> `data-update`, the form an operation takes in a template id. */
function operationSlug(operation) {
  return operation.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * A template for `operation` built from the same family's descriptor for another operation.
 *
 * The filename is rewritten, and that is not cosmetic: artifacts are written to
 * `data/output/<runId>/` under their own filename with no key prefix, so a derived data update
 * keeping `Initial_Load_Driveri_{trackingId}.csv` would overwrite the run's real initial-load CSV
 * inside that run's output directory. Only the leading operation segment is replaced, so the
 * family segment keeps the casing its own descriptor declares — `DHUB` and `VBUS`, not a
 * re-derived guess.
 *
 * `status` is inherited. The bytes were byte-checked against a real accepted sheet, and the org
 * takes that same sheet as a data update — which is what Octo and Haptic already demonstrate.
 * `derivedFrom` records where the format came from, so a preview can say so rather than implying
 * a separately verified sheet.
 */
function deriveTemplate(base, operation) {
  return {
    ...base,
    id: `${base.id.replace(new RegExp(`-${operationSlug(base.operation)}$`), '')}-${operationSlug(operation)}`,
    operation,
    label: base.label.replace(new RegExp(`${operationWords(base.operation)}$`), operationWords(operation)),
    filenamePattern: base.filenamePattern.replace(
      new RegExp(`^${operationWords(base.operation).replace(/ /g, '_')}_`),
      `${operationWords(operation).replace(/ /g, '_')}_`
    ),
    derivedFrom: base.id,
  };
}

export function findTemplate(family, operation) {
  const templates = loadTemplates();
  const exact = templates.find((t) => t.family === family && t.operation === operation);
  if (exact) return exact;

  // A family with no sheet of its own for a format-borrowing operation uses the sheet it borrows
  // from. Checked before the shared fallback so a shared descriptor never shadows a family format.
  const borrowedFrom = FORMAT_BORROWED_FROM[operation];
  if (borrowedFrom) {
    const base = templates.find((t) => t.family === family && t.operation === borrowedFrom);
    if (base) return deriveTemplate(base, operation);
  }

  const shared = templates.find((t) => t.family === SHARED_FAMILY && t.operation === operation);
  if (shared) return shared;

  const available = templates.filter((t) => t.family === family).map((t) => t.operation);
  throw new Error(
    `No "${operation}" template for family "${family}". ` +
      `That family supports: ${available.join(', ') || '(none)'}`
  );
}

/**
 * The template for one (family, operation) pair, or null when there is none.
 *
 * Same resolution as `findTemplate` — exact, then borrowed format, then shared — for the callers
 * that list what a run *could* do rather than act on it. Listing from the raw descriptor files
 * instead would report a derived template as unsupported, and Review would show an operation the
 * Watch page had just generated a file for as having no format.
 */
export function findTemplateOrNull(family, operation) {
  try {
    return findTemplate(family, operation);
  } catch {
    return null;
  }
}

/** True when the operation is served by one family-independent template. */
export function isSharedOperation(operation) {
  const templates = loadTemplates();
  if (templates.some((t) => t.family !== SHARED_FAMILY && t.operation === operation)) return false;
  return templates.some((t) => t.family === SHARED_FAMILY && t.operation === operation);
}
