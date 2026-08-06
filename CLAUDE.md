# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, single-user app that replaces the manual CSV-and-email steps of the Netradyne device
fulfilment flow: pick product families/SKUs/quantities, generate byte-exact CSVs, email each one
to the right distribution list, watch Salesforce Assets converge, hand back the ids that loaded.

Salesforce is **read-only** here (`server/services/sf-client.js` has no writes). The only way
anything changes in the org is an email with a CSV attached — which is why the destination mailbox
and the CSV bytes are the two things the code guards hardest.

## Commands

```bash
npm install                  # deps + the Chromium that drives the Salesforce/Outlook logins
npm run dev                  # server :4317 (node --watch) + Vite UI :5317 (proxies /api), opens browser
npm run dev:server           # server only
npm test                     # 81 tests, ~130ms
npm run build && npm start   # single-process production mode on :4317 (Express serves dist/)
```

Single test file / single test:

```bash
node --test server/services/templates.test.js
node --test --test-name-pattern "byte contract" server/services/templates.test.js
```

`templates.test.js` regenerates each real DL sheet from its descriptor and asserts byte equality.
It needs the source sheets at `~/BSG/DL Template` (override with `DL_TEMPLATE_DIR`); the whole
suite **self-skips** if the folder is missing, so a green run on a machine without it proves much
less. Check for `skipped` in the summary before trusting a pass.

## Architecture

Two processes in dev, one in prod. `server/` is ESM Node + Express; `web/` is React 18 + Vite with
no router and no state library — `web/src/App.jsx` holds all shared state and switches on a `page`
string, passing one `shared` prop bag to each page. `web/src/api.js` is the only place that talks
HTTP.

### The look, and the two rules it enforces

Pale blue `#EFFAFD` field, white surfaces, deep navy ink, royal blue `#4A8BDF`, eggplant `#A0006D`.
Three roles kept deliberately apart: **navy** is structure and the primary action (headings, filled
buttons), **royal blue** is interaction (links, focus, selection, the operator's own path on the
life cycle map), **eggplant** is the highlight, used sparingly — where you are *right now*: the
active step marker, the current stage ring, the run's state cell, the rule under a page title.

Royal blue appears literally at `#4A8BDF` wherever it is a fill, a stroke or a large shape.
`--accent` is the same hue deepened to clear 4.5:1 for small text and thin borders; `#4A8BDF` as
body text is 3.0:1 and would fail.

Every colour and face comes from tokens at the top of `web/src/styles.css`, under two themes set on
`<html data-theme>`: `light` (default) and `dark`, picked in the rail and remembered in
`localStorage`. Light is the default deliberately, so the palette never depends on an OS setting.
Plus Jakarta Sans carries display and UI — set very bold and tight for headings; **IBM Plex Mono is
reserved for data that has to align**: ids, filenames, byte counts, hex, sync statuses. Both load
from Google Fonts in `web/index.html` and fall back to system faces offline. Pages hard-code no
colour — `var(--ok|--warn|--fail|--accent)` are the only vars referenced inline.

The life cycle map borrows the palette's own logic: Install Check stages are royal blue, Customer
stages eggplant, which is also what the two account types mean.

Shared document primitives are in `web/src/components/ui.jsx`: `PageHead` (step marker, title,
double rule), `Sheet` (panel with a ruled head, `live` adds the polling scanline), `Segmented`
(every "pick one of these"), `KeyValue`, plus `Badge` / `Callout` / `Stat` / `Field`. The persistent
`Runbar` in `App.jsx` shows the same seven fields on every page and starts them as `—`, so the strip
doubles as the progress record.

- **Eyebrow labels are uppercased; literal strings are not.** A filename, a column name like
  `device_id`, a config path, or a status like `INITIAL_DEVICE_LOAD_SYNC_FAILED` keeps its own
  case — use `.group-label`, `th.raw`, or `<Field raw>`, and never pass one to a `Sheet`'s
  `eyebrow`. Re-casing a value the Apex parser cares about misreports it, which is exactly the
  class of error this app exists to prevent.
- **The destination mailbox is the loudest thing on Review** (`.dest`). It is the only marker of
  which operation a file represents, so it outranks the filename and the byte counts. The
  send-without-review button is `danger outline`, not a solid block — a red slab beside the safe
  action pulls the eye toward the send you did not want.

### The run pipeline

A **run** is one trip through the flow, keyed by a user-supplied `trackingId` (not a Salesforce
OrderNumber). Every step writes the run to `data/runs/<runId>.json`, so a refresh, restart, or
mid-poll session expiry never loses ids that were already sent — those exist in the org whether or
not this app remembers them.

