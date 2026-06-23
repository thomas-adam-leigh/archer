/**
* ARC-134 — persist explicit ordering for the profile spine lists.
*
* The spine list tables had no order column, so readProfileSpine re-sorted by date
* (then created_at). A review "reorder my courses and certifications" instruction
* therefore could not survive a read-back. Add a nullable `position` (int) the writer
* sets from the draft array order; readProfileSpine orders by it first and falls back
* to the existing date ordering for legacy rows (position is NULL). Skills are an
* unordered set, so they keep date/created_at ordering and gain no position column.
*/

alter table public.work_experiences add column position int;
alter table public.education add column position int;
alter table public.certifications add column position int;
alter table public.courses add column position int;
alter table public.projects add column position int;
