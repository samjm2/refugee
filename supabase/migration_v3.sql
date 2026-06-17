-- Migration v3: Chrome extension pairing + language change rate-limiting

-- Extension device-code pairing table.
-- Code -> user_id mapping only. No profile data stored here.
create table if not exists public.extension_pairings (
  code        text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz default now()
);
alter table public.extension_pairings enable row level security;
create policy "users own pairings" on public.extension_pairings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Language change log for rate-limiting (3 changes per 24 hours per user).
create table if not exists public.language_change_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  changed_to text not null,
  changed_at timestamptz default now()
);
create index if not exists language_change_log_user_time
  on public.language_change_log(user_id, changed_at desc);
alter table public.language_change_log enable row level security;
create policy "users own log" on public.language_change_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
