-- =============================================================================================
-- FOUR NAMES THE SEPTEMBER SPREADSHEET DAMAGED, PUT BACK.
-- =============================================================================================
--   "ohh i destroyed them in my latest excel, please sql to ammend
--    RAMADHANI RAMADHANI NGAGA and Ramadhan RAMADHANI NGAGA the 1st name is correct
--    Salum Tindwa is SALUMU TINDWA
--    Ester MasANORD SAWE is ESTER MASSAWE
--    PATRICK ANORD SAWE is PATRICK SAWE"
--
-- TWO KINDS OF DAMAGE, and they cost different things.
-- ---------------------------------------------------------------------------------------------
-- A SPLICE. "Ester MasANORD SAWE" is "Ester Mas" with the RSM's name run into it, and "PATRICK
-- ANORD SAWE" is the same accident on a different row. These people have phones and staff rows,
-- so the wrong name is on the register as well as on their stock -- it is what the office reads
-- when it rings them.
--
-- A SPLIT. "Ramadhan RAMADHANI NGAGA" and "Salum Tindwa" are second spellings of people who are
-- ALREADY in the register under their right names. That is worse than a typo: the ground-visit
-- board counted them as two holders each, so somebody would have been asked for twice, and both
-- halves sat in the no-location list because the misspelt half matches nothing anywhere.
--
-- AND IT MEANS TWO OF THE "FIVE PHONELESS AGENTS" NEVER EXISTED. Salum Tindwa is SALUMU TINDWA
-- (0610047414) and Ramadhan RAMADHANI NGAGA is the RSM RAMADHANI RAMADHANI NGAGA (0673269952) --
-- both already on the register. Three people are still waiting on numbers, not five.
--
-- The merged rows take the right person's phone, because a round is planned by ringing somebody
-- and a holder with no number is a visit nobody can arrange.
--
-- Safe to run more than once: every match is on the damaged spelling, which stops existing the
-- moment this runs.
-- =============================================================================================

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. THE STAFF REGISTER. Keyed by phone, so there is no doubt which row is meant and no chance
--    of colliding with somebody else's name.
-- ---------------------------------------------------------------------------------------------
update hoop_agents set name = 'ESTER MASSAWE' where phone = '0748776344';
update hoop_agents set name = 'PATRICK SAWE'  where phone = '0766761523';

-- ---------------------------------------------------------------------------------------------
-- 2. THE STOCK. Matched on upper(trim(...)) so a stray capital or a trailing space cannot leave
--    a row behind -- one row left behind is one more holder on the board than there are people.
-- ---------------------------------------------------------------------------------------------
update old_stock set agent = 'ESTER MASSAWE'
 where upper(trim(agent)) = 'ESTER MASANORD SAWE';

update old_stock set agent = 'PATRICK SAWE'
 where upper(trim(agent)) = 'PATRICK ANORD SAWE';

-- The two merges. coalesce, never a plain assignment: if a row already carries a number it is
-- the row's own fact and this is not the place to overwrite one.
update old_stock
   set agent = 'RAMADHANI RAMADHANI NGAGA',
       agent_phone = coalesce(agent_phone, '0673269952')
 where upper(trim(agent)) = 'RAMADHAN RAMADHANI NGAGA';

update old_stock
   set agent = 'SALUMU TINDWA',
       agent_phone = coalesce(agent_phone, '0610047414')
 where upper(trim(agent)) = 'SALUM TINDWA';

-- The same splice can sit in the RSM column, and an RSM spelt two ways splits their whole round.
update old_stock set rsm = 'RAMADHANI RAMADHANI NGAGA'
 where upper(trim(rsm)) = 'RAMADHAN RAMADHANI NGAGA';

-- ---------------------------------------------------------------------------------------------
-- 3. THE SALE AUDIT, if any of these four ever sold. None of them had sales when this was
--    written -- that is why they had no location to derive -- but a name is a name wherever it
--    is stamped, and a correction that stops at one table leaves the panes disagreeing.
-- ---------------------------------------------------------------------------------------------
update stock_audit set agent = 'ESTER MASSAWE' where upper(trim(agent)) = 'ESTER MASANORD SAWE';
update stock_audit set agent = 'PATRICK SAWE'  where upper(trim(agent)) = 'PATRICK ANORD SAWE';
update stock_audit set agent = 'RAMADHANI RAMADHANI NGAGA'
 where upper(trim(agent)) = 'RAMADHAN RAMADHANI NGAGA';
update stock_audit set agent = 'SALUMU TINDWA' where upper(trim(agent)) = 'SALUM TINDWA';
update stock_audit set rsm = 'RAMADHANI RAMADHANI NGAGA'
 where upper(trim(rsm)) = 'RAMADHAN RAMADHANI NGAGA';

commit;

-- =============================================================================================
-- DID IT LAND? Every count should be 0.
-- =============================================================================================
select 'old_stock.agent'  as where_, count(*) from old_stock
  where upper(trim(agent)) in ('ESTER MASANORD SAWE', 'PATRICK ANORD SAWE',
                               'RAMADHAN RAMADHANI NGAGA', 'SALUM TINDWA')
union all
select 'old_stock.rsm', count(*) from old_stock
  where upper(trim(rsm)) = 'RAMADHAN RAMADHANI NGAGA'
union all
select 'hoop_agents.name', count(*) from hoop_agents
  where upper(trim(name)) in ('ESTER MASANORD SAWE', 'PATRICK ANORD SAWE');

-- AND THE FOUR PEOPLE, WHOLE. Each should appear ONCE, with a phone.
-- select agent, agent_phone, count(*) as pieces
--   from old_stock
--  where upper(trim(agent)) in ('ESTER MASSAWE', 'PATRICK SAWE',
--                               'RAMADHANI RAMADHANI NGAGA', 'SALUMU TINDWA')
--  group by 1, 2 order by 1;
--
-- Then open OLD STOCK once: the merged holders will take a location if one can now be worked
-- out for them, and the "Hazijulikani zilipo" chip will be two rows shorter.
