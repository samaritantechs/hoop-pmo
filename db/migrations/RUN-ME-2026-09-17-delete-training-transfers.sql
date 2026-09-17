-- =============================================================================================
-- THE FOUR TRAINING TRANSFERS, REMOVED -- and the stock they moved, put back if you want it.
-- =============================================================================================
--   "i need to delete these transfers reference from database since they were for training
--    purposes ... i only have TR-20260917-MU5JB6M814P thats the valid one"
--
-- THREE OF THE FOUR WERE ACCEPTED, AND AN ACCEPTANCE MOVES STOCK. That is the whole point of
-- the button: the holder on every handset in the document is overwritten to the receiver
-- (devices.holder, or old_stock.agent and the rsm beside it), and a device_events line is
-- written for each one. Deleting the document does NOT undo any of that. Delete these four and
-- say nothing else, and five handsets stay filed under people who never received them, with
-- nothing left on the system to say why -- which is worse than the training rows themselves.
--
-- So this file is in FIVE STEPS, and the first one only looks:
--
--   STEP 1  shows the four documents, every serial on them, where that serial sits TODAY and
--           where it sat before the training document moved it. Read it before you run
--           anything else. Nothing is changed.
--   STEP 2  puts the stock back -- ONLY where the handset is still sitting exactly where the
--           training document put it. A phone that has moved on since is left alone and
--           listed, because a later, real hand-off must not be undone by this. It is OFF until
--           you turn it on: change `restore_stock := false` to `true` in the block.
--   STEP 3  removes the device_events lines those four documents wrote (they name their ref).
--   STEP 4  deletes the four documents. transfer_items has `on delete cascade`, so the serial
--           lines go with them.
--   STEP 5  shows what is left, which should be TR-20260917-MU5JB6M814P and nothing else.
--
-- WHAT THIS CANNOT PUT BACK, said plainly: on an OLD STOCK row the acceptance also rewrote the
-- `rsm` column beside the holder, and the previous value is recorded nowhere -- transfer_items
-- remembers the holder a serial left (prev_holder) and not their RSM. Step 2 restores the
-- holder and LISTS every old-stock row it touched so the RSM can be set on the stock sheet.
--
-- The four references are written out in each statement rather than kept in a scratch table:
-- the Supabase SQL editor does not promise that two statements of a script run on the same
-- connection, so a temporary table made by one can be gone by the next. Four short lists are a
-- smaller price than a script that dies halfway.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- STEP 1. LOOK FIRST. Nothing here changes anything.
-- ---------------------------------------------------------------------------------------------
select t.ref,
       t.status,
       t.from_name                                as kutoka,
       t.to_name                                  as kwenda,
       ti.imei,
       ti.prev_holder                             as ilikuwa_kwa,
       coalesce(d.holder, os.agent)               as iko_kwa_sasa,
       case when d.imei is not null then 'devices'
            when os.imei is not null then 'old_stock'
            else 'haipo / not on either list' end as orodha,
       case when t.status <> 'accepted'           then 'haikuhamisha kitu / moved nothing'
            when ti.prev_holder is null           then 'hakuna pa kurudisha / nowhere recorded to put it back'
            when coalesce(d.holder, os.agent) is not distinct from ti.prev_holder
                                                  then 'tayari iko pale ilipotoka / already back where it was'
            when coalesce(d.holder, os.agent) in (t.to_name, 'SUPER AGENT')
                                                  then 'STEP 2 itairudisha / STEP 2 will put this back'
            else 'imehama tena tangu hapo — STEP 2 haitaigusa / moved on since: STEP 2 leaves it alone'
       end                                        as step_2
  from transfers t
  left join transfer_items ti on ti.transfer_id = t.id
  left join devices     d  on d.imei  = ti.imei
  left join old_stock   os on os.imei = ti.imei
 where t.ref in ('TR-20260916-MU442T99NLS','TR-20260916-MU43TM00C6E',
                 'TR-20260916-MU3RKUSSTKV','TR-20260912-MTY6G96MHEH')
 order by t.created_at, ti.imei;


