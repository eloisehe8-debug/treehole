-- 树洞 Treehole — Supabase schema
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query → paste → Run.

-- ───────────── Profiles (one per signed-in user, shown only as a random nickname) ─────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nickname   text not null,
  is_admin   boolean not null default false,
  banned     boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, 'tree#' || lpad((floor(random() * 10000))::int::text, 4, '0'));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.can_write()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select not banned from public.profiles where id = auth.uid()), false);
$$;

-- ───────────── Posts (倾诉) and replies (倾听) ─────────────
create table if not exists public.posts (
  id         bigint generated always as identity primary key,
  author_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  mood       text not null default 'other' check (mood in ('sad','anxious','angry','tired','lonely','other')),
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.replies (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references public.posts(id) on delete cascade,
  author_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 1000),
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

-- ───────────── Anonymous ratings (匿名评价) and reports (匿名举报) ─────────────
create table if not exists public.ratings (
  id          bigint generated always as identity primary key,
  target_type text not null check (target_type in ('post','reply')),
  target_id   bigint not null,
  rater_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  helpful     boolean not null,
  comment     text check (comment is null or char_length(comment) <= 200),
  created_at  timestamptz not null default now(),
  unique (rater_id, target_type, target_id)
);

create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  target_type text not null check (target_type in ('post','reply')),
  target_id   bigint not null,
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  reason      text not null check (reason in ('harassment','hate','spam','self_harm','other')),
  note        text check (note is null or char_length(note) <= 300),
  resolved    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);

-- Simple flood control: at most 5 posts and 20 replies per user per 10 minutes.
create or replace function public.rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int; lim int;
begin
  if tg_table_name = 'posts' then
    select count(*) into n from public.posts where author_id = auth.uid() and created_at > now() - interval '10 minutes'; lim := 5;
  else
    select count(*) into n from public.replies where author_id = auth.uid() and created_at > now() - interval '10 minutes'; lim := 20;
  end if;
  if n >= lim then raise exception 'rate_limited'; end if;
  return new;
end $$;

drop trigger if exists posts_rate_limit on public.posts;
create trigger posts_rate_limit before insert on public.posts for each row execute function public.rate_limit();
drop trigger if exists replies_rate_limit on public.replies;
create trigger replies_rate_limit before insert on public.replies for each row execute function public.rate_limit();

-- ───────────── Row level security ─────────────
alter table public.profiles enable row level security;
alter table public.posts    enable row level security;
alter table public.replies  enable row level security;
alter table public.ratings  enable row level security;
alter table public.reports  enable row level security;

-- Profiles: only admins change ban/admin flags.
drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles for update using (public.is_admin());

-- Posts
drop policy if exists "posts insert" on public.posts;
create policy "posts insert" on public.posts for insert with check (author_id = auth.uid() and public.can_write());
drop policy if exists "posts delete own" on public.posts;
create policy "posts delete own" on public.posts for delete using (author_id = auth.uid() or public.is_admin());
drop policy if exists "posts admin update" on public.posts;
create policy "posts admin update" on public.posts for update using (public.is_admin());

-- Replies
drop policy if exists "replies insert" on public.replies;
create policy "replies insert" on public.replies for insert with check (author_id = auth.uid() and public.can_write());
drop policy if exists "replies delete own" on public.replies;
create policy "replies delete own" on public.replies for delete using (author_id = auth.uid() or public.is_admin());
drop policy if exists "replies admin update" on public.replies;
create policy "replies admin update" on public.replies for update using (public.is_admin());

-- Ratings: you can only see your OWN rating rows (so nobody learns who rated what).
-- Everyone sees totals and comments through the rating_summary / rating_comments views below.
drop policy if exists "ratings read own" on public.ratings;
create policy "ratings read own" on public.ratings for select using (rater_id = auth.uid());
drop policy if exists "ratings insert" on public.ratings;
create policy "ratings insert" on public.ratings for insert with check (rater_id = auth.uid() and public.can_write());
drop policy if exists "ratings update own" on public.ratings;
create policy "ratings update own" on public.ratings for update using (rater_id = auth.uid());
drop policy if exists "ratings delete own" on public.ratings;
create policy "ratings delete own" on public.ratings for delete using (rater_id = auth.uid());

-- Reports: anyone signed in can file one; only admins can read or resolve them.
drop policy if exists "reports insert" on public.reports;
create policy "reports insert" on public.reports for insert with check (reporter_id = auth.uid());
drop policy if exists "reports admin read" on public.reports;
create policy "reports admin read" on public.reports for select using (public.is_admin());
drop policy if exists "reports admin update" on public.reports;
create policy "reports admin update" on public.reports for update using (public.is_admin());

-- ───────────── Public views without any user ids ─────────────
create or replace view public.rating_summary as
  select target_type, target_id,
         count(*) filter (where helpful)     as helpful_count,
         count(*) filter (where not helpful) as unhelpful_count
  from public.ratings group by target_type, target_id;

create or replace view public.rating_comments as
  select target_type, target_id, helpful, comment, created_at
  from public.ratings where comment is not null and comment <> '';

grant select on public.rating_summary, public.rating_comments to anon, authenticated;

-- Never expose author ids of posts/replies through the API: clients read these views instead.
create or replace view public.feed_posts as
  select p.id, p.body, p.mood, p.hidden, p.created_at, pr.nickname,
         (p.author_id = auth.uid()) as mine
  from public.posts p join public.profiles pr on pr.id = p.author_id
  where (not p.hidden) or public.is_admin() or p.author_id = auth.uid();

create or replace view public.feed_replies as
  select r.id, r.post_id, r.body, r.hidden, r.created_at, pr.nickname,
         (r.author_id = auth.uid()) as mine
  from public.replies r join public.profiles pr on pr.id = r.author_id
  where (not r.hidden) or public.is_admin() or r.author_id = auth.uid();

grant select on public.feed_posts, public.feed_replies to anon, authenticated;

-- Block direct reads of the raw tables (which carry author_id) except your own rows and admins.
drop policy if exists "posts read" on public.posts;
create policy "posts read" on public.posts for select using (author_id = auth.uid() or public.is_admin());
drop policy if exists "replies read" on public.replies;
create policy "replies read" on public.replies for select using (author_id = auth.uid() or public.is_admin());
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select using (id = auth.uid() or public.is_admin());

-- ───────────── Make yourself admin (run AFTER you sign in once on the site) ─────────────
-- update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = 'YOUR_EMAIL_HERE');
