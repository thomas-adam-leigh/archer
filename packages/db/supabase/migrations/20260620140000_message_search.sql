/**
* ARCHER MESSAGE SEARCH — make the tier-2 message corpus searchable.
*
* The messages table (20260620090000_archer_interaction.sql) is the deep,
* append-many record of every conversation turn — the "tier-2" memory the Scribe
* later reads for cover-letter depth (tier-1 is the distilled profile, produced
* in Candidate Profile & Onboarding). This migration adds the retrieval surface:
* full-text search now, embeddings-ready later.
*
* A GIN index over to_tsvector('english', content) makes
* `to_tsvector(...) @@ websearch_to_tsquery(...)` an index scan. We index the
* expression directly (rather than a stored generated column) so the change is
* purely additive — no table rewrite, no new column, no type drift — while the
* index expression stays in lockstep with the searchMessages() query helper.
*
* Search inherits the table's existing RLS ("own rows only" via the owning
* thread), so a client can only ever search its own corpus; the service-role
* query helper scopes the same way through an explicit user_id join.
*/

create index messages_content_fts_idx on public.messages
  using gin (to_tsvector('english', coalesce(content, '')));
