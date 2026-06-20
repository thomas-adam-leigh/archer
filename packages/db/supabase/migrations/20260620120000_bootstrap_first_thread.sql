/**
* AUTH BOOTSTRAP — provision a first thread on signup.
*
* The interaction substrate (20260620090000_archer_interaction.sql) is keyed on a
* per-user `threads` row: every client subscribes to a thread, and every run lives
* on one. So a new user needs an empty conversation ready the moment they
* authenticate. We extend the existing auth.users -> public.users provisioning
* trigger (handle_new_user) to also open the user's first thread in the same
* transaction, so signup leaves the identity AND a ready-to-use conversation.
*
* SECURITY DEFINER + empty search_path are preserved from the original; all
* objects are schema-qualified accordingly. Forward-only and additive: it only
* replaces the function body (no table/column changes), so the generated types
* are unchanged.
*/
create or replace function public.handle_new_user()
returns trigger
set search_path = ''
as $$
  begin
    insert into public.users (id, full_name, avatar_url, email)
    values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url', new.email);

    -- Open the user's first conversation so the agent has somewhere to greet them.
    insert into public.threads (user_id)
    values (new.id);

    return new;
  end;
$$
language plpgsql security definer;
