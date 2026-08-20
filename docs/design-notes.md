# Design notes and build history

This is the record of how Auto Loader was built and why it behaves the way it does: why sending
goes through the Outlook web UI rather than SMTP, how the attachment and login failures were
diagnosed, which defects in the source sheets are reproduced deliberately, and where the process
spec and the real sheets disagree.

**It is not the guide to using the app** — that is [`README.md`](../README.md). It is also not the
current architectural reference: [`CLAUDE.md`](../CLAUDE.md) is maintained against the code and
should be trusted over this file wherever they differ.

Parts of this document were written when the app carried 13 CSV formats and 81 tests. The counts
have been corrected in place and marked, but treat any unmarked number here as historical.

---

## What this app is, as originally described

A local app that replaces the manual CSV-and-email steps of the Netradyne device fulfilment
flow. Pick product families, SKUs and quantities in a UI; the backend generates the
byte-exact CSVs, emails each one to the right distribution list, watches Salesforce converge,
and hands back the ids that were loaded.

Built from two sources of truth:

- [`device-load-and-shipment-process.md`](./device-load-and-shipment-process.md) — the process
  spec, describing the pipelines and the Salesforce side.
- `~/BSG/DL Template/*.csv` — the real template sheets (15 in the folder today). **Where these disagree with the
  spec, the sheets win**, because they are what has actually been accepted. The disagreements
  are listed at the bottom of this file.

## Setup

```bash
npm install                     # deps plus the Chromium that drives the Salesforce login
npm run dev                     # server on :4317, UI on :5317 (opens automatically)
```

If `npm install` fails with `EACCES` on `~/.npm/_cacache`, your npm cache has root-owned files
from an old npm bug. Fix it once with `sudo chown -R $(id -u):$(id -g) ~/.npm`, or install with
a different cache: `npm install --cache /tmp/npm-cache`.

```bash
npm test                        # descriptor fidelity, byte contracts, allocation, DL routing
                                # (283 tests today; 39 fail — see CLAUDE.md "Test state")
npm run build && npm start      # single-process production mode on :4317
```

## Credentials

There are none in `.env`, by design.

- **Salesforce** — you type your username and password into the app once and it drives a real
  Chromium login. Only the resulting `sid` is persisted, to `data/sessions/<env>.json` at mode
  0600.
- **Mail** — nothing. Mail goes out through Outlook on the web, whose sign-in is a saved browser
  session. See below.

`data/` and `outlook-auth.json` are both gitignored.

### You should only log in once

Both sessions are saved locally and renew themselves. Nothing asks for credentials on a routine
run.

| | Saved to | Renews how |
|---|---|---|
| Salesforce | `data/sessions/<env>.json` (sid) + `data/browser/<env>/` (browser profile) | On any 401, the sid is silently re-minted from the profile and the call retried |
| Outlook | `outlook-auth.json` in the project root | The saved session is reused directly; sends run headless against it |

**Why Salesforce needs both files.** A `sid` is a session cookie that dies on the org's session
timeout — a couple of hours. The browser profile's own trust lasts weeks. So when a sid expires
there is normally no reason to ask for credentials again: opening the profile headless against the
instance URL is enough for Salesforce to hand out a fresh one. That happens automatically inside
the API client, which then retries the call — you never see it. Only when Salesforce actually
presents a login form again (the profile itself has lapsed) does the app ask, and it says which of
the two failed.

Parallel calls all 401ing at once would each try to open the same profile directory, which Chromium
locks exclusively, so the refresh is serialised per environment.

Both files are written at mode 0600. On the Connect screen, **Renew now** forces a refresh, and
**Forget this browser** drops the profile so the next login re-challenges for MFA.

### Nothing is deleted when the app stops

There is no shutdown handler. Stopping the server, rebooting, or leaving it for a week changes
nothing on disk — every session artefact persists and is picked up on the next start.

Session state is only ever removed by an explicit action:

| Deleted by | What goes |
|---|---|
| **Disconnect** on the Connect screen | the Salesforce sid record |
| **Forget this browser** | the Salesforce browser profile |
| **Forget** on the Mail card | `outlook-auth.json` |
| Deleting a run in History | that run's record and generated CSVs |

Even an expiry keeps the record. When a sid dies and the silent refresh cannot renew it, the sid is
nulled but the file stays, so the username, capture time and refresh count survive. That is what
lets the Connect screen say *"session for you@netradyne.com expired — the remembered browser is
still here, try Renew"* rather than the indistinguishable *"not connected"*. Deleting the file on
every expiry would throw that away and make a routine timeout look like a first-time setup.

## Mail: why not SMTP

SMTP does not work in this tenant. It fails with:

```
535 5.7.139 Authentication unsuccessful, the request did not meet the criteria
to be authenticated successfully. Contact your administrator.
```

`5.7.139` is Microsoft's specific code for **SMTP AUTH being disabled** on the tenant or the
mailbox. It is not a wrong password, a wrong port, or a missing app password — basic auth for SMTP
is switched off, and no credential will get past it. Re-enabling it means an admin running
`Set-CASMailbox -SmtpClientAuthenticationDisabled $false` and turning off Security Defaults, which
Microsoft has deprecated and most tenants will not do.

So the default transport is **Outlook on the web**, driven in a browser window. It needs no app
registration and no IT request. Microsoft Graph (`POST /me/sendMail`) would be the better
engineering answer and is the thing to move to if an Azure app registration with `Mail.Send` ever
becomes available; the transport is selected in one place (`config/environments.json` →
`mail.transport`) so that swap is contained.

**Not MCP.** An Outlook MCP server is available to Claude Code, not to this app — MCP tools live in
the assistant's harness, and a standalone Node server has no MCP client. It could not send on its
own, which is the whole point of automating the flow.

### How sending works

`mail.autoSend` is **false** by default, and that is deliberate. Outlook's DOM changes without
notice and a wrong send here is a real device load in a real org. So the normal path is:

1. **Compose in Outlook** — a visible window opens, fills To / Subject / body, attaches the CSV,
   then **stops**. It refuses to continue if the CSV does not actually appear on the message: a
   mail without its attachment is inert at the far end.
2. You read it and press **Send** yourself.
3. You click **"I've sent it"** and the app looks in **Sent Items** before recording anything. If
   the message is not there it refuses to record the send, rather than let the run claim a load
   that never happened and leave the polling screen waiting for assets that are not coming. There
   is a "Record anyway" override for when you have confirmed it yourself.

Once you have watched that produce the right message a few times, **Compose & send** does it all
headless in one step — including the full Send-confirmation and Sent-Items wait.

### Where the Outlook session lives

`outlook-auth.json` in the project root, written on your first successful sign-in and reused
silently after that. Gitignored, mode 0600.

To borrow the working session from the QA repo instead of signing in at all:

```bash
OUTLOOK_AUTH_STATE_PATH=~/BSG/bsg-qa-agent/outlook-auth.json npm run dev
```

**Verified working** — that file authenticates and lands in the mailbox. Note it redirects to
`outlook.cloud.microsoft`: Microsoft is migrating OWA off `outlook.office.com`, and this tenant has
already moved. Sent Items is therefore resolved from whatever host the session actually lands on
rather than a hardcoded one, so the verification step does not chase a redirect mid-poll.

### Where this came from

The mechanics are taken from the working implementation in `~/BSG/bsg-qa-agent`
(`services/outlook-email-service.js`, `services/outlook-session-manager.js`,
`utils/helpers.js`) rather than invented. Things adopted from it that a first attempt gets wrong:

| Detail | Why it matters |
|---|---|
| Saved **storage state**, not a browser profile | Sends run headless, and nothing contends with the Salesforce login for a profile lock |
| Poll for OWA hydration (45s) | It renders its chrome seconds after `domcontentloaded`; one probe reports a good session as expired |
| Distinguish a redirect from a real sign-in prompt | Microsoft routes through `login.microsoftonline.com` even for a silent sign-in |
| Recipients are a contenteditable committed with `;` | Not an `<input>`, and an uncommitted address sends to nobody |
| Try **every** `input[type=file]` | Outlook renders unrelated hidden ones |
| Wait for Send to become *enabled* | Attachment processing disables it |
| Handle the "Attachment reminder" dialog | It greys out Send behind a modal, so retries click a dead button forever |
| Escalate Send selectors only while compose is open | A closed window means it already sent; clicking on sends a duplicate |
| Confirm in **Sent Items**, up to 180s | See below |