-- ---------------------------------------------------------------------------------------------
-- STEP 2. PUT THE STOCK BACK. Off by default -- read STEP 1 first, then set this to true.
--         Only a handset still sitting where the training document left it is moved.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  restore_stock boolean := false;        -- <<< change to true to put the stock back
  refs          text[]  := array['TR-20260916-MU442T99NLS','TR-20260916-MU43TM00C6E',
                                 'TR-20260916-MU3RKUSSTKV','TR-20260912-MTY6G96MHEH'];
  n_dev    integer := 0;
  n_old    integer := 0;
  n_moved  integer := 0;
  old_list text;
begin
  if not restore_stock then
    raise notice 'STEP 2 skipped: restore_stock is false, so no stock was moved. The documents '
                 'can still be deleted by STEPS 3-4; the handsets then stay where the training '
                 'documents put them.';
    return;
  end if;

  -- The register: the holder goes back to the name the document says it left.
  with mine as (
    select ti.imei, ti.prev_holder, t.to_name
      from transfers t join transfer_items ti on ti.transfer_id = t.id
     where t.ref = any(refs) and t.status = 'accepted' and ti.prev_holder is not null
  )
  update devices d
     set holder = m.prev_holder, updated_at = now()
    from mine m
   where d.imei = m.imei
     and d.holder in (m.to_name, 'SUPER AGENT')      -- still where the training put it
     and d.holder is distinct from m.prev_holder;
  get diagnostics n_dev = row_count;

  -- The old-stock list: the same, and the rsm beside it is NOT restored -- see the header.
  with mine as (
    select ti.imei, ti.prev_holder, t.to_name
      from transfers t join transfer_items ti on ti.transfer_id = t.id
     where t.ref = any(refs) and t.status = 'accepted' and ti.prev_holder is not null
  )
  update old_stock os
     set agent = m.prev_holder, updated_at = now()
    from mine m
   where os.imei = m.imei
     and os.agent in (m.to_name, 'SUPER AGENT')
     and os.agent is distinct from m.prev_holder;
  get diagnostics n_old = row_count;

  -- Which old-stock rows now need their RSM set by hand, and which phones were left alone.
  select string_agg(ti.imei, ', ') into old_list
    from transfers t join transfer_items ti on ti.transfer_id = t.id
    join old_stock os on os.imei = ti.imei
   where t.ref = any(refs) and t.status = 'accepted';

  select count(*) into n_moved
    from transfers t join transfer_items ti on ti.transfer_id = t.id
    left join devices d on d.imei = ti.imei
    left join old_stock os on os.imei = ti.imei
   where t.ref = any(refs) and t.status = 'accepted' and ti.prev_holder is not null
     and coalesce(d.holder, os.agent) is distinct from ti.prev_holder;

  raise notice 'STEP 2: register rows put back: %  ·  old-stock rows put back: %', n_dev, n_old;
  if old_list is not null then
    raise notice 'STEP 2: these old-stock serials had their RSM overwritten by the training '
                 'acceptance and it is recorded nowhere -- set it on the stock sheet: %', old_list;
  end if;
  if n_moved > 0 then
    raise notice 'STEP 2: % serial(s) were NOT put back -- they have moved on since the training '
                 'document, so a later hand-off would have been undone. STEP 1 names them.', n_moved;
  end if;
end $$;


-- ---------------------------------------------------------------------------------------------
-- STEP 3. The history lines those four documents wrote. Each one names its own reference.
-- ---------------------------------------------------------------------------------------------
delete from device_events
 where event = 'transfer'
   and (reason like '%TR-20260916-MU442T99NLS%' or reason like '%TR-20260916-MU43TM00C6E%'
     or reason like '%TR-20260916-MU3RKUSSTKV%' or reason like '%TR-20260912-MTY6G96MHEH%');


-- ---------------------------------------------------------------------------------------------
-- STEP 4. The documents themselves. transfer_items goes with them (on delete cascade).
-- ---------------------------------------------------------------------------------------------
delete from transfers
 where ref in ('TR-20260916-MU442T99NLS','TR-20260916-MU43TM00C6E',
               'TR-20260916-MU3RKUSSTKV','TR-20260912-MTY6G96MHEH');


-- ---------------------------------------------------------------------------------------------
-- STEP 5. What is left. One row -- TR-20260917-MU5JB6M814P -- is the right answer.
-- ---------------------------------------------------------------------------------------------
select ref, created_at, from_name, to_name, item_count, status
  from transfers
 order by created_at desc;
