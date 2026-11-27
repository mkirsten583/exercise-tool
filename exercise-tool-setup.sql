-- Exercise Tool: run once in Supabase > SQL Editor (safe to run again)
create table if not exists public.activities (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  local_date  date not null,
  type        text not null check (type in ('ride','walk','run','row','weights')),
  data        jsonb not null,          -- the exercise: figures, notes, attachment list
  detail      jsonb,                   -- route and graph points from the FIT file
  rev         integer not null default 1,
  updated_at  timestamptz not null default now()
);
create index if not exists activities_user_date on public.activities (user_id, local_date desc);

-- each signed-in user can only see and change their own rows
alter table public.activities enable row level security;
drop policy if exists "own activities" on public.activities;
create policy "own activities" on public.activities
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.activities from anon;
grant select, insert, update, delete on public.activities to authenticated;