That last one is the important one. From a comment in the source repo: on 2026-08-01 a 1.16 MB
report reported success and then appeared in **neither Sent Items nor Drafts** — the browser had
been torn down while OWA was still transmitting. A vanished Send button is not proof of delivery;
the compose window also closes when a message is discarded. So a send is only ever recorded after
the message is found in Sent Items, and the browser is not closed before that resolves.

### Attaching: how the first failure was diagnosed

The first real run failed with `waitForEvent: Timeout 15000ms exceeded while waiting for event
"filechooser"`. Probing the live compose window showed why, and it was not what the error suggested:

```
[compose open] file inputs (4):
    {"accept":"image/*","multiple":true,"hidden":true}
    {"accept":null,"multiple":true,"hidden":true}   ← this one works
    …
setInputFiles on input[0] → filename visible on message: true
attachment chip elements:                           ← empty
```

The attach was **succeeding**. The chip detector — looking for `[class*="attachment"]`,
`.ms-attachment-filename`, `[data-testid="attachmentWell"]` — matched nothing on this OWA build, so
the code concluded the attach had failed, discarded it, and fell through to the Attach-menu path.
That path then timed out because on current OWA the Attach button opens a **menu**
("Browse this computer") rather than a native file dialog, so waiting for a `filechooser` straight
after clicking it never resolves.

Both are fixed. Detection now leads with the filename text itself — the check that actually returned
true — and is deliberately generous, because a false negative here is worse than a loose match: it
throws away a working attach. The menu route now clicks the menu item before waiting for a chooser,
and re-scans for file inputs afterwards.

That fix was **wrong**, and the next run sent a mail with no CSV on it. Probing properly showed why:

```
input[0] accept=image/*  → filename found in 0 places        ← attaches NOTHING
input[1] accept=any      → [role=listbox][aria-label="file attachments"]
                             [role=option][aria-label="…csv Open 28 bytes"]
```

The four hidden file inputs are **not equivalent**. `input[0]` is the inline-image picker and
silently discards a CSV. The code set the file there, the loose page-wide text search matched the
name somewhere outside the compose surface, and it reported success with nothing attached.

Two corrections:

- **Image-only inputs are skipped outright**, rather than tried and hoped to fail loudly.
- **Verification asks OWA**, not the page. The authoritative surface is the listbox it labels
  "file attachments", whose options carry `aria-label="<filename> Open <size>"`. A page-wide text
  match is exactly the kind of loose check that produced an empty send, so it is gone.

There is now also a final gate immediately before Send: OWA must report **exactly one** CSV, named
the one intended. An empty or duplicated send is unrecoverable at the far end — a CSV-less mail is
treated as nothing while the run records a load that never happened.

**Verified against the live mailbox**: `attachedVia: "file-input[1]"`, and Outlook itself reports
`["Initial Load_VERIFY2.csv Open 65 bytes"]`. Nothing was sent.

> **Sending itself is still unverified.** Composing is proven; pressing Send is not, because that
> would be a real device load into a real org. The send path carries the source repo's hard-won
> logic (wait for Send to become enabled, clear the Attachment-reminder dialog, escalate selectors
> only while compose is open, confirm in Sent Items for up to 180s). A failed send writes a
> screenshot plus Outlook's own banner text to `data/diagnostics/`.

### How the login works

**It logs in at each org's own domain, not `test.salesforce.com`.** That matters: the generic
sandbox page does **not** show the SSO button, so logging in there always needed a manual
detour. `loginUrl` now points at `netradyne--testing…` / `netradyne--staging…` directly, which
also means the `sid` cookie lands on the correct host with no extra navigation.

Both org pages were inspected directly and offer two ways in:

| Method | What happens |
|---|---|
| **Username & password** (default) | The two-step Salesforce form — page one has *only* a username field and "Log In to Sandbox"; the password field appears after that submit. **Stays entirely inside Salesforce.** |
| **SSO** | Clicks the org's SAML button (`#idp_section_buttons`) → **Microsoft Entra ID** (`login.microsoftonline.com`, tenant `b84f219a…`) |

**The password form is the default because it is shorter.** The org login page carries it right
next to the SSO button, so there is no reason to detour out to Microsoft and back for the same
session. Verified: a password login never leaves
`netradyne--testing.sandbox.my.salesforce.com`.

SSO is kept for accounts that can only get in that way. On that path Netradyne credentials are
optional — supply them and the Microsoft form is driven too, stopping at MFA; leave them blank and
the browser is handed over.

The driver does not follow a script — each cycle it looks at the page and takes whatever action
is available. Orgs interleave SSO redirects, verification-method choosers, org pickers and "stay
signed in?" prompts in orders no fixed sequence survives.

On the default path it stops in exactly one place: **a verification code.** The code box in the UI
activates, you enter it, and the driver resumes.

On the SSO path it can additionally stop at a **push / number-match approval**, which is genuinely
not automatable — it shows the number to enter and waits for you to approve on your phone, then
carries on by itself.

Three safety properties worth knowing, each protecting your account rather than the run:

- **It will not submit an empty password.** The field is briefly unqueryable while a page renders,
  and submitting in that window sends a blank password, which counts as a failed attempt — enough
  of those lock the account. The driver requires the field to be absent across three consecutive
  cycles before treating a page as username-only.
- **A rejected Microsoft password is fatal, not retried.** Retrying against a corporate directory
  is how accounts get locked, and an Entra lockout affects far more than this app. It reports
  Microsoft's own message and stops.
- **It never dead-ends.** If it cannot make progress for ~16s it says so, tells you which URL it
  is stuck on, and keeps watching. A "paste a sid instead" box covers an SSO variant it cannot
  drive at all.

The browser profile persists per environment under `data/browser/<env>` (mode 0700, gitignored),
so "remember this device" and Entra's "stay signed in" both survive — MFA is usually a one-off
rather than every run. "Forget this browser" on the Connect screen drops it and forces a fresh
challenge.

A persistent profile can also hand back a **stale** `sid` from a previous session, so every
captured cookie is proven with a live `Organization` query before being accepted. Otherwise you
would get a session that looks connected and 401s on first real use.

## What it covers

**6 product families across the sendable operations.** This table describes the 13 formats that
existed when it was written; there are **19 descriptors** in `templates/` today, including Octo's
three and the shared `device-dead` and `rma-returned` sheets. See `templates/` for the current set.

| Family | Operations | Cols | Mints |
|---|---|---|---|
| Driveri (Bagheera3) | initial load, shipment update | 28 | `device_id`, `sim_serial`, `device_imei` |
| Octo (D-810) | initial load, **update load** | 32 | 5 numeric series + 2 pseudo-MACs |
| Driveri Hub | initial load | 17 | `driveri_hub_id` |
| DMS Camera | initial load | 17 | `Serial number` |
| Haptic | initial load, shipment update, **data update** | 18 | `Serial number` |
| VBUS | initial load | 16 | `serialNumber`, `macId` |
| any | **received at 3PL** | 5 | — reuses a prior run's ids |
| any | wizard upload (×2 variants) | 2 | — reuses a prior run's ids |

**"Update load" is a separate operation from "shipment update."** The DL list names one mailbox
*"Initial Load & Update Load DL"* and a different one *"Shipment Update DL"*, so an update load
shares the initial-load address. `Octo Update Load NAZ110001.csv` is therefore classified as
`updateLoad`, not `shipmentUpdate`. **Worth confirming** — if Octo's update load is really meant
for the shipment-update mailbox, it is a one-word change in
`templates/octo-data-update.json`. **Since resolved:** that descriptor was renamed and
re-declared as `operation: dataUpdate`, which leaves `updateLoad` with no sheet in any family — it
is now a mailbox-only operation.

Accessories are not one format. DMS, Haptic, DHUB and VBUS are each their own template with
their own column names, byte rules and numbering scheme. **Octo is different again**: it
bundles its accessories *inline*, carrying wired-speaker and native-camera SKUs and serials in
four extra columns, so it has no separate accessory file at all.

## The flow

| Screen | What it does |
|---|---|
| **Connect** | Salesforce + SMTP, and every mailbox this environment would send to |
| **Setup** | Operation, tracking id, and an **optional** order |
| **Families & SKUs** | Pick families and quantities; shows each template's shape, byte contract and the ids it will mint |
| **Ids** | Every series' next value and the allocated blocks, with a "check availability" query |
| **Review & send** | Per-family files, hex byte preview, the full checklist, then one send per family |
| **Watch** | One row per unit, `*_SYNC_FAILED` surfaced immediately, polling continues server-side |
| **History** | Every past run and the ids it loaded |

Each family is its own CSV and its own email — every send carries exactly one attachment, so a
Driveri batch and a Haptic batch cannot share a message even when they go to the same mailbox.

## Still needed from you

### 1. Three mailboxes, and four CSV formats

Routing is otherwise complete in both environments. `✓` = sendable today.

| Operation | Testing | Staging | Families with a template |
|---|---|---|---|
| Initial load | ✓ `Asset-Shipped-From-MFR-Testing@` | ✓ `assets_shipped_from_vvdn@…` | all six |
| Shipment update | ✓ `Asset_Shipment_Update_Testing@` | ✓ `asset-shipment-update-from-mfr@…` | Driveri, Haptic |
| Received at 3PL | ✓ `Asset-Received-At-3PL-Testing@` | ✓ `assets_received_at_3pl@…` | any |
| Update load | ✓ *(shares initial load)* | **missing** | Octo |
| Data update | **missing** | **missing** | Haptic |
| Faulty returned to VVDN | ✓ `assets_returned_to_vvdn@…` | ✓ `assets_returned_to_vvdn@…` | **no template** |
| Mark dead | ✓ `assets_non_repairable_at_repair_center@…` | ✓ `asset_markdead_emailservice@…` | **no template** |
| Undo mark dead | **missing** | ✓ `asset_markundodead_emailservice@…` | **no template** |
| Non-repairable at MFR | ✓ `Non-Repairable-Asset-At-MFR-Testing@` | **missing** | **no template** |

**Three addresses to fill in:**

- `dataUpdate`, both environments — `Haptic_Data_Update.csv` is a real format with nowhere to go.
- `updateLoad`, staging — testing bundles it with initial load under one *"Initial Load & Update
  Load DL"*, so the same address is plausible here, but I have not assumed it.
- `nonRepairable`, staging, and `undoDead`, testing — each exists in one environment only.

None of these are guessed. A wrong mailbox is a silent no-op or a double load, and the mailbox is
the only thing that tells the parser which operation a file represents.

**Four operations have a mailbox but no CSV format:** faulty-returned, mark-dead, undo-mark-dead
and non-repairable. They are registered and routable, but no template sheet exists, so no run can
select them. Send a sample of each and they become JSON drop-ins.

### Two things to know about the Apex addresses

Every staging address, and two of testing's, are Salesforce **Apex email service** addresses
rather than netradyne.com mailboxes.

**They change on sandbox refresh.** Each service gets a randomly generated subdomain under the
org's host (`…cw-5p40juac.usa886s.apex.sandbox.salesforce.com` for staging). After any refresh,
re-copy all of them from Setup › Email Services or sends will bounce.

**Staging's mark-dead and undo-mark-dead differ only by the word "undo"**
(`asset_markdead_emailservice` vs `asset_markundodead_emailservice`), on the same host pattern —
two operations that reverse each other. This is precisely what the local-part match on every send
exists to catch, and `npm test` asserts all of it: that the two are not interchangeable in either
direction, that initial-load and shipment-update services are not interchangeable, that a correct
local part on another service's host is refused, and that no address resolves the same in both
environments.

If a family needs a *different* mailbox from the shared one for an operation, add it under
`distributionLists.byFamilyOperation` as `"vbus:initialLoad": { … }`; resolution prefers a
family-specific entry and falls back to the operation-level one. The app shows which rule a
send resolved through, since the mailbox is the only thing that distinguishes one operation
from another.

### 2. Sandbox endpoints — done

Both are configured and were verified reachable:

| Environment | Instance |
|---|---|
| Testing | `https://netradyne--testing.sandbox.my.salesforce.com` |
| Staging | `https://netradyne--staging.sandbox.my.salesforce.com` |

