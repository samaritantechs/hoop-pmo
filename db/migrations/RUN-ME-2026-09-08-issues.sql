-- =============================================================================================
-- ISSUES: one log for everything somebody has to chase, routed to a department.
-- =============================================================================================
--   RSM SOP C.1  "Log every issue raised by an agent or team leader using the designated
--                 complaint link/tool, which routes the issue to the appropriate department"
--   CSM SOP C    "Serve as the final point of escalation for issues raised by RSMs"
--   IT SOP C     "Report technical issues promptly and log them with the WATU support system and
--                 Samsung shop ... Register the log book of the resolved matter"
--   GD SOP B     "Maintain a log of all pending tasks, documents, and system entries ... Record
--                 the resolution and closing date"
--   Credit SOP C "Register the complaint on the complaints form ... refer the matter to the WATU
--                 Credit Department where applicable ... Escalate complex or unresolved
--                 complaints to the General Manager"
--
-- Four SOPs, one table. They are the same shape -- somebody raises a thing, a department works
-- it, it is resolved or escalated -- and four tables would be four panes nobody opens. A
-- customer's complaint is an issue whose subject is an IMEI and whose kind is "complaint"; a
-- missing receipt is an issue whose subject is a receipt number; a Samsung repair is an issue
-- with an external reference. The department is a LABEL on the row, not a permission: the
-- owner's rule since 2026-09-07 is one queue nav for whoever works issues, with a department
-- filter, never one nav per department.
--
-- Same rules as every request table here: the raiser is STAMPED from the access code, never
-- joined; status is the state; the people who touched it are stamped beside it. The notes are
-- their own rows so a long conversation never widens the row every list selects.
--
-- Safe to run more than once.
-- =============================================================================================

create table if not exists issues (
  id              uuid primary key default gen_random_uuid(),
  raised_at       timestamptz not null default now(),

  -- WHO RAISED IT, as their access code said at the time.
  staff_code      text,
  staff_name      text not null,
  staff_role      text,

  -- WHERE IT GOES. A label the desk filters on; ADMIN and the CEO are labels too, for the
  -- things only they decide.
  department      text not null
                    check (department in ('STORE', 'FINANCE', 'IT', 'HR', 'CREDIT', 'SALES',
                                          'GENERAL_DUTY', 'ADMIN')),
  -- WHAT SORT OF THING. A complaint is a customer's; a document is a receipt or paper somebody
  -- owes; performance is an RSM's note on an agent (RSM SOP B.5 "document the actions taken").
  kind            text not null default 'issue'
                    check (kind in ('issue', 'complaint', 'document', 'performance', 'system')),
  -- WHAT IT IS ABOUT. subject_type says how to read subject: an IMEI opens the customer, an
  -- agent name opens the register, a receipt number opens the sale.
  subject_type    text check (subject_type in ('imei', 'agent', 'receipt', 'system', 'other')),
  subject         text,
  title           text not null,
  details         text,
  -- A complainant's phone, or the person to call back.
  contact         text,
  -- Credit SOP C.2: identity verified before the complaint is worked. A tick by the desk.
  verified        boolean not null default false,
  -- Where it was sent on, and their reference: WATU (Credit SOP C.4), SAMSUNG (IT SOP C.3).
  referred_to     text,
  external_ref    text,

  status          text not null default 'open'
                    check (status in ('open', 'waiting', 'escalated', 'resolved')),
  assigned_to     text,
  resolution      text,
  escalated_by    text,
  escalated_at    timestamptz,
  resolved_by     text,
  resolved_at     timestamptz,
  updated_by      text,
  updated_at      timestamptz not null default now()
);
comment on table issues is
  'One log for everything somebody has to chase -- field issues, customer complaints, missing '
  'documents, repairs -- routed to a department by label. Raiser is STAMPED from the access '
  'code. The department is a filter on one desk nav, not a permission of its own.';

create index if not exists issues_raised_at_idx on issues (raised_at desc);
create index if not exists issues_status_idx on issues (status) where status <> 'resolved';
create index if not exists issues_department_idx on issues (department);
create index if not exists issues_subject_idx on issues (subject_type, subject);
create index if not exists issues_staff_code_idx on issues (staff_code);

-- THE CONVERSATION, one row per note, so the row every list selects stays one line.
create table if not exists issue_notes (
  id          uuid primary key default gen_random_uuid(),
  issue_id    uuid not null references issues (id) on delete cascade,
  at          timestamptz not null default now(),
  by_code     text,
  by_name     text not null,
  note        text not null,
  -- What the note changed, if anything: 'open>waiting', 'escalated', 'resolved', or null.
  change      text
);
create index if not exists issue_notes_issue_idx on issue_notes (issue_id, at);

-- WHO IS TOLD. ISSUES_EMAIL is several lines of DEPARTMENT=address,address so each department
-- hears about its own; GM_EMAIL hears about escalations. Blank means nobody, and the desk is
-- the record either way.
insert into settings (key, value) values
  ('ISSUES_EMAIL', ''),
  ('GM_EMAIL', '')
on conflict (key) do nothing;
