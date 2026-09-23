-- =============================================================================================
-- SOME SIGNATORIES ARE NOT OKAY -- SIPHO NEEDS TO BE ABLE TO SAY SO, AND HAVE IT RE-SIGNED.
-- =============================================================================================
--   "Some signatories on transfers are not okay so sipho needs a reversal button per user
--    signature so that it gets resigned on every transfer card"
--
-- Until now a signature was permanent -- "written once; a mis-signed transfer is corrected
-- with a fresh one" (docs/TRANSFERS.md). That rule stands for the two ordinary parties acting
-- on their own document: nobody may still clear their OWN signature, or anybody else's, to
-- get a second try. What this adds is narrower and different -- a DESK-ONLY correction, for
-- the case the rule never covered: a signature that should never have been recorded as it
-- was (the wrong name, a mistaken tap, somebody signing who was not the real party) rather
-- than a party who simply changed their mind.
--
-- WHAT IT DOES. transferReverseSignature (STORE/ADMIN only) clears ONE party's own
-- sender_signed_by/at/signature or receiver_signed_by/at/signature, and reopens the document
-- to status 'sent' -- whatever it had settled into (accepted, with stock already moved;
-- declined) is undone along with it, because a document is not honestly "accepted" once one
-- of the signatures that made it so is gone. If stock had already moved, it is sent back
-- exactly the way it came -- the SAME trMoveStock every ordinary acceptance uses, sender and
-- receiver swapped, never a second copy of those placement rules. The party then signs again
-- through the door they always had -- Kubali/Accept or the Send window's "sign later" -- and
-- when the document completes a second time, stock moves again, correctly.
--
-- THE DESK'S OWN SIGNATURE (a three-way document's third party) is NOT reversible by this --
-- it is captured once, at filing, and there is no existing door for the desk to sign an
-- EXISTING document again the way a sender or receiver can. Reversing it would strand the
-- document with no way to finish. Correcting a wrongly-filed three-way document still means
-- filing a fresh one.
--
-- THE REASON IS KEPT ON THE DOCUMENT, not only in audit_log -- the same idea as
-- decline_reason, visible on the card itself so a corrected signature carries its own
-- explanation. Only the LATEST reversal's role/by/at/reason live here; reversal_count says
-- how many there have been, and every one of them, past and present, is in audit_log's own
-- before/after trail (see api/_lib/audit.js's AUDIT_DIFF entry for transferReverseSignature).
--
-- RUN db/migrations/RUN-ME-2026-09-16-transfers.sql AND RUN-ME-2026-09-17-transfers-flow.sql
-- FIRST -- this adds columns to the same `transfers` table those create. Safe to re-run:
-- every statement is `add column if not exists`.
-- =============================================================================================

alter table transfers add column if not exists reversed_role   text;
alter table transfers add column if not exists reversed_by     text;
alter table transfers add column if not exists reversed_at     timestamptz;
alter table transfers add column if not exists reversal_reason text;
alter table transfers add column if not exists reversal_count  integer not null default 0;

comment on column transfers.reversed_role is
  'Which signature the LATEST reversal cleared -- ''sender'' or ''receiver''. Null on a '
  'document that has never had one. Earlier reversals, if reversal_count is more than one, '
  'are in audit_log only.';
comment on column transfers.reversal_reason is
  'Why the desk cleared that signature, kept on the document itself the same way '
  'decline_reason is -- so a corrected transfer card carries its own explanation, not only a '
  'blank signature block where a signed one used to be.';
comment on column transfers.reversal_count is
  'How many times ANY signature on this document has been reversed. A document can need more '
  'than one correction over its life (a three-way document has two reversible parties); this '
  'is the count, the four columns beside it are only ever the most recent.';

-- DID IT LAND?
-- select ref, status, reversed_role, reversed_by, reversed_at, reversal_count
--   from transfers where reversal_count > 0 order by reversed_at desc;