Both expose API versions 31.0–67.0, so the configured `v61.0` is valid on each. Neither URL
carries a trailing slash — the REST path is appended directly and a double slash is rejected;
a test enforces this.

The spec's verified facts — the `Confirmed`-matches-nothing trap, the ~⅓ initial-load failure
rate, the catalog counts — were all measured against **testing**. Staging is a different org, so
re-run the spec's §6 and §8 queries there before trusting those numbers. The app does not depend
on them (quantities come from `OrderItem`, statuses are read and never filtered on), but your
expectations might. Testing only lacks the dataUpdate and
received addresses.

### 3. Two judgement calls worth confirming

- **`haptic-shipment-update` date format.** That sheet writes `Manufacturing_Date` and the D2C
  date as `DD/MM/YY` (`20/05/26`), while `Haptic_Initial_Load.csv` writes `YYYY-MM-DD` for the
  same columns. The two sheets contradict each other and the column name says `YYYY-MM-DD`, so
  the descriptor follows the column name. If the parser actually needs `DD/MM/YY`, set
  `"dateFormat": "DD/MM/YY"` in `templates/haptic-shipment-update.json` — one line, no code.
- **Which wizard upload.** Both `order_load.csv` (`SKU,Serial_Number`) and
  `partner_order_load.csv` (`Device_Type,Serial_Number`) exist. The app generates the former;
  `partner-order-load` is ready to use if that is the right one.

## How output correctness is established

`npm test` regenerates each real sheet from its descriptor and compares byte for byte:

- Every header matched its source sheet exactly **at the time of writing (13 formats)**.
- Every byte contract matched — BOM, line endings, trailing newline.

**No longer true as stated.** Of the 19 descriptors now present, only three have complete
byte-level verification; seven name a source sheet that is not in the folder, and `device-dead`
declares no `sourceTemplate` at all despite reading `status: "verified"`. CLAUDE.md's "Test state"
section has the current breakdown.
- **Two whole files** (`Shipment Update Load_B3E110005.csv` and the 100-row
  `VBUS_Initial_Load RTS120013.csv`) regenerate **byte-identical**, BOM and all.
- The rest match on every row and column except documented defects in the source sheets, and
  **each exclusion has its own test asserting the defect is real** so a sheet quirk cannot
  quietly become a generator bug.

### Defects found in the source sheets

| Sheet | Defect | Handling |
|---|---|---|
| `Initial Load_B3E110005.csv` | rows 6–10 have `system_pn`, `invoice_number`, `po_number` incrementing (`901-1-02282`→`02287`) | Excel autofill. A part number does not vary per unit — held constant |
| `Octo Initial Load` / `Update Load` | row 1 has literal single spaces in six columns that later rows leave empty | written as empty |
| `Octo Update Load` | accessory serials run …202, …201, …203 | hand-shuffled, not a sequence — emitted in order |
| `Haptic_Data_Update.csv` | trailing row of bare commas | not reproduced |
| `Haptic_Shipment_Update.csv` | dates as `DD/MM/YY` where the sibling sheet uses `YYYY-MM-DD` | follows the column name; see above |

### Quirks preserved deliberately

- **`Wired_Speaker _SKU(required)`** — the Octo header really does have a space before `_SKU`.
- **`DMS_IntialLoad {trackingId}.csv`** — "Initial" is misspelled in the source filename. Kept,
  so generated files match what the mail parser has been receiving.
- **Octo/Haptic tracking column vs filename** — those sheets carry `NA` in the tracking column
  while the *filename* carries a real id. Modelled as two separate things.
- **Haptic filenames carry no tracking id** at all.

## Where the spec and the real sheets disagree

| Spec says | Sheets show | App follows |
|---|---|---|
| Initial load is **LF** with a trailing newline | **CRLF**; trailing newline varies by sheet | the sheets, per template |
| Wizard upload **requires** a BOM (`EF BB BF`) | `order_load.csv` has none; `partner_order_load.csv` does | each template's own bytes |
| `sim_serial` == `device_imei` per row | three distinct series, offset by 10 | the sheets — no equality check |
| `shipment_tracking_id` is the Salesforce OrderNumber | a separate tracking id (`B3E110005`, `RTS120011`) or literally `NA` | a user-supplied tracking id |
| One initial-load format plus one accessory format | 6 families, 5 operations, 13 formats | all 13 at the time |
| 6 required columns in the 28-col format | 7 columns are marked `(required)` | the column names |

