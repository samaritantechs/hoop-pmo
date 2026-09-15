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
| **Tuma / Send** | — | who receives (a **system user**, found by name), the serials (ticked or pasted), one model and unit price for the batch, a note, **my signature** |
| **Pokea / Receive** | waiting for me · sent by me · settled | open a waiting document, **sign to accept** — or **decline** with a reason |
| **Nyaraka / Documents** | mine; the desk: every document | the printable register, filtered by status |

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

- **You send what is in your hands.** A sender who is not the desk can only send stock in their
  own possession — the same list their Stock window shows. Anything else is refused by IMEI.
- **The desk sends for anybody.** STORE (and ADMIN) may name who is handing over, send serials
  the system has never heard of (they go on the document as *unknown*, with nothing to
  overwrite), and sign a slot in the party's name at the counter.
- **The receiver must be a system user** — an access code carrying the RSM, AGENT, STORE or
  ADMIN role — because it is their login that accepts. A name without a code is refused with
  those words: *add them at Access codes* is the fix.
- **The hierarchy rule stands.** Every pairing is a normal hand-off — store ↔ RSM, RSM ↔ RSM,
  agent ↔ agent under the same RSM, agent ↔ super agent — *except* two field agents who report
  to two different RSMs, whoever is at the keyboard. Resolved off the staff register and the
  same manager-derivation the sales-targets roll-up uses (`managerIndex`).

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

## Signatures

The sender signs at Send, or later from their own login (the desk may sign in the sender's
name at the counter). **The receiver only ever signs by accepting** — that is the write that
moves the stock, so there is no separate receiver-sign that could leave a signed document with
stock still in the wrong hands. A signature is written once; a mis-signed transfer is corrected
with a fresh one.

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
| **STORE**, **ADMIN**, everyone else | everything | everything |

The drawer, the round export and the pivots on those panes are cut by the same fence, so a
count never opens a longer list.

## Not here, on purpose

- **Not the other company.** A handset moving HOOP ↔ HOPE is *Shift*, on the locking desk, and
  stays there: that is a device changing owner between two systems, not stock changing hands
  between two people in this one.
- **No re-sign, no edit after signing.** A fresh transfer, not an edit.
- **No link to `devices` or `hoop_aged_stock` from the items.** A transfer can carry stock that was
  never locked, so `transfer_items.imei` is plain text; each line remembers where the serial was
  found (`source`) and whose hands it was in (`prev_holder`).

Schema: `db/migrations/RUN-ME-2026-09-16-transfers.sql` (the document) then
`RUN-ME-2026-09-17-transfers-flow.sql` (status, roles, accept/decline). Until the second runs
the pane still opens and prints; Send and Receive say which file to run.
