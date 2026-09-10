-- =============================================================================================
-- REMOVE ONE TRIAL HANDSET FROM EVERY BOOK IT REACHED.
-- =============================================================================================
--   "I need sql to remove all data with 351388334583295 -- it was my first trial phone that was
--    never sent to agents/sells, so it's distorting statistics everywhere."
--
-- IMEI: 351388334583295
--
-- ---------------------------------------------------------------------------------------------
-- READ THIS FIRST. IT IS THE ONLY PART THAT CAN COST YOU A HANDSET.
-- ---------------------------------------------------------------------------------------------
-- If that phone is still LOCKED, unlock it BEFORE running Part 2.
--
-- The handset does not know anything about this database. It knows its own token and it calls
-- home; what it does next is decided by the row in `devices`. Delete that row while the phone is
-- still locked and the phone keeps calling home to a row that is not there any more -- and there
-- is no longer anything in the office that can send it an unlock. Getting it back is then a
-- factory reset with the phone in your hands.
--
-- So the order is:
--     1. Portal -> Kufungua simu -> Fungua (unlock), or Achia (release) if you are done with it.
--     2. Wait for the register to show it opened -- the phone confirms on its next beat.
--     3. THEN run Part 2 below.
--
-- Part 1 tells you whether this applies. If the phone reads `enrolled` or `released` it is not
-- locked and you can go straight on.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS TOUCHES, AND WHAT IT DELIBERATELY DOES NOT.
-- ---------------------------------------------------------------------------------------------
-- Deleted: every row that makes this phone count as stock, as a sale, as a customer or as a
-- device -- which is the whole of "distorting statistics".
--
-- NOT deleted: `audit_log`. That is the record of what PEOPLE did -- who enrolled it, who locked
-- it, who released it -- and no report counts it as a sale or as stock, so it distorts nothing.
-- Deleting it would not clean a number; it would erase the history of your own trial. The last
-- statement in this file will remove those rows too if you decide you want them gone, and it is
-- commented out precisely so that is a decision rather than a side effect.
--
-- NOT deleted automatically: any OTHER device row whose `reported_imei` is this number. That
-- would mean a different handset in the register is reporting this IMEI -- worth knowing about,
-- never worth deleting blindly. Part 1 shows you if there are any.
--
-- ONE MORE THING, if you ever re-use this handset: this removes its remembered token as well, so
-- enrolling it again mints a NEW one. The phone in your hand would still be carrying the old
-- token and would be refused. FACTORY RESET IT FIRST, then enrol it fresh.
--
-- Safe to run more than once: the second run finds nothing and says so.
-- =============================================================================================


-- =============================================================================================
-- PART 1 -- THE SURVEY. Run this on its own first and read it.
-- Highlight from here to the "END OF PART 1" line and press Run.
-- =============================================================================================
select 'devices (state matters -- see the warning above)' as book,
       coalesce((select state from devices where imei = '351388334583295'), '(not in the register)') as detail,
       (select count(*) from devices where imei = '351388334583295') as rows
union all select 'device_events', '', (select count(*) from device_events where imei = '351388334583295')
union all select 'device_tokens', '', (select count(*) from device_tokens where imei = '351388334583295')
union all select 'watu_loans (the deck)', '', (select count(*) from watu_loans where imei = '351388334583295')
union all select 'watu_snapshots', '', (select count(*) from watu_snapshots where imei = '351388334583295')
union all select 'hoop_sales (shop book)', '', (select count(*) from hoop_sales where imei = '351388334583295')
union all select 'hoop_aged_stock', '', (select count(*) from hoop_aged_stock where serial = '351388334583295')
union all select 'followup_status (call book)', '', (select count(*) from followup_status where imei = '351388334583295')
union all select 'followup_comments', '', (select count(*) from followup_comments where imei = '351388334583295')
union all select 'OTHER devices reporting this IMEI (not deleted)', '',
       (select count(*) from devices where reported_imei = '351388334583295' and imei <> '351388334583295')
union all select 'audit_log (kept on purpose)', '', (select count(*) from audit_log where subject = '351388334583295')
order by 1;
-- ==================================== END OF PART 1 ==========================================


