-- =============================================================================================
-- RSM TO RSM, FILED BY SIPHO -- THREE SIGNATURES, NOT TWO.
-- =============================================================================================
--   "sipho wants to transfer stock from RSM to RSM then the 2 rsm must sign approval and this
--    is to be applicable with the 3 signatories"
--
-- Until now, a transfer's "from" was always the account that opened it -- "sender must be
-- current account settings" -- so an RSM-to-RSM hand-off could only be opened by the SOURCE
-- RSM logging in and sending it themselves (flow 5: "Sipho does it on system, they log in to
-- sign"). That already gives two signatures -- the source RSM as sender, the destination RSM
-- accepting -- but it means Sipho cannot FILE the document on the desk's own login; somebody
-- has to hand the source RSM's code to the keyboard.
--
-- This lets the desk (STORE or ADMIN) open a transfer BETWEEN TWO NAMED RSMs -- neither of
-- them the one signed in -- and adds the desk's own signature as a THIRD, mandatory party.
-- Because the desk is not the one actually holding the stock, the move waits for ALL THREE:
-- the desk (signed at filing, it is their document), the source RSM (approving that their
-- stock is leaving -- transferSign, exactly the "sign later" mechanism a normal sender
-- already had), and the destination RSM (accepting, same as any other transfer). Any order;
-- whichever of the two RSMs signs SECOND is the write that actually moves the stock. Any of
-- the three may decline instead, and nothing moves.
--
-- An ordinary two-party transfer (the sender IS the signed-in account, as it always was) is
-- completely unaffected: three_way stays false, desk_signature stays null, and the receiver's
-- acceptance alone still moves the stock exactly as it does today.
--
-- RUN db/migrations/RUN-ME-2026-09-16-transfers.sql AND RUN-ME-2026-09-17-transfers-flow.sql
-- FIRST. Safe to re-run: every statement is `add column if not exists`.
-- =============================================================================================

alter table transfers add column if not exists three_way      boolean not null default false;
alter table transfers add column if not exists desk_signature text;
alter table transfers add column if not exists desk_signed_by text;
alter table transfers add column if not exists desk_signed_at timestamptz;

comment on column transfers.three_way is
  'True only for a transfer the desk (STORE/ADMIN) filed BETWEEN TWO NAMED RSMs, neither of '
  'whom was signed in to open it. Ordinary transfers -- the sender IS the signed-in account -- '
  'are false, and nothing about them changes: the receiver''s acceptance alone still moves the '
  'stock. A three-way document additionally waits for the SOURCE RSM''s own signature '
  '(from_name, via the same transferSign a normal sender uses to sign after the fact) before '
  'either the receiver''s acceptance or the source RSM''s own approval -- whichever lands '
  'second -- is the write that moves it.';
comment on column transfers.desk_signature is
  'The filing desk''s own signature -- the third party on a three_way document. Captured at '
  'creation (the desk is filing it, so this one is not deferrable the way a normal sender''s '
  'can be). Null on every ordinary transfer.';

-- DID IT LAND?
-- select ref, from_name, to_name, three_way, desk_signed_by, sender_signed_by, receiver_signed_by, status
--   from transfers where three_way = true order by created_at desc;
