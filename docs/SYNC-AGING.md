# Aging by synchronisation — the locked phones we are not pinging

> *"Issuing of stock at stock request, by using the devices synchronization we should get a report
> of never synced by days, so sortable columns of aging stock by synchronisation for locked phones
> — here we easily trace the phones that our system is not pinging (could have been frauded /
> software booted to remove lock), so now way forward stock verification will require stock holders
> to always connect to the internet the stock they hold so that we analyze which phones are not
> syncing."*

## Two questions about the same handsets

The aging stock tracker asks **how long a phone has sat on a shelf**. This asks **how long since
it spoke to us**.

A locked handset that has stopped beating is one of three things: switched off, somewhere with no
network, or **no longer locked at all**. The third is what this exists to find, and until now
nothing in the system could distinguish it from the other two — because nothing was counting.

Both trackers now sit on one screen: **Stock reports → Ripoti ya kupiga ripoti**. That is where
the desk issuing stock already looks, which is the point at which the question matters.

## It does not accuse

A boxed phone at the station is offline for weeks by design. A region with no coverage is not a
fraud. What the report does is make the silence **visible** and attach a **name** to it, so stock
verification has something to ask about.

The words on screen are *"hazipigi ripoti"* — not reporting. The only place the word *theft*
appears is the sentence ruling it out, and a test holds it there.

## Silence is measured from two clocks, because one of them lies

A phone locked five minutes ago has not had time to confirm anything. Counting it as silent would
bury the real cases under every lock ordered that morning.

So a row is **suspect** only once the silence has outlasted the order that caused it:

```
suspect = (order is older than the alert window) AND (never spoke OR silent longer than the window)
```

`SYNC_ALERT_DAYS` is that window — **7** unless the office sets otherwise. Long enough that a
weekend, a journey and a dead charger have all had their chance; short enough that a month has
not gone by. Nonsense in the setting falls back to seven.

## What the report shows

| | |
|---|---|
| **Banner** | ordered locked, **never once spoke**, and old enough that waiting is no longer the explanation — these may not be locked at all |
| Tiles | locked total · not reporting · never spoke · 30+ days · 14–29 days · 0–2 days |
| Per holder | held, not reporting, never spoke, worst silence — because that is who verification sits down with |
| Per handset | IMEI, model, holder, state, **silence in days**, **shelf age in days**, when it last spoke, what it last said |

Every table on this page already sorts itself when you click a header, so the columns sort for
free — each cell leads with a number that means something, and a phone that has never spoken
sorts above every silence that has an end.

Filters: state (locked by default — that is the population the amendment is about), and holder.
The counts always describe the whole population, never the filtered slice.

## Who holds it

`devices.holder` is stamped **once**, at enrolment, from that day's stock report.
`hoop_aged_stock` is re-uploaded **daily** and is therefore the current answer — so the newest
`as_of` wins, and the enrolment stamp is the fallback for a phone that is not in the stock file.

## Who can read it

`stockrep`, `stockappr` or `devlock` — the tracker, the desk issuing stock against it, and the
bench that will actually chase the handset. It is a read; nothing here changes a device.

## What to do

1. Optional Settings: `SYNC_ALERT_DAYS` (blank = 7).
2. **The standing instruction to holders**: bring the stock you hold online, so it shows here.
   The report states it on the pane.

No migration — every column it reads already exists.

## Files

| file | what changed |
|---|---|
| `api/portal.js` | `SYNC_ALERT_DEFAULT`, `syncAlertDays`, `syncAging`; the `SYNC_ALERT_DAYS` setting |
| `public/portal.html` | `syncSection`/`syncWire`/`syncDays`, folded into the stock report pane |
| `test/sync-aging.test.mjs` | six tests |
