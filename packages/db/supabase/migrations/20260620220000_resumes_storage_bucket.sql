/**
* RESUMES STORAGE BUCKET — a private bucket + owner-only RLS for résumé/portfolio
* uploads (Mobile Onboarding, ARC-62).
*
* The résumé path of onboarding uploads a PDF/DOCX to Supabase Storage, then hands
* the resulting object path to POST /onboarding/resume as `storageRef`; the ingest
* run (ARC-63→65) reads the bytes server-side via the service role. This migration
* provisions that bucket and locks it down so each user can only touch their own
* files, namespaced by the first path segment = their auth.uid():
*
*   path convention:  resumes/{auth.uid()}/{filename}
*
* Conventions: RLS "own rows only" keyed on auth.uid(), matching
* 20260619101500_archer_core.sql. Storage RLS scopes on the object's first folder
* via storage.foldername(name)[1] — the Supabase-documented owner-folder pattern.
*
* NOTE: storage.objects already ships with RLS enabled on Supabase, so this
* migration only adds the policy. The `storage` schema is stubbed for the ephemeral
* type-gen / migration-test Postgres in packages/db/scripts/_bootstrap.sql (never
* deployed); type generation introspects `public` only, so this adds no types.
*/

-- ============================================================================
-- Private bucket. file_size_limit + allowed_mime_types enforce the upload
-- contract server-side (PDF + DOCX, ≤10 MiB) on top of the client's pre-upload
-- validation. on conflict keeps the migration safe if the bucket already exists.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes',
  'resumes',
  false,
  10485760, -- 10 MiB
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

-- ============================================================================
-- Owner-only access to objects under resumes/{uid}/…. A single FOR ALL policy
-- (select/insert/update/delete), mirroring the "Can manage own …" policies in
-- archer_core: `using` guards reads/updates/deletes, `with check` guards writes.
-- ============================================================================
create policy "Users manage own resume objects." on storage.objects
  for all to authenticated
  using (
    bucket_id = 'resumes'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'resumes'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );
