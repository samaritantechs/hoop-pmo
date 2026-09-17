# Transfers — stock changing hands inside HOOP, signed on screen

> *"store keeper needs the transfer doc to be blue ink signed online on a transfers navigation
> by sender and receiver so that we could export and print. as the signing feature we
> implemented in hopeloan customer onboarding just on screen signature not biometrics."*
>
> *"RSM requests stock from sipho. 1. Sipho / Store transfers them to RSM — IMEI, To and Fro
> names, Tarehe, Qty, Model. 2. RSM to Agents — supplying. 3. Agent to RSM (the returns for
> re-allocations). 4. RSM / Agent to Sipho / Store. 5. RSM to RSM (Sipho does it on system, they
> log in to sign)."*
>
> *"Transfers — Window 3: Stock (each can see stock in their possession), Send (can select imei
> no or input list of imei nos and search system user to send to), Receive (find received and
> decline or accept to overwrite stock ownership). So RSM only see stock in old and new that's
> theirs already only, same for agents, Sipho sees all. So at access codes I have roles RSM
> STORE and AGENT."*

## Three windows, one ledger

| window | who sees what | what it does |
|---|---|---|
| **Stoo / Stock** | what is in *my* hands — the register's handsets and the old-stock list's, unsold. The desk: everybody's, holder beside each | tick serials, **Send selected** |
| **Tuma / Send** | — | the sender is **the account I signed in with** (fixed, shown, never typed); the serials (ticked or pasted — the first box); who receives, picked **by role, then by name** from the system users in that role; the model from a **prelisted** dropdown of every model the stock knows; the unit price, or **blank to take each phone's NEW STOCK price**; a note; **my signature** |
| **Pokea / Receive** | waiting for me · sent by me · settled | open a waiting document, **sign to accept** — or **decline** with a reason |
| **Nyaraka / Documents** | mine; the desk: every document | the printable register, filtered by status. **Chapisha / Print** prints the document from a page of its own — every serial, numbered **S/N** on the left, the header repeated on each sheet, the signatures as images — not the first screen of the drawer. **⤓ Hifadhi PDF** saves the same document as a PDF; see *Paper, and the phone* |

A transfer is opened by the sender — or by the store desk **on somebody's behalf**, which is
flow 5 word for word — and sits as `sent` until the receiver logs in and either **accepts** it,
signing on their own screen, or **declines** it in words. Acceptance is the one moment stock
changes hands: the holder on every handset in the document is overwritten to the receiver —
`devices.holder` for a locked phone, `old_stock.agent` (and the RSM beside it) for one never
enrolled. Nothing moves on a decline, and nothing moves while the document waits. Every handset
on the register also gets a `device_events` line (`transfer`), the same trail a lock or a shift
leaves.

| status | meaning |
|---|---|
| `sent` | waiting for the receiver |
| `accepted` | receiver signed; every holder overwritten; `moved` says how many |
| `declined` | receiver refused, with `decline_reason`; nothing moved |

## Who can send what

- **The sender is the account that is signed in.** *"sender must be current account
  settings"* — the name and role come off the login and are shown, not typed; a `fromName` that
  is somebody else is refused, for the desk too. Flow 5 ("Sipho does it on system, they log in
  to sign") is therefore the desk sending **as the store** to the RSM, and the RSM sending on
  their own login — never one person opening a document in another person's name.
- **You send what is in your hands.** A sender who is not the desk can only send stock in their
  own possession — the same list their Stock window shows. Anything else is refused by IMEI.
- **The desk sends anything.** STORE (and ADMIN) may send serials the system has never heard of
  (they go on the document as *unknown*, with nothing to overwrite).
- **The receiver is picked by role, then by name** from the system users in that role — an
  access code carrying RSM, AGENT, ADMIN or the store desk in any of its spellings (STORE,
  GHALA, SUPER AGENT) — because it is their login that accepts. The list is what the stock
  names (see *Who the stock names becomes a system user*); a name that is on no code is refused
  with those words.
- **STORE receives as the warehouse.** *"role store = superagent"*: a document accepted under a
  STORE code lands the handsets on the holder **`SUPER AGENT`** — the register's warehouse node,
  the same one the old-stock list uses — not on the store keeper's own name, so the desk's
  stock is one pile whoever is on shift.
- **The price is the stock's unless you type one.** Blank unit price means each line takes its
  own `stock_audit.price` (the NEW STOCK stamp); a typed price applies to every line. The reply
  says how many lines were priced off the stock.
- **The hierarchy rule stands.** Every pairing is a normal hand-off — store ↔ RSM, RSM ↔ RSM,
  agent ↔ agent under the same RSM, agent ↔ super agent — *except* two field agents who report
  to two different RSMs, whoever is at the keyboard. Who is an agent: the staff register where
  it has a row, otherwise the **access code's role** (an agent the stock lists without a phone
  holds a code but no register row, and is still an agent). Whose agent: the register's
  manager-derivation the sales-targets roll-up uses (`managerIndex`), else the **rsm column
  beside their own handsets** on the stock lists (matched by `nameKey`, so the sheet's spelling
  does not matter; two RSMs named equally often is no answer). If neither answers, an
  agent-to-agent send is **refused and says so** — set their RSM in the *Chaneli* column on the
  Staff pane, or route it through the RSM — because a chain-of-custody check that cannot be
  made is not a pass.

