begin;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'nova_app') then
    create role nova_app nologin nosuperuser nocreatedb nocreaterole noinherit
      noreplication nobypassrls;
  end if;
end
$block$;

do $block$
declare
  app_role pg_catalog.pg_roles%rowtype;
begin
  select * into app_role from pg_catalog.pg_roles where rolname = 'nova_app';
  if app_role.rolsuper
    or app_role.rolcreatedb
    or app_role.rolcreaterole
    or app_role.rolinherit
    or app_role.rolcanlogin
    or app_role.rolreplication
    or app_role.rolbypassrls then
    raise exception
      'The existing nova_app role has elevated privileges. Restrict its role attributes before rerunning this script.';
  end if;
end
$block$;
grant nova_app to postgres;
grant usage on schema public to nova_app;

create or replace function public.nova_auth_uid()
returns uuid
language sql
stable
set search_path = ''
as $function$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$function$;

revoke all on function public.nova_auth_uid() from public, anon;
grant execute on function public.nova_auth_uid() to authenticated, nova_app;

create or replace function public.nova_sync_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (id)
    values (new.id)
    on conflict (id) do nothing;
    return new;
  end if;

  delete from public.profiles where id = old.id;
  return old;
end
$function$;

revoke all on function public.nova_sync_auth_profile() from public, anon, authenticated;

drop trigger if exists nova_auth_user_created on auth.users;
create trigger nova_auth_user_created
  after insert on auth.users
  for each row execute function public.nova_sync_auth_profile();

drop trigger if exists nova_auth_user_deleted on auth.users;
create trigger nova_auth_user_deleted
  before delete on auth.users
  for each row execute function public.nova_sync_auth_profile();

insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.profile_encryption_keys enable row level security;
alter table public.profile_encryption_keys force row level security;
alter table public.conversations enable row level security;
alter table public.conversations force row level security;
alter table public.messages enable row level security;
alter table public.messages force row level security;
alter table public.pin_credentials enable row level security;
alter table public.pin_credentials force row level security;
alter table public.memories enable row level security;
alter table public.memories force row level security;

revoke all on public.profiles, public.profile_encryption_keys, public.conversations,
  public.messages, public.pin_credentials, public.memories
  from anon, authenticated;
grant select, insert, update on public.profiles to authenticated, nova_app;
grant select, insert, update, delete on public.profile_encryption_keys,
  public.conversations, public.messages, public.pin_credentials, public.memories
  to nova_app;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated, nova_app
  using ((select public.nova_auth_uid()) = id);

drop policy if exists "Users can create their own profile" on public.profiles;
create policy "Users can create their own profile"
  on public.profiles
  for insert
  to authenticated, nova_app
  with check ((select public.nova_auth_uid()) = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles
  for update
  to authenticated, nova_app
  using ((select public.nova_auth_uid()) = id)
  with check ((select public.nova_auth_uid()) = id);

drop policy if exists "Backend accesses own profile encryption key"
  on public.profile_encryption_keys;
create policy "Backend accesses own profile encryption key"
  on public.profile_encryption_keys
  for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

drop policy if exists "Backend accesses own conversations"
  on public.conversations;
create policy "Backend accesses own conversations"
  on public.conversations
  for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

drop policy if exists "Backend accesses own messages"
  on public.messages;
create policy "Backend accesses own messages"
  on public.messages
  for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

drop policy if exists "Backend accesses own PIN credential"
  on public.pin_credentials;
create policy "Backend accesses own PIN credential"
  on public.pin_credentials
  for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

drop policy if exists "Backend accesses own memories"
  on public.memories;
create policy "Backend accesses own memories"
  on public.memories
  for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

create table if not exists public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  encrypted_refresh_token bytea not null,
  token_nonce bytea not null,
  token_auth_tag bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connected_accounts_profile_provider_key unique (profile_id, provider),
  constraint connected_accounts_provider_check
    check (provider in ('google', 'home_assistant'))
);

alter table public.connected_accounts
  drop constraint if exists connected_accounts_provider_check;
alter table public.connected_accounts
  add constraint connected_accounts_provider_check
  check (provider in ('google', 'home_assistant'));

alter table public.connected_accounts enable row level security;
alter table public.connected_accounts force row level security;
revoke all on public.connected_accounts from anon, authenticated;
grant select, insert, update, delete on public.connected_accounts to nova_app;

drop policy if exists "Backend accesses own connected accounts"
  on public.connected_accounts;
