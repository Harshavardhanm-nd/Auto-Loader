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
npm test                     # 132 tests in 3 files — see "Test state" below, 22 currently fail
npm run build && npm start   # single-process production mode on :4317 (Express serves dist/)
```

Single test file / single test:

```bash
node --test server/lib/config.test.js          # 18 pass — DL routing, mailbox confusability
node --test server/lib/lifecycle.test.js       # 43 pass — stage graph, classify, next-step
node --test server/services/templates.test.js  # 71 tests, 49 pass / 22 fail
node --test --test-name-pattern "byte contract" server/services/templates.test.js
```

Node's runner prints its tallies with an `ℹ` prefix (`ℹ tests 69`), not TAP `#`, so grep for `ℹ`.

### Test state — 22 failures are pre-existing, not yours

`templates.test.js` regenerates each real DL sheet from its descriptor and asserts byte equality.
It needs the source sheets at `~/BSG/DL Template` (override with `DL_TEMPLATE_DIR`). Two separate
things are broken as of `33792d3`; check whether a failure you see is one of them before debugging:

- **6 failures — three source sheets are absent.** `dhub-shipment-update`, `dms-shipment-update`
  and `vbus-shipment-update` were added with `sourceTemplate` names (`DHUB_Shipment_Load_02.csv`,
  `DMS_Shipment_Update_01.csv`, `VBUS_Initial_Load RTS120013 (4) 1 (1).csv`) that are not in the
  folder, so their header + bytes tests hard-fail with ENOENT. The skip guard is **folder-level
  only** — a missing individual sheet is not skipped.
- **16 failures — the test harness never caught up with `line.sku`.** `rowsFromSamples` (line 39)
  builds rows as `{ generated, line: {} }`, but 14 descriptors now read `sku_number` from
  `line.sku`. Every round-trip and builder test using that helper throws
  `Template column "sku_number": line.sku is not available`. Production is unaffected —
  `planGeneratedRows`/`planWizardRows` attach the real line.

Between them, **12 of the 16 descriptors currently have no byte-level verification** — 9 whose
round-trip throws, 3 whose source sheet is missing. Only `haptic-data-update`, `order-load`,
`partner-order-load` and `received-load` are still genuinely checked. Fixing `rowsFromSamples` to
carry a `line.sku` (and locating the three sheets) restores the guard; until then, treat any change
to `csv-builder.js` or a descriptor as unverified. Also check for `skipped` in the summary: on a
machine without the folder the whole suite self-skips and reports green.

Note node counts `describe` blocks alongside tests in its `✖` list, so the failing-name list looks
longer than 22.

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

**Operation and Units follow the page, not the run.** Review and Watch each own an operation
selector and report it up through `setActiveOperation`; `goto` clears it, so a page without one
falls back to the run's own operation. Units counts the devices in that operation's *generated
file* when one exists — a shipment update raised for a subset reads as that subset — and the run's
planned total before anything is generated. The tooltip always says which of the two you are
reading, because the numbers legitimately differ.

- **Eyebrow labels are uppercased; literal strings are not.** A filename, a column name like
  `device_id`, a config path, or a status like `INITIAL_DEVICE_LOAD_SYNC_FAILED` keeps its own
  case — use `.group-label`, `th.raw`, or `<Field raw>`, and never pass one to a `Sheet`'s
  `eyebrow`. Re-casing a value the Apex parser cares about misreports it, which is exactly the
  class of error this app exists to prevent.
- **The destination mailbox is the loudest thing on Review** (`.dest`). It is the only marker of
  which operation a file represents, so it outranks the filename and the byte counts. The
  send-without-review button is `danger outline`, not a solid block — a red slab beside the safe
  action pulls the eye toward the send you did not want.
- **The send button carries the whole lifecycle**, in place: `Compose in Outlook` → `Working…` →
  `Awaiting your Send…` → `✓ Sent`. It stays busy through the Sent Items confirmation, not just
  the compose, because a compose-and-stop is still in flight until then and a live button invites
  a second click that composes the same file again. `Awaiting your Send…` matters most: without it
  the card reverts to its idle label the moment the compose window opens, reading as "nothing
  happened" while a real message sits open in Outlook. Re-send carries the same states — a
  re-compose over an already-sent file is the same flow.
