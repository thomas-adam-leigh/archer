/**
* Add email column to users, backfilled from auth.users.
*/
alter table public.users
  add column email text;

-- Backfill existing rows from auth.users
update public.users u
  set email = a.email
  from auth.users a
  where u.id = a.id;

-- Populate email on signup
create or replace function public.handle_new_user()
returns trigger
set search_path = ''
as $$
  begin
    insert into public.users (id, full_name, avatar_url, email)
    values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url', new.email);
    return new;
  end;
$$
language plpgsql security definer;
