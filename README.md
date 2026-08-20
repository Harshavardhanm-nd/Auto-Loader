# Auto Loader — user guide

Auto Loader replaces the manual CSV-and-email steps of the Netradyne device fulfilment flow. You
pick product families, SKUs and quantities; it generates the byte-exact CSVs, emails each one to
the right distribution list, watches Salesforce until the devices appear, and hands back the ids
that actually loaded.

It runs on your own machine. There is no shared server and no deployment.

**The one thing to understand before you start:** this app cannot change anything in Salesforce
directly. It only ever *reads*. The only way a device is created or moved is an email with a CSV
attached, which an Apex email service on the Salesforce side parses. That is why the app is so
particular about two things — **which mailbox a file goes to**, and **the exact bytes of the file**.
Everything else it does is bookkeeping around those two facts.

---

## Contents

- [Getting it running](#getting-it-running)
- [The vocabulary](#the-vocabulary)
- [Walkthrough: one run, start to finish](#walkthrough-one-run-start-to-finish)
  1. [Connect](#1-connect)
  2. [Setup](#2-setup)
  3. [Families & SKUs](#3-families--skus)
  4. [Ids](#4-ids)
  5. [Review & send](#5-review--send)
  6. [Watch](#6-watch)
- [After the first load: chaining operations](#after-the-first-load-chaining-operations)
- [When a third of the batch fails](#when-a-third-of-the-batch-fails)
- [The other two screens](#the-other-two-screens)
- [When something goes wrong](#when-something-goes-wrong)
- [Things that will surprise you](#things-that-will-surprise-you)
- [Where things live on disk](#where-things-live-on-disk)
- [Further reading](#further-reading)

---

## Getting it running

```bash
npm install     # dependencies, plus the Chromium that drives the Salesforce and Outlook logins
npm run dev     # server on :4317, UI on :5317 — opens your browser automatically
```

Use `npm run dev` while working: it restarts the server when you change a file. `npm start` (after
`npm run build`) runs a single production process on :4317 and does **not** reload — if you edit
code and nothing changes, that is usually why.

If `npm install` fails with `EACCES` on `~/.npm/_cacache`, your npm cache has root-owned files from
an old npm bug. Fix it once:

```bash
sudo chown -R $(id -u):$(id -g) ~/.npm
```

You need two accounts, and the app handles them differently:

| | What it needs | Where the credentials go |
|---|---|---|
| **Salesforce** | username + password, and an MFA code when the org asks | typed into the Connect page, held in memory only, never written to disk |
| **Outlook** | your normal work sign-in | typed into a browser window the app opens; the app never sees them |

There are no credentials in `.env` or in any config file, and nothing to set up before your first
run beyond `npm install`.

---

## The vocabulary

Five words that appear everywhere and mean something specific here.

**Run** — one trip through the flow, identified by a **tracking id** you choose. Everything is
scoped to a run: the ids it minted, the files it built, the emails it sent, what Salesforce says
about its devices.

**Tracking id** — your own label for the batch, like `B3E110005`. It is *not* a Salesforce order
number. You make it up; it just has to be something you will recognise later. Attaching a real
order is optional and separate.

**Operation** — which step of the device life cycle you are performing. The ones with a sheet you
can send:

| Operation | What it does |
|---|---|
| **Initial load** | Creates the Assets. This is where a device first exists in Salesforce. |
| **Data update** | Corrects device data without moving the device. Only Octo and Haptic have a sheet for it, and **Octo must do it before shipping**. |
| **Shipment update** | Marks the devices as shipped from the vendor. |
| **Received at 3PL** | Records arrival at the third-party logistics partner. |
| **RMA Returned** | A returned device coming back in. |
| **DEAD** | Marks a device dead. Destructive — treat it as such. |
| **Wizard upload** | The serials-only upload some flows need. |

Four more (`Update load`, `Non-repairable at MFR`, `Faulty returned to VVDN`, `Undo mark dead`) have
a mailbox configured but **no CSV sheet**, so the app shows you where they would go and refuses to
generate a file. That is deliberate, not a missing feature.

**Family** — the product line: Driveri, Octo, DHUB, DMS, Haptic, VBUS. **One family = one CSV = one
email.** Two families never share a message, even when they route to the same mailbox.

**Environment** — `testing` or `staging`, picked in the left rail. They are entirely separate
Salesforce orgs with separate mailboxes, sessions and run histories. **Switching environments starts
a new run**, deliberately: a ten-digit device id from testing looks exactly like one from staging,
and mixing them is the mistake with the worst consequences.

---

## Walkthrough: one run, start to finish

The left rail lists the steps in order and **unlocks them as you go** — Setup needs a Salesforce
connection, Families & SKUs needs a tracking id, everything after that needs a run to exist. If a
step looks greyed out, the answer is always "finish the one before it".

The strip along the top (the **Runbar**) shows the same seven facts on every screen — environment,
operation, tracking id, order, families, units, state — and starts as `—`. It doubles as your
progress record; glance at it rather than trying to remember where you are.

### 1. Connect

Sign in to Salesforce and to Outlook.

**Salesforce.** Type your username and password. The login runs invisibly in the background, and it
is identifier-first: your username is submitted on its own, then the password on the next page. If
the org asks to verify your identity, the page will say **awaiting MFA** and give you a box — type
the code from your authenticator **into the app**, not into a browser window.

If the app gets stuck on a screen it does not recognise, it offers to **show you the browser** so
you can finish by hand. It also writes what it saw to `data/diagnostics/` — the page URL, title and
visible controls, but never anything you typed.

**Outlook.** Click sign in, and a real browser window opens. Log in as you normally would. The app
never handles those credentials; it just reuses the session afterwards.

**Read the mailbox table before your first send.** It lists every operation and the exact address
this environment would send to. Any address showing as a placeholder blocks *that operation only* —
the rest of the app still works. This table is the single best check that you are about to email
the right place.

Both sessions survive restarts, and the app checks whether they are still alive when it boots. A
green card means "there is a saved session", which is not quite the same as "it still works" —
hence the check.

### 2. Setup

Three things:

- **Operation** — usually Initial load to begin with.
- **`shipment_tracking_id`** — your batch label, e.g. `B3E110005`.
- **Order number** — *optional*. Attaching one shows you the order's lines and how many serials it
  expects, which is worth having. Leave it blank if you are not loading against an order.

If you do attach an order, the page shows **Serialized lines**, **Serials the order needs** and
**Non-serialized**. Note the second one: it is not the same as how many devices you are loading.
Which brings us to the single most important rule in the app.

> **Batch size and order quantity are different numbers.** How many devices you load is your
> choice. How many serials the order expects is the order's business. Conflating them sets the
> order to **Partially Shipped**, which hides the "Load Asset & Ship Order" button in Salesforce and
> dead-ends the flow. The app will warn you; believe it.

### 3. Families & SKUs

Pick which products you are loading and how many of each.

The catalog is read live from Salesforce and filtered to the products that belong to the family you
picked. Each row shows a one-line description of what the product actually is, decoded from the SKU
where possible and taken from the org's own classification otherwise.

Two things to know:

- **If the catalog fails to load, you get the error verbatim, not an empty list.** Salesforce
  usually names the exact column or reason it refused, and that sentence is the whole diagnosis.
  There is a Retry button.
- **"Show all" is always available.** The per-family filter can go stale if the org renames a
  product series, and showing too many SKUs only costs you a search — showing none would stop you
  working. If a SKU you expect is missing, click Show all before assuming it is gone.

Set a quantity per SKU. One run can carry several SKUs and several families at once; each family
becomes its own file and its own email.

### 4. Ids

This is where device ids, sim serials, IMEIs and MAC addresses get allocated.

Ids come from persisted counters, not random numbers, and they only ever move forward. The page
shows each series' next value and the block it allocated for this run, and **checks every candidate
against Salesforce before using it** — if an id is already taken, the counter steps past it.

You will normally just look at this page and move on. Two things you may need:

- **"Check availability"** re-runs the collision query without allocating anything.
- **"Set to…"** moves a series' cursor by hand. This is the escape hatch for when the app's counters
  and the org have drifted apart. It refuses to exceed the series' declared digit width.

**Ids are minted once per run and reused by every later operation on the same devices.** A shipment
update does not invent new ids — it would update nothing if it did.

### 5. Review & send

The screen that matters most. Check three things, in this order.

**1. The destination mailbox.** It is the loudest thing on the page, and that is on purpose. It is
the only visible marker of which operation a file represents, so it outranks the filename and the
byte counts. Confirm it before anything else.

**2. The row count.** It must equal the order's serialized quantity — see the Setup warning above.

**3. The file itself.** You can preview the generated bytes as text or as a hex dump. The hex view
is there because the things that break an Apex parser are invisible in a text view: a byte-order
mark, the wrong line ending, a missing trailing newline. Each template declares its own contract and
these legitimately differ between sheets, so do not "fix" one to match another.

The page also runs a checklist and grades each item:

- **Blocker** — sending is refused. Fix it.
- **Warning** — you can proceed, and sometimes should. Stage checks are always warnings, because
  the device's stage is written by another system and can change between the read and the send;
  refusing on it would invent a new way to be stuck.

Then send. **The button carries the whole lifecycle in place**, and the states are worth knowing:

```
Compose in Outlook  →  Working…  →  Awaiting your Send…  →  ✓ Sent
```

**`Awaiting your Send…` means the ball is in your court.** The app composes the message, attaches
the file and fills in the recipient — then stops. **You press Send in Outlook.** The app keeps
waiting, then confirms by finding the message in Sent Items.

That last part matters: **a send is only recorded once the message is confirmed in Sent Items.** A
composed-but-unsent message is not a send, and the app will not pretend otherwise. If you navigate
away or restart the server with a compose window still open, the app remembers and offers to check
Sent Items or discard the window — that state lives on the run, not on the screen.

There is a **Send without review** button. It is deliberately drawn as a thin outline rather than a
solid block, so it does not pull your eye away from the safe path. Use it when you already know
exactly what you are sending.

### 6. Watch

Where you find out what Salesforce made of your file.

Expect this to take a while, and expect failures. **Roughly a third of initial loads fail in this
org.** That is ordinary, not a crisis, and the app treats a `*_SYNC_FAILED` status as final the
moment it sees it rather than waiting out a timeout.

The tab strip holds **two different kinds of thing**, and telling them apart saves confusion:

**Stage tabs** — Initial load, Data update, Shipment update, Received at 3PL, RMA Returned. These
are real polling targets. Each has its own server-side poll loop, its own snapshot, and start/stop
controls. Polling continues on the server, so you can close the browser.

**Asset views** — Shipped Active, Installed, RMA Pending, RMA Initiated, DEAD. These are read-only
filters over the initial-load snapshot. They cannot be polled and have no data of their own. Two of
them — RMA Initiated and DEAD — let you select devices, because those feed the RMA Returned and DEAD
operations. DEAD sits last in the strip on purpose, away from the ordinary operations.

**Selecting a tab re-reads Salesforce automatically.** It shows you the stored snapshot instantly,
then quietly brings it up to date. If that background read fails you will see the rows plus
`could not reach Salesforce · showing <time>` — that timestamp is the only thing separating fresh
data from a silently stale read, so trust it over your assumptions.

**A stage tab shows only the devices currently at that stage.** Devices that have moved further on
are split out behind a notice saying where each one went, and there is always a way back to
everything that was sent — that is the record of what your email carried, and it stays reachable.

Every serial number in the table links to its Salesforce Asset, and the table names each device by
its product name, SKU and category alongside the id.

Once a stage settles, the **result card** shows the headline answer: which ids loaded. If that
verdict is older than the last reading and disagrees with it, the card says so and offers to
re-check — which is what you want after fixing a batch that partly failed.

---

## After the first load: chaining operations

You do not start a new run for the next operation. **One run walks the whole chain, on the same
ids, over a shrinking subset of its own devices.**

When a stage settles, Watch offers the next operation over exactly the devices that succeeded. Tick
the ones you want and it generates for that subset — no new ids, just a filter over the ones already
minted. The devices that failed stay behind; the rest move on.

The chain the operator actually walks:

```
(no Asset) --initial load--> Pre-Production --shipment update--> Shipped From Vendor
           --received at 3PL--> New --> everything after this belongs to somebody else
```

**Octo takes a detour.** Octo owes a **data update** before its shipment update — it corrects device
data at Pre-Production before shipping. Other families skip it. Watch routes an Octo selection to
Data update rather than Shipment update, so you do not have to remember. Octo devices are also held
back until their related accessories (wired speaker, native camera) have synced.

---

## When a third of the batch fails

This is the normal case, so it is worth having a routine.

1. **Read the failure on the Watch tab.** A device carrying `*_SYNC_FAILED` is finished failing —
   nothing more will happen to it on its own.
2. **Let the successes move on.** Tick them and take the hand-off to the next operation. A partly
   failed load is not a dead end, and the ~⅔ that worked should not wait for the rest.
3. **Deal with the failures separately.** Recovering a failed device currently means fixing it in
   Salesforce — see the note below — and this app does not automate that.
4. **Re-check the verdict.** After the failures are resolved, press **Refresh from org** on the
   stage tab that recorded the verdict, and the run's headline answer updates. If you are on a
   different tab, the result card will tell you which stage to re-check and offer a button.

> **A device may not be loaded twice for the same operation.** The app compares the device ids in
> the file against every send for that operation and family, and refuses a repeat. Sending half a
> batch and then the other half is two legitimate emails and is allowed; sending the same devices
> twice is not. When it cannot tell, it refuses — a blocked send is recoverable, a double load is
> not.

**On recovering a failed device:** in Salesforce the "Sync to IDMS" button appears on an Asset at
Initial Load, Shipment Update or Received at 3PL that has not synced. For a device that has already
failed, the manual route is to edit its `Sync_Status__c` back to the un-suffixed value, after which
the button reappears. Automating that from this app was investigated and is currently blocked on a
Salesforce permission (the Apex class behind the button is not granted to the `Operations` profile,
though `Operations-India` has it). Until that changes, this step is manual.

---

## The other two screens

**Life cycle** — the device stage chart: 14 stages keyed on the numeric `IDMS_Status__c`, with every
operation placed on it. Click a stage to see what moves a device into and out of it. Useful for
answering "where is this device and what happens next", and for seeing which arrows belong to this
app versus the Installer App, the customer or the order integration. Five arrows were ambiguous on
the source chart and are marked as such rather than guessed at.

**History** — every past run and the ids it loaded, **scoped to the current environment**. Testing
and staging histories are never interleaved, for the same reason switching environments starts a new
run: the ids look identical and confusing them is expensive.

---

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| A step in the rail is greyed out | Its prerequisite is not done | Finish the previous step |
| **awaiting MFA** on Connect | The org wants a verification code | Type the code from your authenticator into the app |
| Salesforce login stalls on an unknown screen | The driver hit a page it does not recognise | Use the offer to show the browser; check `data/diagnostics/` for what it saw |
| **expired, try Renew** | The saved session lapsed | Renew on Connect. Session records are emptied, not deleted, so the app can tell "expired" from "never connected" |
| A pipeline has no mailbox | That operation's address is still a placeholder | Only that operation is blocked; the rest works |
| Catalog shows an error with the exact text | Salesforce refused the query | Read it — it usually names the field or reason. Retry after fixing |
| A SKU you expect is missing | The family filter may be stale | Click **Show all** |
| Send refused as a duplicate | Those device ids already went for this operation and family | Check History. If it is genuinely a different set of devices, regenerate for that subset |
| `*_SYNC_FAILED` on Watch | The Apex parser rejected that device. Final | Move the successes on; handle failures separately |
| `could not reach Salesforce · showing <time>` | A background refresh failed; rows are from that time | Press **Refresh from org** |
| Verdict says failures but devices look fine | The verdict predates the fix | Re-check from the stage that recorded it — the result card offers a button |
| Outlook says "must have at least one recipient" | Two compose windows were open | Close both and send again. The app now refuses rather than guessing which window it filled |
| You edited code and nothing changed | You are on `npm start`, which does not reload | Use `npm run dev` |

---

## Things that will surprise you

Collected because each one has caught somebody out.

- **You press Send, not the app.** By default it composes and stops. A composed message is not a
  sent message and is never recorded as one.
- **Salesforce is read-only from here.** Nothing this app does changes the org except an email.
- **Ids are minted once per run** and reused by later operations. Never re-allocate for a subset.
- **Never derive a quantity from a SKU.** SKU decoding is positional only. Batch size and order
  quantity are separate counts, always.
- **Byte contracts differ per template.** All the source sheets use CRLF, but the byte-order mark
  and trailing newline vary *within* one logical format. Do not unify them.
- **Switching environments starts a new run.** Not a bug — a guardrail.
- **Polling runs on the server.** Close the browser; it keeps going.
- **`Confirmed` is never used to find an order.** No order in these sandboxes has ever had that
  status. It is displayed, never used as a filter.
- **DEAD is destructive and sits apart from the other tabs** for that reason.
- **Nothing here is wired to an AI model, deliberately** — not id generation, byte formatting,
  quantity arithmetic, or the decision to send.

---

## Where things live on disk

Everything is under `data/`, and nothing is deleted unless you ask.

```
data/runs/<runId>.json        one file per run — ids, files, sends, snapshots
data/output/<runId>/          the generated CSVs, under their real filenames
data/counters.json            id cursors, keyed env:template:series
data/sessions/<env>.json      Salesforce session (permissions 0600)
data/browser/<env>/           the remembered browser profile (0700)
data/diagnostics/             screenshots and page dumps from failed logins and sends
outlook-auth.json             the Outlook session (0600)
```

Every step writes the run to disk as it happens, so a refresh, a restart or a session expiring
mid-poll never loses ids that were already sent. **Those devices exist in Salesforce whether or not
this app remembers them** — which is the whole reason the run file is written eagerly.

Deleting a run removes its record here. It does **not** undo anything in Salesforce.

---

## Further reading

- [`CLAUDE.md`](./CLAUDE.md) — the architectural reference, maintained against the code. The most
  current description of how anything works. Read this before changing code.
- [`docs/design-notes.md`](./docs/design-notes.md) — build history: why sending goes through the
  Outlook web UI rather than SMTP, how the attachment and login failures were diagnosed, which
  source-sheet defects are reproduced deliberately.
- [`templates/README.md`](./templates/README.md) — the descriptor schema and per-sheet quirks. Read
  this to add a CSV format. Its counts are out of date; the descriptors themselves are authoritative.
- [`device-load-and-shipment-process.md`](./device-load-and-shipment-process.md) — the original
  process spec. **Where it disagrees with the real sheets, the sheets win** — they are what the Apex
  parser has actually accepted.

### For developers

```bash
npm test                       # the full suite
node --test server/lib/lifecycle.test.js        # one file
```

Some tests currently fail for reasons that predate any change you are about to make — mostly stale
assertions left behind by merges, plus seven descriptors naming a source sheet that is not in the
template folder. **Read the "Test state" section of `CLAUDE.md` before debugging a failure**, so you
can tell an inherited failure from one you caused.

Note also that if the sheet folder (`~/BSG/DL Template`, override with `DL_TEMPLATE_DIR`) is
missing, the byte-contract tests **self-skip and the suite reports green**. Check for `skipped` in
the summary before trusting a pass.
