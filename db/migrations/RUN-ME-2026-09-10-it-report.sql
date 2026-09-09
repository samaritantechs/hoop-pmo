-- =============================================================================================
-- THE WEEKLY IT REPORT, and the record that it was actually submitted.
-- =============================================================================================
--   IT SOP E  "Prepare and SUBMIT regular IT reports to the General Manager on SYSTEM
--              PERFORMANCE, ENROLLMENT STATUS, and TECHNICAL ISSUES RESOLVED, and ensure all
--              system activities comply with company policy and data protection regulations.
--              REPORTS ARE DUE ON A WEEKLY BASIS."
--   IT SOP C.2 "Monitor system uptime and performance across inventory, sales, and finance
--              modules, on a DAILY basis." -- the daily check the weekly report is made of.
--
-- THE REPORT ITSELF NEEDS NO TABLE. Every number in it is already somewhere: the door's log,
-- the staff register, the issues log, the daily uploads, the handsets' heartbeats. Computing
-- it is a read.
--
-- WHAT NEEDED A TABLE IS THE WORD "SUBMIT". A report that was prepared and never sent is the
-- failure this SOP exists to prevent, and "did last week's go?" cannot be answered by anything
-- that only knows how to recompute this week's numbers. So one row per submission: when, by
-- whom, to whom.
--
-- AND THE SUMMARY IS COPIED, NOT RECOMPUTED. Opening a June submission next January must show
-- what was SENT in June, not what June looks like after six months of edits, re-uploads and
-- resolved issues. The same rule the commission sheet and the loss valuation follow.
--
-- Deliberately NOT unique on the week: re-sending after fixing something is legitimate, and a
-- unique row would quietly hide that it happened twice. Every submission is its own line.
--
-- Safe to run more than once.
-- =============================================================================================

create table if not exists it_reports (
  id         uuid primary key default gen_random_uuid(),
  week_from  text not null,
  week_to    text not null,
  sent_at    timestamptz not null default now(),
  sent_by    text,
  sent_to    text,
  -- The headline numbers as they stood at the moment of sending. Text, because this is a
  -- record of what was said rather than a set of figures anything should compute from.
  summary    text
);
comment on table it_reports is
  'One row per weekly IT report actually SUBMITTED (IT SOP E). The report is computed from '
  'live data, but "was it sent" is a fact about the past and cannot be recomputed -- and the '
  'summary is copied so an old submission shows what was sent rather than what the data '
  'looks like now.';

create index if not exists it_reports_week_idx on it_reports (week_from desc, sent_at desc);

-- WHO GETS IT. SOP E says the General Manager, so GM_EMAIL is the standing answer and this key
-- only exists for an office that wants the CEO or the auditor copied in as well. Blank falls
-- back to GM_EMAIL; both blank means nobody, and the pane is still the record.
insert into settings (key, value) values
  ('IT_REPORT_EMAIL', '')
on conflict (key) do nothing;
