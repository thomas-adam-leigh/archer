/**
* COVER-LETTERS STORAGE BUCKET — a private bucket + owner-only RLS for the rendered
* cover-letter .docx artifacts uploaded to boards as supporting documents (Apply
* Automation).
*
* When a cover letter is approved (or, until that hook lands, lazily at apply time),
* its text is rendered to a Word .docx and stored here; the apply adapter downloads
* the same approved file and uploads it alongside the résumé (boards like PNET's
* ApplyExpress take a file, not pasted text). Service-role reads/writes server-side.
*
* Mirrors 20260620220000_resumes_storage_bucket.sql: private bucket, DOCX-only, and
* owner-folder RLS keyed on the first path segment = auth.uid():
*
*   path convention:  cover-letters/{auth.uid()}/{candidacyId}/{versionId}.docx
*/

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cover-letters',
  'cover-letters',
  false,
  10485760, -- 10 MiB
  array['application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do nothing;

create policy "Users manage own cover-letter objects." on storage.objects
  for all to authenticated
  using (
    bucket_id = 'cover-letters'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'cover-letters'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );
