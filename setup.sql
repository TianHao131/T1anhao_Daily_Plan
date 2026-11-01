begin;

-- Separate from navigation_bookmark_state; existing navigation data is untouched.
create table if not exists public.daily_checkin_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  constraint daily_data_shape check (
    jsonb_typeof(data) = 'object' and
    data ?& array['tasks', 'records', 'monthlyTasks', 'monthlyRecords', 'plannedTasks', 'tags'] and
    jsonb_typeof(data->'tasks') = 'array' and
    jsonb_typeof(data->'monthlyTasks') = 'array' and
    jsonb_typeof(data->'plannedTasks') = 'array' and
    jsonb_typeof(data->'tags') = 'array' and
    jsonb_typeof(data->'records') = 'object' and
    jsonb_typeof(data->'monthlyRecords') = 'object' and
    octet_length(data::text) <= 16000000
  )
);
alter table public.daily_checkin_state enable row level security;
alter table public.daily_checkin_state force row level security;

revoke all on public.daily_checkin_state from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.daily_checkin_state to authenticated;
grant insert (user_id, data) on public.daily_checkin_state to authenticated;
grant update (data) on public.daily_checkin_state to authenticated;

drop policy if exists daily_select_own on public.daily_checkin_state;
create policy daily_select_own on public.daily_checkin_state
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists daily_insert_own on public.daily_checkin_state;
create policy daily_insert_own on public.daily_checkin_state
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists daily_update_own on public.daily_checkin_state;
create policy daily_update_own on public.daily_checkin_state
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.daily_checkin_bump_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.daily_checkin_bump_revision() from public, anon;
grant execute on function public.daily_checkin_bump_revision() to authenticated;
drop trigger if exists daily_revision on public.daily_checkin_state;
create trigger daily_revision before update on public.daily_checkin_state
  for each row execute function public.daily_checkin_bump_revision();
commit;

select c.relrowsecurity as row_security,
       c.relforcerowsecurity as force_row_security,
       (select count(*) from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'daily_checkin_state';
