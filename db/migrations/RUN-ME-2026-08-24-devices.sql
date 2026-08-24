-- =====================================================================================
-- THE DEVICE REGISTRY -- one row per phone we have taken control of, keyed by IMEI.
-- =====================================================================================
--   "the stock is too large and hoop agents are stealing stock ... lets solve by
--    building an app to install in those phones"
--
-- WHAT THIS IS, AND WHAT IT IS NOT. This is the SERVER half: who is enrolled, what state
-- each phone is meant to be in, and when it last spoke to us. The phone half (an Android
-- Device Owner app that actually draws the lock screen) is a separate build; nothing here
-- assumes it exists yet, so the registry can be filled and read while that app is still
-- being written -- and every screen it feeds degrades to "no devices yet" until then.
--
-- THE IMEI IS THE KEY, deliberately, because it is the one identifier already shared by
-- every book this system holds: Sipho's stock report (serial), the Watu register (imei),
-- the sales book (imei), and the officers' daily deck. A device row therefore joins to
-- everything we already know about that phone with no new plumbing -- which is the whole
-- reason the accountability report can turn an unaccounted IMEI into a lock command.
--
-- Safe to re-run.

create table if not exists devices (
  imei text primary key,

  -- WHERE IT CAME FROM. Stamped at enrolment so a phone can always be traced back to the
  -- report it was standing in when we took it: which stock report, which holder.
  enrolled_at   timestamptz not null default now(),
  enrolled_by   text,                    -- the signed-in code that provisioned it
  enrol_batch   uuid,                    -- one uuid per enrolment session at the station
  item          text,                    -- model, copied from the stock report
  holder        text,                    -- who held it in stock the day it was enrolled

  -- WHAT STATE IT IS MEANT TO BE IN. `state` is the INTENT held by the office; `reported`
  -- is what the phone last said about itself. They are two different facts on purpose --
  -- a phone told to lock that has not checked in yet is neither "locked" nor a failure,
  -- it is PENDING, and a report that blurs those two cannot be trusted to chase anything.
  state         text not null default 'enrolled'
                  check (state in ('enrolled', 'locked', 'released', 'lost')),
  state_reason  text,
  state_by      text,
  state_at      timestamptz,

  reported      text,                    -- 'locked' | 'unlocked' -- the phone's own word
  last_seen     timestamptz,             -- last heartbeat; null = never spoke
  app_version   text,
  battery       integer,
  android       text,

  -- THE SALE THIS PHONE BELONGS TO, once it has one. Null while it is still stock.
  sold_ref      text,                    -- the sale key / receipt it went out on
  customer      text,
  released_at   timestamptz,             -- when the loan was cleared and it was set free

  updated_at    timestamptz not null default now()
);
create index if not exists idx_devices_state     on devices(state);
create index if not exists idx_devices_last_seen on devices(last_seen);
create index if not exists idx_devices_holder    on devices(holder);

-- THE HANDSET'S CREDENTIAL. A phone in a customer's hand has no access code and never will,
-- so enrolment mints one random token per device; it is placed in that one phone at
-- provisioning and authorises exactly one IMEI against /api/device. Added separately so
-- this file stays safe to re-run over a registry that was created before the phone half
-- existed. It is a secret: never select it onto a screen or an export.
alter table devices add column if not exists enrol_token text;

-- EVERY STATE CHANGE, KEPT. A lock is an act against somebody's phone; who ordered it and
-- why must survive the next change of state, so the registry above holds only the CURRENT
-- state and this holds the history. Append-only, never updated.
create table if not exists device_events (
  id         uuid primary key default gen_random_uuid(),
  imei       text not null,
  event      text not null,              -- enrolled | lock | unlock | release | heartbeat | lost
  from_state text,
  to_state   text,
  reason     text,
  actor      text,
  at         timestamptz not null default now()
);
create index if not exists idx_device_events_imei on device_events(imei, at desc);

-- DID IT LAND?
-- select count(*) from devices;
-- select event, count(*) from device_events group by event;
