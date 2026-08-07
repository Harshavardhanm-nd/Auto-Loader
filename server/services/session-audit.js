/**
 * Startup session audit.
 *
 * Both stored sessions claim to be valid purely by existing on disk: `describeSession` reports
 * `connected: true` for any record holding a sid, and `describeOutlook` reports `signedIn: true`
 * for any `outlook-auth.json`. Neither says anything about whether the credential still works.
 * A Salesforce sid dies on the org's session timeout — often a couple of hours — so a server
 * started the morning after almost always opens on two green cards that are both lies, and the
 * first thing that discovers it is whatever real work the operator started.
 *
 * This runs once at boot and replaces the claim with a fact.
 *
 * Salesforce needs no special handling: `verifyConnection` goes through the same request path as
 * everything else, which already re-mints a sid from the browser profile on a 401, retries once,
 * and retires the record if that fails. So a plain call per environment leaves the stored state
 * correct — silently renewed where it could be, marked expired where it could not — and the UI
 * reads the truth on its first poll.
 *
 * Outlook has no such path. `validateStoredSession` launches a headless browser and waits for the
 * inbox to hydrate, which is slow and cannot be rescued without an interactive sign-in, so the
 * verdict is recorded here for the UI to show rather than acted on. Nothing is deleted: an expired
 * storage state is still the record of which account was used, and throwing it away would take the
 * "Forget" decision out of the operator's hands.
 */

import { loadEnvironments } from '../lib/config.js';
import { readSession, describeSession } from './sf-session.js';
import { verifyConnection } from './sf-client.js';
import { hasStoredSession, describeOutlook, validateStoredSession } from './outlook-web-service.js';

/** Last completed audit, served to the UI so it can show what boot found. */
let last = null;
let inFlight = null;

export function lastAudit() {
  return last;
}

/**
 * Check every stored session and record the verdict.
 *
 * @param {object}   [options]
 * @param {boolean}  [options.outlook] include the Outlook check (a browser launch; ~10-30s)
 * @param {Function} [options.log]
 */
export async function auditSessions({ outlook = true, log = () => {} } = {}) {
  // Serialised: a re-run triggered from the UI while boot's own audit is still going would have
  // two headless Chromiums contending for the same profile directory.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const startedAt = new Date().toISOString();
    const salesforce = [];

    for (const env of Object.keys(loadEnvironments().environments)) {
      if (!readSession(env)) {
        const previous = describeSession(env);
        salesforce.push({
          env,
          state: 'none',
          detail: previous.expiredReason ?? 'No stored session.',
          autoRenews: previous.autoRenews,
        });
        log(`  salesforce/${env}: not connected`);
        continue;
      }

      try {
        await verifyConnection(env);
        // A silent re-mint counts as valid — that is the mechanism working, not a problem.
        const after = describeSession(env);
        salesforce.push({ env, state: 'valid', detail: `sid verified, ${after.ageMinutes}m old` });
        log(`  salesforce/${env}: valid`);
      } catch (err) {
        // request() has already retired the record, so the UI is correct from here on.
        salesforce.push({ env, state: 'expired', detail: err.message, autoRenews: describeSession(env).autoRenews });
        log(`  salesforce/${env}: EXPIRED — ${err.message}`);
      }
    }

    let mail;
    if (!hasStoredSession()) {
      mail = { state: 'none', detail: 'No saved Outlook session.' };
      log('  outlook: not signed in');
    } else if (!outlook) {
      mail = { state: 'unchecked', detail: 'Skipped (STARTUP_SESSION_CHECK=salesforce).', savedAt: describeOutlook().savedAt };
      log('  outlook: skipped');
    } else {
      const result = await validateStoredSession();
      mail = result.ok
        ? { state: 'valid', detail: 'Inbox loaded from the saved session.', savedAt: describeOutlook().savedAt }
        : { state: 'expired', detail: result.reason, savedAt: describeOutlook().savedAt };
      log(result.ok ? '  outlook: valid' : `  outlook: EXPIRED — ${result.reason}`);
    }

    last = {
      startedAt,
      finishedAt: new Date().toISOString(),
      salesforce,
      mail,
      // What the operator has to act on before anything can be sent.
      needsAttention: [
        ...salesforce.filter((s) => s.state === 'expired').map((s) => `Salesforce ${s.env}`),
        ...(mail.state === 'expired' ? ['Outlook'] : []),
      ],
    };
    return last;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