-- =============================================================================================
-- PART 2 -- THE REMOVAL. Run this after Part 1, and after the phone is unlocked.
--
-- It is one transaction: either every book loses the row or none of them does. Tables whose
-- migration you have not run yet are SKIPPED rather than failing the whole thing -- this
-- database is built by hand and half of it may not exist on any given day, and a delete that
-- aborts on the fourth table having done three is the worst possible outcome.
--
-- Watch the NOTICES panel: it prints one line per book it touched.
-- =============================================================================================
do $$
declare
  trial constant text := '351388334583295';
  t     record;
  n     bigint;
  total bigint := 0;
  st    text;
begin
  /* THE GUARD RUNS BEFORE ANYTHING IS DELETED, and the order is the whole of it. Asked after
     the loop it would be reading a row this block had just removed, so it would always find
     nothing and always pass -- a check that cannot fail is not a check.

     A locked handset whose register row is gone is a phone nobody can open from the office
     again: it keeps calling home to a row that is not there, and the way back is a factory
     reset with the phone in your hands. */
  if to_regclass('public.devices') is not null then
    select state into st from devices where imei = trial;
    if st in ('locked', 'lost') then
      raise exception
        'STOPPED, and nothing was deleted: % is still "%" in the register. Open it first (Portal -> Kufungua simu -> Fungua), wait for the phone to confirm on its next beat, then run this again. Deleting it while locked would leave a phone nobody can unlock.',
        trial, st;
    end if;
  end if;

  for t in
    select * from (values
      -- The device registry and everything hanging off it.
      ('devices',              'imei',    'the phone register'),
      ('device_events',        'imei',    'its lock/unlock history'),
      ('device_tokens',        'imei',    'the remembered enrol token'),
      -- The books that feed the sales and stock numbers.
      ('watu_loans',           'imei',    'the Watu deck'),
      ('watu_snapshots',       'imei',    'the daily deck snapshots'),
      ('hoop_sales',           'imei',    'the shop sales book'),
      ('hoop_aged_stock',      'serial',  'the aged-stock report'),
      ('stock_audit',          'imei',    'NEW STOCK'),
      ('stock_handover_items', 'imei',    'stock handovers'),
      -- The desks that can hold one handset.
      ('topups',               'imei',    'top-up requests'),
      ('loss_cases',           'imei',    'loss and damage cases'),
      -- The call book. followup_comments cascade from followup_status, but a stray comment
      -- with no parent is deleted by name too rather than left behind.
      ('followup_comments',    'imei',    'call comments'),
      ('followup_status',      'imei',    'the call book')
    ) as x(tbl, col, what)
  loop
    if to_regclass('public.' || t.tbl) is null then
      raise notice 'SKIPPED %  (%) -- that table does not exist yet', t.tbl, t.what;
      continue;
    end if;
    execute format('delete from public.%I where %I = $1', t.tbl, t.col) using trial;
    get diagnostics n = row_count;
    total := total + n;
    if n > 0 then
      raise notice 'removed % row(s) from %  (%)', n, t.tbl, t.what;
    end if;
  end loop;

  /* ISSUES ARE SCOPED, not matched on the text alone. `subject` holds an IMEI, a receipt number
     or a free-typed note depending on `subject_type`, so deleting every row whose subject looks
     like this number could take out a genuine complaint that merely mentions it. Only rows
     filed ABOUT this device go. */
  if to_regclass('public.issues') is not null then
    delete from issues where subject_type = 'imei' and subject = trial;
    get diagnostics n = row_count;
    total := total + n;
    if n > 0 then raise notice 'removed % issue(s) filed about this handset', n; end if;
  end if;

  if total = 0 then
    raise notice 'Nothing found. Either it is already gone, or the IMEI is not spelt the way it is stored.';
  else
    raise notice '-----------------------------------------------';
    raise notice 'TOTAL rows removed for %: %', trial, total;
  end if;

end $$;
-- ==================================== END OF PART 2 ==========================================


-- =============================================================================================
-- OPTIONAL -- the audit trail. Left commented out on purpose.
--
-- These rows say who enrolled, locked and released the trial phone. They are not counted by any
-- report, so they distort nothing; deleting them removes the record of your own actions rather
-- than a number. Uncomment only if you actively want that history gone.
-- =============================================================================================
-- delete from audit_log where subject = '351388334583295';
