import express from 'express';
import {
  startLogin,
  submitMfaCode,
  describeAttempt,
  cancelLogin,
  describeSession,
  clearSession,
  saveSessionManually,
} from '../services/sf-session.js';
import { verifyConnection } from '../services/sf-client.js';
import {
  setSmtpCredentials,
  clearSmtpCredentials,
  describeSmtp,
  verifySmtp,
} from '../services/mailer.js';
import { getEnvironment, loadEnvironments, loadOperations, unconfiguredValues } from '../lib/config.js';

export const authRouter = express.Router();

/** One display row per mailbox this environment would send to. */
function mailboxRows(envName) {
  const env = getEnvironment(envName);
  const operations = loadOperations();
  const lists = env.distributionLists ?? {};
  const rows = [];

  for (const [operation, meta] of Object.entries(operations)) {
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
  res.json({
    salesforce: describeSession(env),
    smtp: describeSmtp(env),
  });
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
  res.json({ ok: true, session: describeSession(env) });
});

// --- Salesforce browser login with MFA relay ------------------------------

authRouter.post('/login', async (req, res, next) => {
  try {
    const { env = 'testing', username, password, headless } = req.body ?? {};
    const attempt = await startLogin({ env, username, password, headless });
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

authRouter.delete('/smtp', (req, res) => {
  const env = req.query.env || 'testing';
  clearSmtpCredentials(env);
  res.json({ ok: true, smtp: describeSmtp(env) });
});