```
POST /api/runs                  create: normalise groups, resolve optional order
POST /api/runs/:id/allocate     mint id blocks per (env, template, series), collision-check
POST /api/runs/:id/generate     build CSV bytes per group, persist to data/output/<runId>/
GET  /api/runs/:id/validate     graded checks: blocker | warning
POST /api/runs/:id/send         one email per family, exactly one attachment
POST /api/runs/:id/poll/:stage/start   server-side Asset polling until every unit settles
GET  /api/runs/:id/lifecycle    where the devices are on the DLCM chart, and what moves them next
GET  /api/catalog/lifecycle     the stage graph itself, with every operation placed on it
```

A run holds **groups**; one group = one product family = one template = one CSV = one email. Two
families never share a message even when they route to the same mailbox. Artifacts and sends are
keyed `"<operation>:<family>"` because one family can hold files for several operations at once.

Ids are minted **once**, from the family's initial-load template, and reused by every later
operation on the same devices — a shipment update that invented fresh ids would update nothing.

### Everything format-specific lives in `templates/*.json`

13 descriptors, one per real accepted sheet. A descriptor owns the column list and order, each
column's value `source`, the byte contract (`bom`, `lineEnding`, `trailingNewline`), the filename
pattern, and the id series it mints. `csv-builder.js` has no knowledge of any particular format;
`validator.js` checks against the descriptor's own declared contract, not a global rule. Adding a
format is a JSON drop-in — see `templates/README.md` for the schema and the per-sheet quirks.

`status: "awaiting-template"` means the server refuses to generate or send it. Four operations
(`nonRepairable`, `faultyReturned`, `deviceDead`, `undoDead`) have a mailbox but no sheet yet.

### Routing lives in `config/environments.json`

Per-environment Salesforce endpoint plus `distributionLists.byOperation` / `.byFamilyOperation`.
Resolution prefers a `"<family>:<operation>"` override, else the operation-level address, and
returns *which rule matched* so the UI can show it. Any value starting with `REPLACE_ME` blocks
sending **for that pipeline only** — an unconfirmed address is safe to leave in the file. Add a
family-specific mailbox only when it differs from the shared one.

Note `initialLoad` and `updateLoad` share testing's mailbox by design (the DL is named "Initial
Load & Update Load"), and staging's `asset_markdead_` / `asset_markundodead_` differ by one word.
`server/lib/config.test.js` asserts these cannot be confused in either direction.

### The device life cycle lives in `config/lifecycle.json`

The DLCM stage graph: 14 stages and 26 transitions, keyed on `IDMS_Status__c` — a numeric code
`-2..14` on the Asset. The chart draws `-2..12`; 13 and 14 exist in the org and are deliberately
**not** modelled, so an unknown code is reported as unmapped rather than guessed at.

The split that matters is *who drives each arrow*. Seven transitions are an operation this app
sends; the other nineteen belong to the Installer App, the customer, the network activating a sim,
the order integration. The chain the operator actually walks is three of them, on the same devices
and the same ids:

```
(no Asset) --initialLoad--> -2 Pre-Production --shipmentUpdate--> -1 Shipped From Vendor
           --received--> 1 New --> everything after this belongs to somebody else
```

`server/lib/lifecycle.js` is the only reader. `STAGE_EXPECTATIONS` in `sf-client.js` is *derived*
from the file's `syncStatus` map, so making an operation pollable is one line here rather than two
places to keep in step. An operation absent from that map cannot be watched at all — the UI says so
instead of waiting 30 minutes for a status the integration never writes.

Two things this deliberately does not do:

- **Stage never blocks a send.** `validateDeviceStages` is a `warning`, always. The stage is
  written by another system and can move between the read and the send; refusing on it would
  invent a new way to be stuck. What it does catch is the shipment update aimed at devices already
  past Shipped From Vendor — accepted by the org, changes nothing.
- **A split run gets no suggestion.** "What's next" is only answered when every device shares a
  stage. Acting on the majority would leave the rest behind silently.

Six arrows were ambiguous on the source chart and carry an `uncertain` note explaining the reading
taken. They are listed in the UI on the Life cycle page; correcting one is a one-line edit here.

### Server layout

| File | Role |
|---|---|
| `server/lib/bytes.js` | BOM/CRLF primitives, `assertCsvBytes`, hex dump, Excel serial repair |
| `server/lib/config.js` | loads config + templates, DL resolution, `REPLACE_ME` detection |
| `server/lib/lifecycle.js` | DLCM stage graph, `classifyStage`, next-step and stage-check logic |
| `server/lib/paths.js` | all disk locations; `writeSecret` (0600) for anything sensitive |
| `services/sf-session.js` | Playwright login, sid capture, silent refresh from browser profile |
| `services/sf-client.js` | every SOQL read; `classifySyncStatus`; `summarisePolling` |
| `services/id-generator.js` | series allocation against persisted counters |
| `services/csv-builder.js` | descriptor-driven generation, three row planners |
| `services/validator.js` | pre-send checks, graded blocker/warning |
| `services/mailer.js` | transport dispatch (outlook-web \| smtp), `.eml` fallback |
| `services/outlook-web-service.js` | compose, attach, Send, Sent-Items confirmation |
| `services/poller.js` | server-side polling loop, writes snapshots into the run |
| `services/run-store.js` | run JSON + generated bytes on disk |

