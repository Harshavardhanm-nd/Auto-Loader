import express from 'express';
import {
  startLogin,
  submitMfaCode,
  revealBrowser,
  describeAttempt,
  cancelLogin,
  describeSession,
  clearSession,
  clearBrowserProfile,
  saveSessionManually,
} from '../services/sf-session.js';
import { verifyConnection } from '../services/sf-client.js';
import { auditSessions, lastAudit } from '../services/session-audit.js';
import { refreshSessionSilently } from '../services/sf-session.js';
import {
  setSmtpCredentials,
  clearSmtpCredentials,
  describeSmtp,
  verifySmtp,
  signInToOutlook,
  verifyOutlook,
} from '../services/mailer.js';
import { clearStoredSession, closeOutlook } from '../services/outlook-web-service.js';
import { getEnvironment, loadEnvironments, loadOperations, unconfiguredValues } from '../lib/config.js';
import { operationOrder } from '../lib/lifecycle.js';

export const authRouter = express.Router();

/** One display row per mailbox this environment would send to. */
function mailboxRows(envName) {
  const env = getEnvironment(envName);
  const operations = loadOperations();
  const lists = env.distributionLists ?? {};
  const rows = [];

  // Same order as Review's operation selector and Watch's stage tabs — this table is read as the
  // sequence a device goes through, so a stage step belongs before the operation it precedes.
  for (const operation of operationOrder(Object.keys(operations))) {
    const meta = operations[operation];
    if (meta.needsMail === false) continue;
    const shared = lists.byOperation?.[operation];
    if (shared) {
      rows.push({
        scope: 'all families',
        operation,
        operationLabel: meta.label,
        to: shared.to,
        subject: shared.subject,
        ready: unconfiguredValues(shared).length === 0,
      });
    }
  }

  for (const [key, dl] of Object.entries(lists.byFamilyOperation ?? {})) {
    if (key.startsWith('$')) continue;
    const [family, operation] = key.split(':');
    rows.push({
      scope: family,
      operation,
      operationLabel: operations[operation]?.label ?? operation,
      to: dl.to,
      subject: dl.subject,
      ready: unconfiguredValues(dl).length === 0,
      override: true,
    });
  }

  return rows;
}

/** Environment list for the switcher, with placeholder status so staging is obvious. */
authRouter.get('/environments', (req, res) => {
  const { environments } = loadEnvironments();
  res.json({
    default: process.env.DEFAULT_ENV || 'testing',
    environments: Object.keys(environments).map((name) => {
      const env = getEnvironment(name);
      const mailboxes = mailboxRows(name);
      const sfPlaceholders = unconfiguredValues(env.salesforce, 'salesforce');
      const pendingPipelines = mailboxes.filter((m) => !m.ready);

      return {
        name,
        label: env.label,
        verified: env.verified,
        sandboxName: env.salesforce.sandboxName,
        instanceUrl: env.salesforce.instanceUrl,
        loginUrl: env.salesforce.loginUrl,
        ssoLabel: env.salesforce.ssoLabel ?? null,
        apiVersion: env.salesforce.apiVersion,
        // Flattened for display: one row per operation that sends mail, plus any
        // family-specific override, so the Connect screen can show exactly where this
        // environment would send.
        mailboxes,
        unconfigured: env.unconfigured,
        // `ready` is about whether this environment is usable at all, which means its
        // Salesforce endpoint. A pipeline whose mailbox is still a placeholder blocks only
        // that pipeline — reporting the whole environment as broken for it would be wrong,
        // since testing is fully configured for initial load and shipment update.
        ready: sfPlaceholders.length === 0,
        salesforceUnconfigured: sfPlaceholders,
        pendingPipelines: pendingPipelines.map((m) => `${m.operationLabel} (${m.scope})`),
      };
    }),
  });
});

authRouter.get('/session', (req, res) => {
  const env = req.query.env || 'testing';
  const audit = lastAudit();
  res.json({
    salesforce: describeSession(env),
    smtp: describeSmtp(env),
    // What the boot-time check found. Salesforce state is already reflected in describeSession
    // (an expired sid was retired by the audit itself); this is here for the mail verdict, which
    // nothing else can determine without launching a browser.
    startupCheck: audit
      ? {
          finishedAt: audit.finishedAt,
          salesforce: audit.salesforce.find((s) => s.env === env) ?? null,
          mail: audit.mail,
          needsAttention: audit.needsAttention,
        }
      : null,
  });
});

/** Re-run the boot-time session check on demand. */
authRouter.post('/session/audit', async (req, res, next) => {
  try {
    res.json(await auditSessions({ outlook: req.body?.outlook !== false }));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/session/verify', async (req, res, next) => {
  try {
    const env = req.body?.env || 'testing';
    const result = await verifyConnection(env);
    res.json({ ...result, session: describeSession(env) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res) => {
  const env = req.body?.env || 'testing';
  clearSession(env);
  clearSmtpCredentials(env);
  // The remembered browser profile is kept unless asked for explicitly — dropping it means the
  // next login gets a fresh MFA challenge.
  if (req.body?.forgetBrowser) clearBrowserProfile(env);
  res.json({ ok: true, session: describeSession(env) });
});

/** Re-mint the sid from the remembered profile without any prompting. */
authRouter.post('/session/refresh', async (req, res, next) => {
  try {
    const env = req.body?.env || 'testing';
    const result = await refreshSessionSilently(env);
    res.json({ ...result, session: describeSession(env) });
  } catch (err) {
    next(err);
  }
});

/** Forget "remember this device", so the next login re-challenges for MFA. */
authRouter.post('/forget-browser', (req, res) => {
  const env = req.body?.env || 'testing';
  clearBrowserProfile(env);
  res.json({ ...describeSession(env) });
});

// --- Salesforce browser login with MFA relay ------------------------------

authRouter.post('/login', async (req, res, next) => {
  try {
    const { env = 'testing', method = 'password', username, password, headless } = req.body ?? {};
    const attempt = await startLogin({ env, method, username, password, headless });
    res.json(attempt);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/login/:attemptId', (req, res, next) => {
  try {
    res.json(describeAttempt(req.params.attemptId));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login/:attemptId/mfa', async (req, res, next) => {
  try {
    const result = await submitMfaCode(req.params.attemptId, req.body?.code);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Promote a background login to a visible window when it hits a step it cannot drive. */
authRouter.post('/login/:attemptId/reveal', (req, res, next) => {
  try {
    res.json(revealBrowser(req.params.attemptId));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login/:attemptId/cancel', async (req, res, next) => {
  try {
    res.json(await cancelLogin(req.params.attemptId));
  } catch (err) {
    next(err);
  }
});

/** Escape hatch for SSO variants the browser automation cannot drive. */
authRouter.post('/session/manual', (req, res, next) => {
  try {
    const { env = 'testing', sid, username } = req.body ?? {};
    res.json(saveSessionManually({ env, sid, username }));
  } catch (err) {
    next(err);
  }
});

// --- SMTP ----------------------------------------------------------------

authRouter.post('/smtp', async (req, res, next) => {
  try {
    const { env = 'testing', user, pass, from, verify = true } = req.body ?? {};
    setSmtpCredentials(env, { user, pass, from });
    const result = verify ? await verifySmtp(env) : { ok: null, skipped: true };
    res.json({ ...result, smtp: describeSmtp(env) });
  } catch (err) {
    next(err);
  }
});

// --- Outlook on the web ---------------------------------------------------

/**
 * One-time interactive sign-in. Opens a visible Outlook window; you sign in with your Netradyne
 * account and the resulting session is saved so later sends run headless. Nothing is typed for
 * you — the provider is Microsoft Entra and this app does not handle those credentials.
 */
authRouter.post('/outlook/signin', async (req, res, next) => {
  try {
    const env = req.body?.env || 'testing';
    const result = await signInToOutlook();
    res.json({ ...result, smtp: describeSmtp(env) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/outlook/verify', async (req, res, next) => {
  try {
    res.json(await verifyOutlook());
  } catch (err) {
    next(err);
  }
});

authRouter.post('/outlook/forget', async (req, res, next) => {
  try {
    const env = req.body?.env || 'testing';
    await closeOutlook();
    clearStoredSession();
    res.json({ ...describeSmtp(env) });
  } catch (err) {
    next(err);
  }
});

authRouter.delete('/smtp', (req, res) => {
  const env = req.query.env || 'testing';
  clearSmtpCredentials(env);
  res.json({ ok: true, smtp: describeSmtp(env) });
});
