-- Minimal stub of the Supabase-managed roles + `auth` schema so the public
-- migrations (which GRANT to authenticated, FK to auth.users, and call
-- auth.uid()) apply against a plain Postgres.
-- This is ONLY for ephemeral type-generation / migration testing — never deployed.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb
);

create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- Minimal stub of the Supabase-managed `storage` schema (buckets + objects + the
-- foldername() path helper) so storage migrations — a private bucket with
-- owner-folder RLS — apply against a plain Postgres. storage.objects ships with
-- RLS already enabled on Supabase, so enable it here too; migrations add policies.
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table storage.objects enable row level security;

-- Supabase's path helper: split on '/', drop the final (filename) element, so
-- foldername('uid/cv.pdf') = {uid}. Owner RLS keys on element [1].
create or replace function storage.foldername(name text) returns text[]
  language plpgsql immutable
  as $fn$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end
$fn$;