## Invariants — breaking any of these costs a real device load

- **Never derive a quantity from a SKU.** `sku-decoder.js` is positional decoding only. Batch size
  (units to load) and order quantity (serials a wizard upload needs) are two separate counts and
  stay separate; conflating them produces a `Partially Shipped` order that hides the "Load Asset &
  Ship Order" button and dead-ends the flow.
- **Ids come from persisted counters** (`data/counters.json`, keyed `env:templateId:series`), never
  a random reroll. On collision the cursor advances past the highest hit — forward progress only.
  Numeric series refuse to overflow their declared digit width.
- **Byte contracts are per template.** All 15 source sheets are CRLF; BOM and trailing newline vary
  *within* one logical format. Don't unify them.
- **`escapeField` refuses** commas/quotes/newlines rather than quoting — no column in any format
  legitimately contains them, so it's caller data corruption.
- **Mailbox matching is on the local part**, not the domain. Every testing address is
  `@netradyne.com` and staging's are all Apex email services on one host suffix.
- **A send is only recorded after the message is found in Sent Items.** Compose-and-stop
  (`awaitingYourSend`) is explicitly *not* a send — recording it would arm the duplicate-send guard
  against the real send that hasn't happened. `mail.autoSend` is `false` by default.
- **Re-sending the same file to the same mailbox is blocked** unless `force`, and re-sends read the
  stored bytes from disk; regenerating would allocate new ids.
- **`*_SYNC_FAILED` is terminal**, immediately. ~⅓ of initial loads fail in this org, so failure is
  an ordinary outcome, not something to wait out. `_SYNC_SUCCESS`/`_SYNC_FAILED` are written by the
  integration and are **not** picklist values — they cannot be driven off Asset metadata.
- **No order is ever found by `Status = 'Confirmed'`** — no Order in these sandboxes has ever had
  it. Status is displayed and used for the `Partially Shipped` warning, never as a search filter.
- **No `sim_serial == device_imei` check.** The process spec demands it; every real Driveri sheet
  uses three distinct series offset by 10, and the sheets are what the parser accepted.

Nothing in this app is wired to an LLM, deliberately. Keep models out of id generation, byte
formatting, quantity arithmetic and the send decision.

## Sessions and credentials

There are no credentials in `.env` or in config. Salesforce username/password are typed into the UI
per attempt and live in process memory only; Outlook credentials are never handled by this app at
all.

| | Persisted to | Renewal |
|---|---|---|
| Salesforce sid | `data/sessions/<env>.json` (0600) | any 401 → silent re-mint from the browser profile, retry once |
| Salesforce browser profile | `data/browser/<env>/` (0700) | survives weeks; carries "remember this device" |
| Outlook | `outlook-auth.json` in the repo root (0600) | Playwright storage state, reused headless |

Silent refresh is serialised per environment — Chromium locks a profile directory exclusively, and
parallel 401s would otherwise fight over it. Session records are *nulled, not deleted*, on expiry
so the UI can say "expired, try Renew" rather than "not connected". Only explicit user actions
(Disconnect, Forget this browser, Forget on the Mail card, deleting a run) remove anything.

SMTP is dead in this tenant (`535 5.7.139` = SMTP AUTH disabled), so `mail.transport` defaults to
`outlook-web`. The nodemailer path is kept for the day it's re-enabled; switching transports is a
one-line change in `config/environments.json`.

Errors carry `needsReconnect` when the name is `SalesforceSessionExpiredError` /
`SalesforceNotConnectedError`; the UI reacts structurally to that flag rather than to the message.

## Environment variables (all optional, all non-secret)

`PORT` (4317) · `DEFAULT_ENV` (testing) · `HEADLESS` (false — you watch the SF login and can
intervene) · `DL_TEMPLATE_DIR` · `OUTLOOK_AUTH_STATE_PATH` (borrow an existing session file) ·
`OUTLOOK_WEB_URL` / `OUTLOOK_SENT_ITEMS_URL` · `OUTLOOK_{AUTH_WAIT,HYDRATION,SEND_ENABLE,SEND_CONFIRM,SENT_VERIFY}_MS`.

Outlook redirects to `outlook.cloud.microsoft` in this tenant, so Sent Items is resolved from
whatever host the session lands on rather than a hardcoded URL. Failed sends write a screenshot and
Outlook's own banner text to `data/diagnostics/`.

## Further reading, in priority order

1. `README.md` — the operational story, including what is still missing (three mailboxes, four CSV
   formats) and the hard-won Outlook DOM details.
2. `templates/README.md` — descriptor schema, the 13 formats, source-sheet defects reproduced or
   deliberately not.
3. `device-load-and-shipment-process.md` — the original process spec. **Where it disagrees with the
   real sheets, the sheets win** — they are what the Apex parser has actually accepted. Both
   READMEs table the disagreements.