- **A composed-but-unsent message lives on the run**, as `run.pendingCompose`, not in page state.
  It is a real email sitting open in Outlook; holding that fact in a component means a refresh or
  a trip to another page silently loses it. The panel offering "check Sent Items" and "discard" is
  rendered from the run, so it survives navigation and a server restart. It is cleared by a
  recorded send, a confirmation, or discarding the window — and **never** written into `run.sends`,
  since a compose-and-stop is not a send and recording it would arm the duplicate guard against
  the real send that has not happened yet.

### The run pipeline

A **run** is one trip through the flow, keyed by a user-supplied `trackingId` (not a Salesforce
OrderNumber). Every step writes the run to `data/runs/<runId>.json`, so a refresh, restart, or
mid-poll session expiry never loses ids that were already sent — those exist in the org whether or
not this app remembers them.

```
POST /api/runs                  create: normalise groups, resolve optional order
POST /api/runs/:id/allocate     mint id blocks per (env, template, series), collision-check
POST /api/runs/:id/check-ids    collision-check without minting
POST /api/runs/:id/generate     build CSV bytes per group, persist to data/output/<runId>/
GET  /api/runs/:id/validate     graded checks: blocker | warning
POST /api/runs/:id/send         one email per family, exactly one attachment
POST /api/runs/:id/send/confirm record a compose-and-stop send after the operator sent it
POST /api/runs/:id/poll/:stage/start   server-side Asset polling until every unit settles
GET  /api/runs/:id/lifecycle    where the devices are on the DLCM chart, and what moves them next
GET  /api/runs/:id/operations   which operations are available on this run, and why not
GET  /api/catalog/lifecycle     the stage graph itself, with every operation placed on it
GET  /api/catalog/templates     descriptors as the UI sees them, incl. mailbox-only operations
```

`GET /api/runs?env=` scopes the History page to one environment, filtered **before** the limit so
a 50-run page is 50 runs of that org. Testing and staging ids are indistinguishable by eye — a
10-digit hub id looks the same from either — so the two histories are never interleaved.

Cursors are inspectable and editable per run: `GET /:id/cursors`, `POST /:id/cursors/set`
(`{templateId, seriesName, value}` — numeric series only, refuses to exceed the declared digit
width) and `POST /:id/cursors/reset`. The Ids page exposes `set` as a "Set to…" box per series;
it is the escape hatch for when the org and `data/counters.json` have drifted apart.

A run holds **groups**; one group = one product family = one template = one CSV = one email. Two
families never share a message even when they route to the same mailbox. Artifacts and sends are
keyed `"<operation>:<family>"` because one family can hold files for several operations at once.

Ids are minted **once**, from the family's initial-load template, and reused by every later
operation on the same devices — a shipment update that invented fresh ids would update nothing.

### Chaining: one run walks three operations, over a shrinking subset of its own devices

`POST /:id/generate` accepts an optional `deviceIds` array, and every row planner honours it —
generated rows are filtered on their primary series, existing-device rows on the id itself. The
Watch page is what produces those subsets: it polls a stage, then offers the *next* operation over
exactly the rows that settled.

```
initialLoad polled   → rows at IDMS -2 + INITIAL_DEVICE_LOAD_SYNC_SUCCESS → offer shipmentUpdate
shipmentUpdate polled → rows at IDMS -1 + shipment sync success           → offer received at 3PL
```

This is why a partially-failed load is not a dead end: the ~⅓ that fail stay behind while the rest
move on, on the same ids. Generating for a subset must never re-allocate — it filters rows that
were already minted, which is exactly the property the `deviceIds` filter is protecting.

### Everything format-specific lives in `templates/*.json`

16 descriptors, one per real accepted sheet. A descriptor owns the column list and order, each
column's value `source`, the byte contract (`bom`, `lineEnding`, `trailingNewline`), the filename
pattern, and the id series it mints. `csv-builder.js` has no knowledge of any particular format;
`validator.js` checks against the descriptor's own declared contract, not a global rule. Adding a
format is a JSON drop-in — see `templates/README.md` for the schema and the per-sheet quirks.
(That README still says "The 13 templates" and "All 15 source sheets"; the three shipment-update
sheets added in `33792d3` are not in its table.)

