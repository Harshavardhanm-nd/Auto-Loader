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
export function findTemplate(family, operation) {
  const templates = loadTemplates();
  const exact = templates.find((t) => t.family === family && t.operation === operation);
  if (exact) return exact;

  const shared = templates.find((t) => t.family === SHARED_FAMILY && t.operation === operation);
  if (shared) return shared;

  const available = templates.filter((t) => t.family === family).map((t) => t.operation);
  throw new Error(
    `No "${operation}" template for family "${family}". ` +
      `That family supports: ${available.join(', ') || '(none)'}`
  );
}

/** True when the operation is served by one family-independent template. */
export function isSharedOperation(operation) {
  const templates = loadTemplates();
  if (templates.some((t) => t.family !== SHARED_FAMILY && t.operation === operation)) return false;
  return templates.some((t) => t.family === SHARED_FAMILY && t.operation === operation);
}
