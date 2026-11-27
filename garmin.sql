-- Garmin daily health (sleep, HRV, resting heart rate, stress, Body Battery, steps, weight):
-- run once in Supabase > SQL Editor (safe to run again)
create table if not exists public.garmin_days (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  local_date  date not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, local_date)
);

alter table public.garmin_days enable row level security;
drop policy if exists "own garmin days" on public.garmin_days;
create policy "own garmin days" on public.garmin_days
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.garmin_days from anon;
grant select, insert, update, delete on public.garmin_days to authenticated;