Column `source` values are `field.<name>` (shared across the run), `line.<name>` (per SKU line),
`existing.<name>`, `generated.<series>`, `const`, and date helpers. **`sku_number` reads
`line.sku`, not `field.sku_number`** — changed in `33792d3` so one run can carry several SKUs.
14 of the 16 descriptors do this. Any planner that produces rows must therefore attach the line:
`planGeneratedRows`/`planWizardRows` do, `planExistingRows(deviceIds)` defaults `line` to `{}`,
which is only safe because the two templates it serves (`received-load`, `partner-order-load`)
don't reference `line.sku`.

Filenames were standardised in `33792d3` to `<Operation>_<Family>_{trackingId}.csv`
(`Initial_Load_Driveri_B3E110005.csv`). `{family}` is a placeholder `buildCsv` fills from its
`family` argument, used by `received-load`, whose pattern is `Received_At_3PL_{family}_{trackingId}.csv`;
for a shared operation across a mixed run the route passes the **first group's** family, uppercased.

`status: "awaiting-template"` means the server refuses to generate or send it. No descriptor
currently carries it — all 16 are `verified` — but the mechanism is live in `isTemplateUsable`.
Four operations (`nonRepairable`, `faultyReturned`, `deviceDead`, `undoDead`) still have a mailbox
in both environments and no sheet at all, so they surface as mailbox-only.

### Routing lives in `config/environments.json`

Per-environment Salesforce endpoint plus `distributionLists.byOperation` / `.byFamilyOperation`.
Resolution prefers a `"<family>:<operation>"` override, else the operation-level address, and
returns *which rule matched* so the UI can show it. Any value starting with `REPLACE_ME` blocks
sending **for that pipeline only** — an unconfirmed address is safe to leave in the file. Add a
family-specific mailbox only when it differs from the shared one.

Note `initialLoad` and `updateLoad` share testing's mailbox by design (the DL is named "Initial
Load & Update Load"), and staging's `asset_markdead_` / `asset_markundodead_` differ by one word.
`server/lib/config.test.js` asserts these cannot be confused in either direction.

### The constant columns live in `config/profiles.json`

Three things the UI would otherwise have to ask for on every run:

- **`profiles`** — named presets for the 12 constant Format A columns (`product_type`,
  `system_pn`, `manufacturing_partner`, `po_number`, …). One preset today, `us-namz-akela`,
  which is `default`. These sit behind an "advanced" disclosure because they don't vary per run
  in the testing sandbox.
- **`picklists`** — Active values read off the Asset describe. The app re-reads them live when
  connected to Salesforce and falls back to this file offline, so an edit here only affects the
  disconnected case.
- **`orderStatus`** — the four status buckets, and the reason `Confirmed` is never a filter:
  `completeStatuses` (`Activated`), `acceptOnReadOnly`, `neverWrite`, and `blockedStatuses`
  (`Partially Shipped`, which drives the warning on Review).

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

A stage tab shows **only the devices currently at that stage**. `splitByStagePosition` peels off
the rows marked `aheadOfStage`, and the Watch page hides them behind a notice naming where each
one went. `rescoreSnapshot` re-derives that mark on every read rather than trusting what was
stamped at poll time — a snapshot is written once and read many times, so anything decided when it
was taken is frozen at whatever the code understood that day, and a snapshot predating the field
would quietly opt out of the split forever. `syncStatus` is the fact; everything else is
interpretation, and interpretation belongs at read time. Both sides are tallied by the same `tallyRows`, so the headline counts always describe
the rows underneath them. A tab can legitimately read zero — every device it covered has moved on
— and the notice says so rather than leaving a bare empty table. "Show everything that was sent"
restores the full set: that is the record of what the email carried, and it must stay reachable.