### A bulk list — many receivers in one paste

> *"we also need bulk list transfer"*

Send has a second shape: **Orodha ya wingi / Bulk list**. Paste one line per phone straight off
a spreadsheet — `IMEI`, then a tab or comma, then the **receiver's name** — and the server groups
the lines by receiver and opens **one document per person**, every one carrying your signature,
each waiting for its own receiver to accept. That is "RSM to Agents, supplying" without eight
separate sends.

It is **all or nothing**: every group is dry-run through the single-send checks first (system
user, possession, the hierarchy rule), so a wrong name on line 40 opens no documents at all and
the refusal names the lines and the people that stopped it. A serial listed under two names is
refused rather than guessed. The same model, price and note apply to every line; 500 phones per
paste.

## Paper, and the phone

> *"Sending and printing copy of sent items at transfers doesn't print the whole list, instead
> just the front page only, also add S/N column on left"*
> *"printing should allow / be able through app to b/se user may want to save the file into
> phone downloads"*

**Chapisha / Print** builds the document as a page of its own and prints that. It used to print
the drawer, which is a fixed box one screen tall with its own scrollbar, so a list of forty
serials came out as the first fifteen. The printed sheet now runs as long as the list, repeats
the column headings on every page, never splits a row across two sheets, and carries both
signatures as drawn.

**⤓ Hifadhi PDF / Save PDF** writes the same document as a PDF and hands it to `saveFile_` —
the one route every export in this system already takes: the wrapper's `HoopLoan.saveBase64`
puts it straight into the phone's **Downloads**, and an ordinary browser downloads it. A4
portrait, the reference on every sheet, `S/N` leading each row, the totals, and **both
signatures as ink**: the pads draw on a canvas, and a canvas PNG cannot go into a PDF without
re-implementing PNG's scanline filters, so each signature is re-drawn on white and embedded as
a JPEG (`/DCTDecode`). A signature that will not load is simply absent — the name and the
moment underneath it are what the register holds anyway.

**Inside the app there is no print dialog at all.** `window.print()` does nothing in that
WebView, so Chapisha there saves the PDF instead and says so. That is the whole answer to
"printing should work through the app": the officer gets the file in Downloads, to open, keep
or send.

## Signatures

The sender signs at Send, or later from their own login. **The receiver only ever signs by
accepting** — that is the write that moves the stock, so there is no separate receiver-sign
that could leave a signed document with stock still in the wrong hands. **Only the two parties
can sign, accept or decline** — the desk reads every document but signs none it is not a party
to; the desk's own documents are signed under the desk's own code. A signature is written once;
a mis-signed transfer is corrected with a fresh one.

## Who the stock names becomes a system user

> *"please from new stock write me sql so that we pull all rsm or just always pull them auto
> from new stock whenever they appear and auto insert them in access codes with autogenerated
> code ... autofill staff table by matching rsm and agents from new stock and old stock data..
> when we match rsm and agent on the same imei then thats done"*

Every stock row already says who holds the handset (`agent`) and who they answer to (`rsm`), so
those names are the list of people who can receive. Two things keep it filled:

- **The panes do it themselves.** Every time NEW STOCK or OLD STOCK opens under a code that can
  write, any RSM or agent the stock names who is not yet a system user gets **an access code**
  in the RSM or AGENT role with a freshly minted six-character secret (the team-code alphabet:
  no 0/O, no 1/I/L), and — where the row carries a phone, because the register is keyed by it —
  **a staff row** (`hoop_agents`: `Regional_Manager` / `Field_Officer`, the RSM on the same row
  as `manager`, stored as `0` + nine digits like the enrolment desk stores it). The pane says
  what it did (*"3 codes minted, 2 staff rows"*) or why it could not. It reads the **whole**
  list before the fence, so an RSM's open cannot be the only thing that minted their agents.
- **`db/migrations/RUN-ME-2026-09-18-staff-from-stock.sql`** does the same thing once, for
  everybody on the lists today, so Send can pick by role and name from the first morning.

The rules are the same in both places. **Nobody is demoted**: a name that is an RSM on one row
and an agent on another is an RSM. **Nobody is duplicated**: a name that already has a code —
in any role, the same words in any order, case or spacing (`nameKey`; `public.hoop_name_key()`
in the SQL, created by that file) — gets nothing, and a staff row that exists by phone or by
name is left alone. Two desks opening a pane in the same second cannot leave a person two codes
either: the run re-reads after minting and drops **its own** where an earlier code now exists
(never anybody else's), and a phone the other desk registered first is simply skipped, not
reported as a failure. **Nobody is deleted by the SQL**: a person who already holds two codes is
*listed* under the summary, and which login to keep is decided on the Access codes pane.
**`SUPER AGENT` is the warehouse**, not a person; blank, numeric, dashed and two-letter names
are spreadsheet noise. Codes carry no navs of their own — the RSM and AGENT roles' ticks on the
Roles card are the grant. A role with no row on that card opens on the *old default* panes, so
where **no code yet holds** RSM or AGENT the row is made to exist (with nothing ticked) before
the first code is minted; where codes already hold the role without a row, nothing is written —
`docs/ROLE-GRANT.md` promises an existing code keeps every door it had — and the pane says so
in red until the role is configured on the Roles card. A view-only code writes nothing. Before
the targets migration the register has no `manager` column; staff rows are then written without
it, and the hierarchy rule reads branch and stock instead.

The codes are live logins the moment they exist. Read them off **Access codes**, which is now
**chipped by role** with a count per chip and a search box (*"the list will be long"*): the
pane opens on the first chip so it is short, *Zote / All* is its own chip, and a search looks
across every role. Hand each code to its person; a code minted for somebody who has left is
deleted there like any other.

## The stock fence — who sees which stock

The role on the **access code** decides, by name — the same honest weakness the credit roster's
suspension matching already lives with: an access code and a stock row share nothing but a
person's name, so the name (token-sorted, case-folded) is what they are matched on. A code named
differently from the register sees an **empty** pane, never somebody else's — the fence fails
closed, and the pane says whose name it looked for.

| role on the code | OLD STOCK / NEW STOCK panes | Transfers → Stock (what you can *send*) |
|---|---|---|
| **AGENT** | own hands only | own hands only |
| **RSM** | their region: their own hands **and** the agents who report to them (by the register's `manager`, else the branch) — and, on NEW STOCK, handsets their region sold | own hands only — an agent's stock comes back up as a return first |
| **STORE** (the desk — *"sipho/store role/super agent sees all of stock"*), **ADMIN**, everyone else | everything | everything |

The drawer, the round export and the pivots on those panes are cut by the same fence, so a
count never opens a longer list.

## Not here, on purpose

- **Not the other company.** A handset moving HOOP ↔ HOPE is *Shift*, on the locking desk, and
  stays there: that is a device changing owner between two systems, not stock changing hands
  between two people in this one.
- **No re-sign, no edit after signing.** A fresh transfer, not an edit.
- **Deleting a document is not an undo.** Acceptance is the write that moves stock, and from that
  moment the handsets are in the receiver's hands on every list — their Stock window, their NEW
  STOCK, their OLD STOCK — exactly as if they had been handed over at the counter. Removing the
  row afterwards moves nothing back and takes `prev_holder` with it. Stock goes back the way it
  came: **send it**, which leaves a document saying so.
- **No link to `devices` or `hoop_aged_stock` from the items.** A transfer can carry stock that was
  never locked, so `transfer_items.imei` is plain text; each line remembers where the serial was
  found (`source`) and whose hands it was in (`prev_holder`).

Schema: `db/migrations/RUN-ME-2026-09-16-transfers.sql` (the document) then
`RUN-ME-2026-09-17-transfers-flow.sql` (status, roles, accept/decline). Until the second runs
the pane still opens and prints; Send and Receive say which file to run. The one-off backfill of
staff rows and codes from stock is `RUN-ME-2026-09-18-staff-from-stock.sql`; it is not a schema
change, and the panes keep the register filled without it from then on.

Two one-off clean-ups sit beside them, for stock that was only ever a rehearsal:
`RUN-ME-2026-09-17-delete-training-transfers.sql` removes four training documents, with the stock
restore as a step of its own that is **off until it is turned on**; and
`RUN-ME-2026-09-17-delete-test-handset.sql` takes one rehearsal serial out of every list it
reached — the register, its token, its history, the NEW STOCK stamp, the old list, the aged feed
and any transfer line — because deleting the register row alone leaves the serial on the NEW STOCK
pane, still standing in somebody's stock. Neither touches the morning uploads or the documents
raised about a handset; both name what they left alone.