create policy "Backend accesses own connected accounts"
  on public.connected_accounts
  for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  prompt_ciphertext bytea not null,
  prompt_nonce bytea not null,
  prompt_auth_tag bytea not null,
  timezone text not null,
  local_time text not null check (local_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  schedule_days integer[] not null
    check (cardinality(schedule_days) between 1 and 7 and schedule_days <@ array[1,2,3,4,5,6,7]),
  next_run_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint routines_id_profile_id_key unique (id, profile_id)
);

alter table public.routines
  drop constraint if exists routines_title_check;
alter table public.routines
  add constraint routines_title_check
  check (char_length(title) between 1 and 80);
alter table public.routines
  drop constraint if exists routines_local_time_check;
alter table public.routines
  add constraint routines_local_time_check
  check (local_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.routines
  drop constraint if exists routines_schedule_days_check;
alter table public.routines
  add constraint routines_schedule_days_check
  check (
    schedule_days is not null
    and cardinality(schedule_days) between 1 and 7
    and schedule_days <@ array[1,2,3,4,5,6,7]
  );

create index if not exists routines_enabled_next_run_at_idx
  on public.routines (enabled, next_run_at);
create index if not exists routines_profile_created_at_idx
  on public.routines (profile_id, created_at desc);
alter table public.routines enable row level security;
alter table public.routines force row level security;
revoke all on public.routines from anon, authenticated;
grant select, insert, update, delete on public.routines to nova_app;

drop policy if exists "Backend accesses own routines" on public.routines;
create policy "Backend accesses own routines"
  on public.routines for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

create table if not exists public.routine_runs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  routine_id uuid not null,
  scheduled_for timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint routine_runs_routine_profile_fkey
    foreign key (routine_id, profile_id)
    references public.routines(id, profile_id) on delete cascade,
  constraint routine_runs_routine_scheduled_for_key
    unique (routine_id, scheduled_for)
);

alter table public.routine_runs
  drop constraint if exists routine_runs_status_check;
alter table public.routine_runs
  add constraint routine_runs_status_check
  check (status in ('pending', 'running', 'completed'));

create index if not exists routine_runs_profile_status_scheduled_idx
  on public.routine_runs (profile_id, status, scheduled_for desc);
alter table public.routine_runs enable row level security;
alter table public.routine_runs force row level security;
revoke all on public.routine_runs from anon, authenticated;
grant select, insert, update, delete on public.routine_runs to nova_app;

drop policy if exists "Backend accesses own routine runs" on public.routine_runs;
create policy "Backend accesses own routine runs"
  on public.routine_runs for all to nova_app
  using ((select public.nova_auth_uid()) = profile_id)
  with check ((select public.nova_auth_uid()) = profile_id);

create or replace function public.nova_queue_due_routine_runs()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  due_routine record;
  next_run timestamptz;
  inserted_count integer;
  total_inserted integer := 0;
begin
  update public.routine_runs
  set status = 'pending', started_at = null
  where status = 'running'
    and started_at < pg_catalog.now() - interval '30 minutes';

  for due_routine in
    select id, profile_id, next_run_at, timezone, local_time, schedule_days
    from public.routines
    where enabled and next_run_at <= pg_catalog.now()
    order by next_run_at
    for update skip locked
    limit 100
  loop
    insert into public.routine_runs (profile_id, routine_id, scheduled_for)
    values (due_routine.profile_id, due_routine.id, due_routine.next_run_at)
    on conflict (routine_id, scheduled_for) do nothing;
    get diagnostics inserted_count = row_count;
    total_inserted := total_inserted + inserted_count;

    select ((candidate.local_day + due_routine.local_time::time)
      at time zone due_routine.timezone)
    into next_run
    from pg_catalog.generate_series(
      ((pg_catalog.now() at time zone due_routine.timezone)::date)::timestamp without time zone,
      (((pg_catalog.now() at time zone due_routine.timezone)::date + 8)::timestamp without time zone),
      interval '1 day'
    ) as candidate(local_day)
    where extract(isodow from candidate.local_day)::integer = any(due_routine.schedule_days)
      and ((candidate.local_day + due_routine.local_time::time)
        at time zone due_routine.timezone) > pg_catalog.now()
      and (((candidate.local_day + due_routine.local_time::time)
        at time zone due_routine.timezone) at time zone due_routine.timezone)
        = candidate.local_day + due_routine.local_time::time
    order by ((candidate.local_day + due_routine.local_time::time)
      at time zone due_routine.timezone)
    limit 1;

    update public.routines
    set next_run_at = next_run,
        updated_at = pg_catalog.now()
    where id = due_routine.id and profile_id = due_routine.profile_id;
  end loop;

  return total_inserted;
end
$function$;

revoke all on function public.nova_queue_due_routine_runs() from public, anon, authenticated;
grant execute on function public.nova_queue_due_routine_runs() to nova_app;

commit;