`operationChain()` walks the graph from its entry to get `[initialLoad, shipmentUpdate, received]`
— derived, not listed, so a corrected transition moves it. Polling needs this because **on the
Asset a device ahead of the watched stage and one behind it look identical**: each carries some
`_SYNC_SUCCESS`. Counting any terminal status as done reported devices as loaded that had never
had the operation applied. `positionInChain` resolves the device's own status back to its operation
and compares positions; only `ahead` or `at` counts as done. `unknown` (off-chain `dataUpdate`, or
a status this app does not model) is treated as not-ahead — it can under-report a success, never
invent one. Rows from snapshots predating the distinction carry no `aheadOfStage` and keep the old
reading rather than being re-judged wrongly.

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
| `server/routes/runs.js` | ~1100 lines, the whole pipeline; most behaviour changes land here |
| `server/routes/auth.js` | SF login/MFA/manual-sid, Outlook sign-in, forget-browser |
| `server/routes/catalog.js` | families, templates, picklists, profiles, lifecycle, order lookup |
| `server/lib/bytes.js` | BOM/CRLF primitives, `assertCsvBytes`, hex dump, Excel serial repair |
| `server/lib/config.js` | loads config + templates, DL resolution, `REPLACE_ME` detection |
| `server/lib/lifecycle.js` | DLCM stage graph, `classifyStage`, next-step and stage-check logic |
| `server/lib/paths.js` | all disk locations; `writeSecret` (0600) for anything sensitive |
| `services/sf-session.js` | Playwright login, sid capture, silent refresh from browser profile |
| `services/session-audit.js` | boot-time liveness check of every stored Salesforce + Outlook session |
| `services/sf-client.js` | every SOQL read; `classifySyncStatus`; `summarisePolling` |
| `services/id-generator.js` | series allocation against persisted counters, `setCursor`/`resetCursor` |
| `services/sku-decoder.js` | positional SKU decoding — no quantity ever comes out of this |
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
  a random reroll. On collision the cursor advances past the hit — forward progress only. Numeric
  series refuse to overflow their declared digit width. `POST /:id/cursors/set` is the one
  sanctioned way to move a cursor by hand, and it enforces the same digit ceiling.
- **Every `sampleStart` is an id that is already loaded.** It was copied from a sheet the parser
  accepted, so a fresh counter always opens on a collision — usually against the whole batch that
  sheet belonged to (the DHUB start `4011301001` sits under 37 consecutive live assets). The
  allocator therefore probes `count + 250` ids per attempt and takes the first free run inside that
  span; probing only `count` made it crawl forward `count` at a time and exhaust its 8 attempts
  still inside the batch. Any change here must keep the probe wider than the block it allocates.
- **A failed allocation still persists its cursor.** The ground it rejected is genuinely occupied,
  so the next attempt must resume past it. Discarding the cursor on failure — which is what
  `finish()`-only persistence did — made every retry re-walk the same collisions and fail
  identically, with `data/counters.json` never gaining an entry at all.
- **The collision query returns only values that were asked about.** It checks candidates against
  `Asset.Name`, `SIM_Serial__c` and `Device_IMEI__c`, but a matched Asset also carries its own
  values in the other two fields; returning those told the allocator to skip ids nobody had taken.
- **A candidate id is taken if it appears in *any* of three Asset fields** — `Name`,
  `SIM_Serial__c`, `Device_IMEI__c` (`findTakenDeviceIds`, widened in `33792d3`). Driveri mints
  three series offset by 10, so a device_id colliding with somebody else's sim_serial is a real
  collision; checking `Name` alone let it through.
- **Artifacts are written to `data/output/<runId>/` under their own filename**, no key prefix
  (changed in `33792d3`). The old `<key>__<filename>` namespacing existed because two operations
  could produce the same name; the `<Operation>_<Family>_{trackingId}` convention is now what keeps
  them apart. A new descriptor whose pattern collides with an existing one will silently overwrite.
- **Byte contracts are per template.** All 15 source sheets are CRLF; BOM and trailing newline vary
  *within* one logical format. Don't unify them.
- **`escapeField` refuses** commas/quotes/newlines rather than quoting — no column in any format
  legitimately contains them, so it's caller data corruption.
- **Mailbox matching is on the local part**, not the domain. Every testing address is
  `@netradyne.com` and staging's are all Apex email services on one host suffix.
- **A send is only recorded after the message is found in Sent Items.** Compose-and-stop
  (`awaitingYourSend`) is explicitly *not* a send — recording it would arm the duplicate-send guard
  against the real send that hasn't happened. `mail.autoSend` is `false` by default.
- **A device may not be loaded twice for the same operation** — that, not key reuse, is what the
  duplicate guard exists for. `duplicateSendReason` compares the file's `deviceIds` against every
  send for that `"<operation>:<family>"`, current and superseded. Half a batch pushed to shipment
  update and then the other half is two legitimate emails to one mailbox; keying the guard on the
  pair alone refused the second as a repeat. Regenerating a key for a different device set moves
  the old send record into `run.sendHistory[key]` — archived, never dropped, because those devices
  are in the org and the guard still needs their ids. When either side's list is unknown (records
  predating `deviceIds`) it falls back to refusing any second send for the key: a blocked
  legitimate send is recoverable, a silent double load is not. Re-sends read the stored bytes from
  disk; regenerating would allocate new ids.
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

The Salesforce login runs **headless by default**. The driver reports each step, parks at
`awaiting-mfa` when the org asks to verify identity — the code is typed into the Connect page, not
into a browser — and only shows a window when it has to. Two escapes keep that from dead-ending:
an SSO attempt with no credentials is forced headed (handing over an invisible window means
nothing), and any background attempt that stalls on an unrecognised screen offers
`POST /api/auth/login/:attemptId/reveal`, which relaunches the same attempt visibly. Playwright
cannot toggle a live context, so reveal closes and relaunches onto the page it had reached; the
persistent profile is what carries the progress across.

Silent refresh is serialised per environment — Chromium locks a profile directory exclusively, and
parallel 401s would otherwise fight over it. Session records are *nulled, not deleted*, on expiry
so the UI can say "expired, try Renew" rather than "not connected". Only explicit user actions
(Disconnect, Forget this browser, Forget on the Mail card, deleting a run) remove anything.

SMTP is dead in this tenant (`535 5.7.139` = SMTP AUTH disabled), so `mail.transport` defaults to
`outlook-web`. The nodemailer path is kept for the day it's re-enabled; switching transports is a
one-line change in `config/environments.json`.

Errors carry `needsReconnect` when the name is `SalesforceSessionExpiredError` /
`SalesforceNotConnectedError`; the UI reacts structurally to that flag rather than to the message.

### Sessions are audited at boot, because existing on disk is not the same as working

`describeSession` reports `connected: true` for any record holding a sid, and `describeOutlook`
reports `signedIn: true` for any `outlook-auth.json`. Neither is a liveness check, so a server
started the morning after opens on two green cards that may both be stale — and the thing that
discovers it is whatever real work the operator started.

`auditSessions()` runs once after `listen`, **not awaited**: the Outlook leg launches a browser and
can take half a minute, and nothing about serving the UI needs to wait for it. Salesforce needs no
special handling — `verifyConnection` goes through the ordinary request path, which already
re-mints from the browser profile on a 401, retries once, and retires the record if that fails, so
one call per environment leaves the stored state correct and the UI reads the truth on its next
poll. Outlook has no equivalent recovery, so its verdict is recorded for display rather than acted
on, and **the storage state is never deleted** — an expired one still records which account was
used, and discarding it takes the Forget decision away from the operator.

`GET /api/auth/session` carries the verdict as `startupCheck`; `POST /api/auth/session/audit`
re-runs it. Audits are serialised — two headless Chromiums would contend for one profile directory.
`STARTUP_SESSION_CHECK` is `all` (default), `salesforce` (skip the slow Outlook leg), or `off`.

## Environment variables (all optional, all non-secret)

`PORT` (4317) · `DEFAULT_ENV` (testing) · `HEADLESS` (true — the SF login runs in the background;
set `false` to watch it) · `STARTUP_SESSION_CHECK` (`all` | `salesforce` | `off`) ·
`DL_TEMPLATE_DIR` · `OUTLOOK_AUTH_STATE_PATH` (borrow an existing session file) ·
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
