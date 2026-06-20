/**
* ARCHER REALTIME FAN-OUT — publish the AG-UI event log over Supabase Realtime.
*
* The events table is the append-only source of truth for every run (see
* 20260620090000_archer_interaction.sql). Adding it to the supabase_realtime
* publication makes each inserted event fan out to subscribed clients as a
* Postgres Changes message. Realtime authorizes every subscriber against the
* table's RLS, so a client receives ONLY events on threads it owns
* ((select auth.uid()) = threads.user_id) — per-user isolation, a second user
* sees nothing, with no extra plumbing beyond the policy already in place.
*
* Clients subscribe per thread:
*   supabase.channel('thread:<id>').on('postgres_changes',
*     { event: 'INSERT', schema: 'public', table: 'events',
*       filter: 'thread_id=eq.<id>' }, handler)
*
* The supabase_realtime publication exists on every Supabase project; the guard
* lets this same migration apply against the ephemeral type-gen Postgres
* (packages/db/scripts/gen-types.sh), which has no such publication.
*/
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

alter publication supabase_realtime add table public.events;