All 15 sheets are CRLF and not one contains a bare LF. BOM presence and trailing newline vary
*within* a single logical format, which is what you would expect if they just reflect whether a
sheet was last saved by Excel ("CSV UTF-8" adds a BOM) or a plain editor — so neither is what
the parser gates on. Each descriptor reproduces its own sheet's bytes regardless, so output is
indistinguishable from a file already known to work.

## Other departures from the old automation

**Quantity comes from `OrderItem.Quantity`.** The old `packFactorFromSku()` read the digits
after `USASI` as a pack size; they are option flags. For `K2I131USASI10FAS` it asked for 10
devices where the order needed 1. Nothing here derives a count from a product code.

**Two counts, modelled separately.** *Batch size* is how many units to load — free, it is a
manufacturer batch. *Order quantity* is how many serials a wizard upload needs — fixed by the
order. Uploading fewer sets the order to `Partially Shipped`, which hides the "Load Asset &
Ship Order" button and dead-ends the flow, so the picker warns before you get there.

**The order is optional.** An initial load does not have to relate to any order — the real
sheets prove it, carrying tracking ids rather than order numbers.

**`*_SYNC_FAILED` is terminal.** Roughly a third of initial loads fail in this org. The old
poller waited a flat 30 minutes at 20-second intervals before reporting a soft failure, so it
said nothing for half an hour on a third of runs. Here failure ends the poll for that unit the
moment it appears, and the first few polls are 5 seconds apart.

**No order is ever found by `Status = 'Confirmed'`.** No Order in this sandbox has ever had
that status; a finished order is `Activated`. Status is displayed and used for the
`Partially Shipped` warning, never as a search filter.

**Ids come from persisted counters, not a random reroll.** The old generator picked a random
start and discarded the whole block if any member collided, up to 30 times. Here each
(environment, template, series) has its own counter, so blocks are contiguous and auditable,
and on collision it advances past the highest hit — every retry is forward progress. Series
also refuse to overflow their declared digit width.

**A send is not reported as success until it is in Sent Items.** Whichever transport is in use, the
message is looked for in Sent Items before the run records it. When it cannot be confirmed the app
says so rather than guessing either way — a blind retry is a double load.

**Re-sending the same file to the same mailbox is blocked** unless explicitly forced, and
re-sends use the bytes stored on disk rather than regenerating (which would allocate new ids).

## Layout

```
config/environments.json     per-env Salesforce endpoint + DL routing by operation and family
config/profiles.json         Asset picklists and order-status facts
templates/*.json            descriptors — columns, byte rules, series, filename, sources (19 today)
templates/README.md          descriptor schema and per-sheet quirks
server/lib/bytes.js          BOM/CRLF/LF primitives, byte-contract assertions, hex dump
server/lib/config.js         config + templates, DL resolution, placeholder detection
server/services/
  sf-session.js              Playwright MFA login, sid capture and storage
  sf-client.js               all Salesforce reads; sync-status classification
  sku-decoder.js             positional SKU decoding (no quantity inference)
  id-generator.js            declarative multi-series allocation with persisted counters
  csv-builder.js             template-driven generation and row planning
  validator.js               pre-send checks, driven off descriptor rules
  mailer.js                  transport dispatch, SMTP, .eml fallback
  outlook-web-service.js     Outlook on the web: compose, attach, Sent Items confirmation
  poller.js                  server-side polling loop
  run-store.js               run persistence and generated bytes on disk
  templates.test.js          round-trip fidelity against the real sheets
server/routes/               auth, catalog, runs
web/src/pages/               the seven screens
data/                        runtime only, gitignored: sessions, counters, runs, output
```

## Where a model would help, and where it must not

Nothing here is wired to an LLM. If it is added later, the useful places are failure triage
(explaining a `_SYNC_FAILED` in plain language), natural-language SKU search, and mapping a
manufacturer's messy spreadsheet onto a template's columns for confirmation.

Keep it out of id generation, byte formatting, quantity arithmetic, and the send decision.
Those are a hard spec, and a hallucinated column ends the run.
