import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, Field, KeyValue, PageHead, Segmented, Sheet, Spinner } from '../components/ui.jsx';

/**
 * Two connections, both credential-in-memory:
 *
 *  - Salesforce: a real browser logs in, you hand over the MFA code, and only the resulting
 *    session id is kept (on disk, 0600) until it expires.
 *  - SMTP: username and app password stay in the server process for this session only.
 */
export default function ConnectPage({ env, activeEnv, session, refreshSession, goto, onError }) {
  const nextStep = 'setup';
  return (
    <>
      <PageHead eyebrow="Step 01 · Sessions" title="Connect">
        <p>
          Nothing here is written to a <code>.env</code> file. Salesforce credentials are used
          once to drive a login and then discarded — only the session id is stored, and only
          until Salesforce expires it. Mail credentials live in memory for this session.
        </p>
      </PageHead>

      {activeEnv && !activeEnv.ready ? (
        <Callout tone="fail" title={`${activeEnv.label} cannot be used yet`}>
          Its Salesforce endpoint in <code>config/environments.json</code> is still a
          placeholder, so nothing here will connect:
          <ul>
            {activeEnv.salesforceUnconfigured.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </Callout>
      ) : activeEnv?.pendingPipelines?.length ? (
        <Callout tone="warn" title={`${activeEnv.pendingPipelines.length} pipeline(s) have no mailbox yet`}>
          Everything else works. These specific operations can generate and download files but
          cannot be sent until their address is filled in:{' '}
          {activeEnv.pendingPipelines.join(', ')}.
        </Callout>
      ) : null}

      <StartupCheck check={session?.startupCheck} />

      <div className="grid-2">
        <SalesforceCard env={env} activeEnv={activeEnv} session={session} refreshSession={refreshSession} onError={onError} />
        <SmtpCard env={env} session={session} refreshSession={refreshSession} onError={onError} />
      </div>

      {activeEnv?.mailboxes?.length ? (
        <Sheet className="section-gap" eyebrow="Routing" title="Where this environment sends">
          <p className="prose small">
            The destination mailbox is the only thing that distinguishes one operation from
            another — the CSV bytes carry no marker. Every send is matched on the mailbox's local
            part first, because matching the domain alone would accept the wrong mailbox: every
            address here is <code>@netradyne.com</code>.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Applies to</th>
                  <th>To</th>
                  <th>Subject</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activeEnv.mailboxes.map((m) => (
                  <tr key={`${m.operation}:${m.scope}`}>
                    <td>{m.operationLabel}</td>
                    <td className="small muted">
                      {m.scope}
                      {m.override ? <Badge tone="info">override</Badge> : null}
                    </td>
                    <td className="mono small">{m.to}</td>
                    <td className="small">{m.subject}</td>
                    <td>{m.ready ? <Badge tone="ok">ready</Badge> : <Badge tone="warn">placeholder</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="prose small" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
            A pipeline whose address is still a placeholder can generate and download files, but
            sending it is refused.
          </p>
        </Sheet>
      ) : null}

      {session?.salesforce?.connected ? (
        <div className="btn-row">
          <button className="btn" onClick={() => goto(nextStep)}>
            Continue to setup →
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * What the server found when it checked the stored sessions at boot.
 *
 * Only worth saying anything when something is wrong: a card already shows "connected", and
 * repeating "we checked and it is fine" on every page load is noise. The Salesforce half has
 * usually corrected itself by now — the audit retires a dead sid, so the card below is already
 * showing the truth — but Outlook cannot self-correct, and a storage state that stopped working
 * looks identical to one that still does until a send fails.
 */
function StartupCheck({ check }) {
  if (!check) return null;

  const sfExpired = check.salesforce?.state === 'expired';
  const mailExpired = check.mail?.state === 'expired';
  if (!sfExpired && !mailExpired) return null;

  return (
    <Callout tone="warn" title="Stored sessions were checked at startup">
      <ul style={{ margin: '0.2rem 0 0', paddingLeft: '1.1rem' }}>
        {sfExpired ? (
          <li className="small">
            <strong>Salesforce</strong> — the saved session no longer works
            {check.salesforce.autoRenews
              ? ' and could not be renewed from the remembered browser. Log in below.'
              : '. Log in below.'}
          </li>
        ) : null}
        {mailExpired ? (
          <li className="small">
            <strong>Outlook</strong> — the saved sign-in no longer loads the inbox. Sign in again
            on the Mail card, or a send will fail part-way through.
          </li>
        ) : null}
      </ul>
    </Callout>
  );
}

function SalesforceCard({ env, activeEnv, session, refreshSession, onError }) {
  const sf = session?.salesforce;
  // Password is the default. The org login page carries the username/password form alongside the
  // SSO button, and using it stays entirely within Salesforce — the SSO route detours through
  // Microsoft Entra, which is several more steps for the same result.
  const [method, setMethod] = React.useState('password');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [attempt, setAttempt] = React.useState(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [manualSid, setManualSid] = React.useState('');
  const [showManual, setShowManual] = React.useState(false);
  const [verifyResult, setVerifyResult] = React.useState(null);

  // Poll the login attempt so the MFA prompt appears as soon as Salesforce asks.
  React.useEffect(() => {
    if (!attempt?.attemptId) return undefined;
    // 'needs-your-click' keeps polling: the driver is still watching for the session while you
    // finish the step it could not.
    if (['connected', 'failed', 'cancelled'].includes(attempt.status)) return undefined;

    const timer = setInterval(async () => {
      try {
        const next = await api.loginStatus(attempt.attemptId);
        setAttempt(next);
        if (next.status === 'connected') {
          setPassword('');
          await refreshSession(env);
        }
      } catch (err) {
        setAttempt((a) => ({ ...a, status: 'failed', error: err.message }));
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [attempt?.attemptId, attempt?.status, env, refreshSession]);

  const startLogin = async () => {
    setBusy(true);
    try {
      // On the SSO path credentials are optional; sending blanks means "hand the window over".
      setAttempt(
        await api.login({
          env,
          method,
          username: username || undefined,
          password: password || undefined,
        })
      );
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    setBusy(true);
    try {
      setAttempt(await api.submitMfa(attempt.attemptId, code));
      setCode('');
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const inFlight = attempt && !['connected', 'failed', 'cancelled'].includes(attempt.status);

  return (
    <Sheet
      eyebrow="Read-only session"
      title="Salesforce"
      live={Boolean(inFlight)}
      actions={sf?.connected ? <Badge tone="ok">connected</Badge> : <Badge tone="muted">not connected</Badge>}
    >
      {sf?.connected ? (
        <>
          <KeyValue
            rows={[
              ['User', <span className="mono">{sf.username ?? '—'}</span>],
              ['Instance', <span className="mono break">{sf.instanceUrl}</span>],
              ['API', <span className="mono">{sf.apiVersion}</span>],
              [
                'When it expires',
                sf.autoRenews ? (
                  <>
                    <Badge tone="ok">renews itself</Badge> <span className="muted small">no login prompt</span>
                  </>
                ) : (
                  <Badge tone="warn">will ask you to log in</Badge>
                ),
              ],
              [
                'Session age',
                <>
                  {sf.ageMinutes} min
                  {sf.refreshCount ? <span className="muted small"> · renewed {sf.refreshCount}×</span> : null}
                </>,
              ],
            ]}
          />
          <div className="btn-row" style={{ marginTop: '0.85rem' }}>
            <button
              className="btn secondary small"
              onClick={async () => {
                try {
                  setVerifyResult(await api.verifySession(env));
                } catch (err) {
                  setVerifyResult(null);
                  onError(err);
                }
              }}
            >
              Test session
            </button>
            <button
              className="btn secondary small"
              onClick={async () => {
                await api.logout(env);
                setVerifyResult(null);
                await refreshSession(env);
              }}
            >
              Disconnect
            </button>
            {sf.rememberedBrowser ? (
              <button
                className="btn secondary small"
                disabled={busy}
                title="Re-mint the session id now from the remembered browser, without prompting"
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.refreshSession(env);
                    if (!r.refreshed) onError(new Error(r.reason ?? 'Could not renew the session.'));
                    await refreshSession(env);
                  } catch (err) {
                    onError(err);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Renew now
              </button>
            ) : null}
            {sf.rememberedBrowser ? (
              <button
                className="btn secondary small"
                title="Drop the remembered browser profile so the next login re-challenges for MFA"
                onClick={async () => {
                  await api.forgetBrowser(env);
                  await refreshSession(env);
                }}
              >
                Forget this browser
              </button>
            ) : null}
            {verifyResult?.ok ? <Badge tone="ok">session is live</Badge> : null}
          </div>
        </>
      ) : (
        <>
          {sf?.previousUsername ? (
            <Callout tone="warn" title={`Session for ${sf.previousUsername} expired`}>
              <div className="small">
                {sf.expiredReason ?? 'It expired.'}
                {sf.refreshCount ? ` It had renewed itself ${sf.refreshCount}× before this.` : ''}
              </div>
              {sf.autoRenews ? (
                <div className="small muted" style={{ marginTop: '0.35rem' }}>
                  The remembered browser is still here, so try Renew first — it usually avoids a
                  fresh login.
                </div>
              ) : null}
              {sf.autoRenews ? (
                <div className="btn-row" style={{ marginTop: '0.5rem' }}>
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await api.refreshSession(env);
                        if (!r.refreshed) onError(new Error(r.reason ?? 'Could not renew.'));
                        await refreshSession(env);
                      } catch (err) {
                        onError(err);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? 'Renewing…' : 'Renew without logging in'}
                  </button>
                </div>
              ) : null}
            </Callout>
          ) : null}

          <p className="prose small">
            Chromium signs in for you against{' '}
            <span className="mono break">{activeEnv?.loginUrl}</span> — this org's own login page,
            not the generic sandbox one, which is the only page that offers the SSO button. It runs
            out of sight; if a verification code is needed you are asked for it here, and a window
            only opens if it meets a step it cannot drive.
            {sf?.rememberedBrowser
              ? ' This browser is already remembered, so MFA may be skipped.'
              : ' After this, the session renews itself and you should not be asked again.'}
          </p>

          <div style={{ margin: '0.9rem 0' }}>
            <Segmented
              label="Login method"
              value={method}
              onChange={setMethod}
              options={[
                { value: 'password', label: 'Username & password', disabled: Boolean(inFlight) },
                {
                  value: 'sso',
                  label: activeEnv?.ssoLabel ?? 'SSO',
                  disabled: Boolean(inFlight),
                  title: 'Detours through Microsoft Entra — more steps, same result',
                },
              ]}
            />
          </div>

          {method === 'sso' ? (
            <>
              <p className="prose small">
                The longer route: it clicks the SSO button and follows the redirect out to Microsoft
                Entra, which is several more steps than signing in to Salesforce directly. Kept for
                accounts that can only get in this way. Fill in your Netradyne account to have the
                Microsoft form driven in the background too — leave it blank and a window opens for
                you to sign in yourself, since there is nothing to hand over otherwise.
              </p>
              <div className="field-stack">
                <Field label="Netradyne account" hint="Optional — leave blank to sign in yourself">
                  <input
                    type="text"
                    autoComplete="off"
                    value={username}
                    disabled={inFlight}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="you@netradyne.com"
                  />
                </Field>
                <Field
                  label="Password"
                  hint="Optional. Held in memory for this login only, never written to disk. A wrong one is reported and not retried, so it cannot lock your account."
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={password}
                    disabled={inFlight}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </div>
            </>
          ) : (
            <>
              <p className="prose small">
                Driven end to end in the background and stays inside Salesforce — no Microsoft
                redirect, no window. It stops at one place only: when Salesforce asks to verify your
                identity, the code box below activates — read the code off your mail or phone and
                enter it here.
              </p>
              <div className="field-stack">
                <Field label="Salesforce username">
                  <input
                    type="text"
                    autoComplete="off"
                    value={username}
                    disabled={inFlight}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="you@netradyne.com.testing"
                  />
                </Field>
                <Field label="Password" hint="Held in memory for this login only. Never written to disk.">
                  <input
                    type="password"
                    autoComplete="off"
                    value={password}
                    disabled={inFlight}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}

          <div className="btn-row">
            <button
              className="btn"
              disabled={
                busy || inFlight || !activeEnv || (method === 'password' && (!username || !password))
              }
              onClick={startLogin}
            >
              {inFlight ? 'Logging in…' : method === 'sso' ? 'Log in with SSO' : 'Log in'}
            </button>
            {inFlight ? (
              <button
                className="btn secondary small"
                onClick={async () => {
                  await api.cancelLogin(attempt.attemptId);
                  setAttempt(null);
                }}
              >
                Cancel
              </button>
            ) : null}
            <button className="btn quiet small" onClick={() => setShowManual((v) => !v)}>
              Paste a sid instead
            </button>
          </div>

          {attempt ? (
            <div style={{ marginTop: '0.9rem' }}>
              {attempt.status === 'awaiting-mfa' ? (
                <Callout tone="warn" title="Verification code needed">
                  <p className="small" style={{ marginBottom: '0.5rem' }}>{attempt.mfaPrompt}</p>
                  <div className="btn-row">
                    <input
                      className="mono"
                      type="text"
                      inputMode="numeric"
                      value={code}
                      placeholder="123456"
                      style={{ width: '8rem' }}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && code.length >= 4) sendCode();
                      }}
                    />
                    <button className="btn small" disabled={busy || code.length < 4} onClick={sendCode}>
                      Submit code
                    </button>
                  </div>
                </Callout>
              ) : attempt.status === 'awaiting-mfa-approval' ? (
                <Callout tone="warn" title="Approve the sign-in on your phone">
                  <div className="small">{attempt.message}</div>
                  <div className="small muted" style={{ marginTop: '0.4rem' }}>
                    A push approval cannot be automated. Once you approve it, the rest continues on
                    its own.
                  </div>
                </Callout>
              ) : attempt.status === 'needs-your-click' || attempt.status === 'sso-handoff' ? (
                <Callout
                  tone="warn"
                  title={
                    attempt.status === 'sso-handoff'
                      ? 'Sign in with SSO in the browser window'
                      : attempt.canReveal
                        ? 'This step needs the browser window'
                        : 'Finish this step in the browser window'
                  }
                >
                  <div className="small">{attempt.message}</div>
                  {attempt.currentUrl ? (
                    <div className="mono small muted break" style={{ marginTop: '0.4rem' }}>
                      {attempt.currentUrl}
                    </div>
                  ) : null}
                  {attempt.canReveal ? (
                    <div className="btn-row" style={{ marginTop: '0.55rem' }}>
                      <button
                        className="btn small"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            setAttempt(await api.revealLogin(attempt.attemptId));
                          } catch (err) {
                            onError(err);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Open the browser window
                      </button>
                    </div>
                  ) : null}
                  <div className="small muted" style={{ marginTop: '0.4rem' }}>
                    Still watching — the session is captured as soon as you land.
                  </div>
                </Callout>
              ) : attempt.status === 'failed' ? (
                <Callout tone="fail" title="Login failed">
                  <div className="small">{attempt.error}</div>
                </Callout>
              ) : (
                <Spinner label={attempt.message ?? attempt.status} />
              )}
            </div>
          ) : null}

          {showManual ? (
            <div style={{ marginTop: '0.9rem' }}>
              <Field
                label="sid cookie"
                hint="From devtools › Application › Cookies on the *.my.salesforce.com host. A Lightning-domain sid will not work as a Bearer token."
              >
                <input
                  className="mono"
                  type="password"
                  value={manualSid}
                  onChange={(e) => setManualSid(e.target.value)}
                />
              </Field>
              <div className="btn-row" style={{ marginTop: '0.5rem' }}>
                <button
                  className="btn small"
                  disabled={!manualSid}
                  onClick={async () => {
                    try {
                      await api.manualSession({ env, sid: manualSid, username: username || null });
                      setManualSid('');
                      setShowManual(false);
                      await refreshSession(env);
                    } catch (err) {
                      onError(err);
                    }
                  }}
                >
                  Save session
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

function SmtpCard({ env, session, refreshSession, onError }) {
  const smtp = session?.smtp;
  const [user, setUser] = React.useState('');
  const [pass, setPass] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [ok, setOk] = React.useState(null);

  const save = async () => {
    setBusy(true);
    setOk(null);
    try {
      const result = await api.setSmtp({ env, user, pass, verify: true });
      setOk(result.ok);
      setPass('');
      await refreshSession(env);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  // Outlook on the web needs no credentials from this app: a saved session holds it.
  if (smtp?.transport === 'outlook-web') {
    const signedIn = smtp.outlook?.signedIn;
    return (
      <Sheet
        eyebrow="The only way the org changes"
        title="Mail"
        actions={signedIn ? <Badge tone="ok">Outlook signed in</Badge> : <Badge tone="warn">sign-in needed</Badge>}
      >
        <p className="prose small">
          SMTP is unusable in this tenant — it answers <code>535 5.7.139</code>, Microsoft's code for
          SMTP AUTH being switched off. No app password gets past that, so mail goes out through
          Outlook on the web.
        </p>
        <p className="prose small">
          Sign in once in a visible window; the session is saved to{' '}
          <code>data/outlook-auth.json</code> (mode 0600) and later sends run headless against it.
          Nothing is typed for you — the provider is Microsoft Entra and this app does not handle
          those credentials.
        </p>

        <KeyValue
          rows={[
            [
              'Saved session',
              signedIn ? (
                <>
                  <Badge tone="ok">present</Badge>{' '}
                  <span className="muted small">
                    {smtp.outlook.savedAt ? new Date(smtp.outlook.savedAt).toLocaleString() : ''}
                  </span>
                </>
              ) : (
                <Badge tone="muted">none</Badge>
              ),
            ],
            [
              'On send',
              smtp.autoSend ? (
                <Badge tone="warn">composes and sends</Badge>
              ) : (
                <Badge tone="ok">composes and stops for review</Badge>
              ),
            ],
            smtp.outlook?.composeOpen
              ? [
                  'Compose window',
                  <span className="small">
                    open — <span className="mono">{smtp.outlook.composeSubject}</span>
                  </span>,
                ]
              : null,
          ]}
        />

        <div className="btn-row" style={{ marginTop: '0.85rem' }}>
          <button
            className={`btn ${signedIn ? 'secondary' : ''}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setOk(null);
              try {
                await api.outlookSignIn(env);
                await refreshSession(env);
              } catch (err) {
                onError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Waiting for sign-in…' : signedIn ? 'Sign in again' : 'Sign in to Outlook'}
          </button>
          {signedIn ? (
            <>
              <button
                className="btn secondary small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.outlookVerify(env);
                    setOk(r.ok);
                    if (!r.ok) onError(new Error(r.reason ?? 'The saved session did not work.'));
                  } catch (err) {
                    onError(err);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Test session
              </button>
              <button
                className="btn secondary small"
                disabled={busy}
                onClick={async () => {
                  await api.outlookForget(env);
                  setOk(null);
                  await refreshSession(env);
                }}
              >
                Forget
              </button>
              {ok ? <Badge tone="ok">session is live</Badge> : null}
            </>
          ) : null}
        </div>

        <p className="prose small" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
          A closed compose window looks the same whether the mail was sent or discarded, so a send is
          only recorded once the message is found in Sent Items. Transport and auto-send live in{' '}
          <code>config/environments.json</code> under <code>mail</code>.
        </p>
      </Sheet>
    );
  }

  return (
    <Sheet
      eyebrow="The only way the org changes"
      title="Mail"
      actions={smtp?.configured ? <Badge tone="ok">configured</Badge> : <Badge tone="muted">not configured</Badge>}
    >
      <p className="prose small">
        Sent over SMTP via <code>{smtp?.host}:{smtp?.port}</code>. After each send the app looks
        for the message in Sent Items — a transport that accepted a message is not proof it
        left the building.
      </p>

      {smtp?.configured ? (
        <>
          <KeyValue
            rows={[
              ['From', <span className="mono">{smtp.from}</span>],
              ['Sent Items check', smtp.sentItemsCheckEnabled ? 'enabled' : 'disabled in config'],
            ]}
          />
          <div className="btn-row" style={{ marginTop: '0.85rem' }}>
            <button
              className="btn secondary small"
              onClick={async () => {
                await api.clearSmtp(env);
                await refreshSession(env);
              }}
            >
              Clear credentials
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="field-stack">
            <Field label="Mail username">
              <input type="text" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
            <Field
              label="App password"
              hint="An app password, not your account password, if your tenant requires one."
            >
              <input type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
            </Field>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy || !user || !pass} onClick={save}>
              {busy ? 'Verifying…' : 'Save & verify'}
            </button>
            {ok ? <Badge tone="ok">SMTP login works</Badge> : null}
          </div>
        </>
      )}
    </Sheet>
  );
}
