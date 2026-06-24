-- ARC-165 — Apply-safety: require explicit owner confirmation before an application
-- submits. The apply step is the one irreversible outside-world action, so a
-- candidacy whose cover letter is `approved` does NOT apply automatically: it sits
-- "approved, awaiting apply-confirm" until the owner explicitly confirms. This column
-- records that decision (and when it was made). Null = approved but not yet confirmed;
-- a timestamp = the owner confirmed and apply may fire.
--
-- The gate is enforced in the CLI apply orchestration (runApply) and is agnostic to
-- whether the apply automation is stubbed or real — confirmation never performs a
-- submission itself. Whether confirmation is required is governed by the
-- ARCHER_APPLY_CONFIRM_MODE config (always | first-N; default always).

alter table public.candidacies
  add column apply_confirmed_at timestamptz;

comment on column public.candidacies.apply_confirmed_at is
  'ARC-165: when the owner confirmed this approved candidacy may apply. Null = approved but awaiting apply-confirm; apply is refused until set (per ARCHER_APPLY_CONFIRM_MODE).';
