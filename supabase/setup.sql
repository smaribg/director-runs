-- Director Runs: run this once in Supabase → SQL Editor → New query → Run.
-- Every row belongs to the signed-in user; row level security keeps it private to them.

create table if not exists public.directors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  person_ids integer[] not null,          -- TMDB person ids (two for the Coen brothers)
  added_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.entries (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  movie_id integer not null,              -- TMDB movie id
  watched boolean not null default false,
  note text not null default '',
  hidden boolean not null default false,  -- removed from the director's list (docs, collaborations…)
  rating smallint check (rating between 1 and 5),
  poster text,                            -- chosen TMDB poster path; null = TMDB's default
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id)
);
-- For databases created before these columns existed.
alter table public.entries add column if not exists hidden boolean not null default false;
alter table public.entries add column if not exists rating smallint check (rating between 1 and 5);
alter table public.entries add column if not exists poster text;

create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  tmdb_token text,
  seeded boolean not null default false
);

alter table public.directors enable row level security;
alter table public.entries enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own directors" on public.directors;
drop policy if exists "own entries" on public.entries;
drop policy if exists "own settings" on public.settings;
create policy "own directors" on public.directors for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own entries" on public.entries for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own settings" on public.settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
