-- 树洞 Treehole — upgrade 002
-- Adds: post kinds (心事/感悟/随笔) and topics, sign-in required to read anything,
--       anonymous one-to-one private messages with blocking and reporting.
-- Run once in Supabase → SQL Editor, after schema.sql.

-- ───────────── Kinds and topics on posts ─────────────
alter table public.posts add column if not exists kind text not null default 'secret'
  check (kind in ('secret','insight','essay'));
alter table public.posts add column if not exists topic text not null default 'other'
  check (topic in ('sad','anxious','angry','lonely','tired','happy',
                   'study','work','love','family','friends','growth','health','other'));

drop view if exists public.feed_posts;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='posts' and column_name='mood') then
    update public.posts set topic = case when mood in ('sad','anxious','angry','tired','lonely') then mood else 'other' end;
    alter table public.posts drop column mood;
  end if;
end $$;

create index if not exists posts_topic_idx on public.posts (topic, created_at desc);
create index if not exists posts_kind_idx  on public.posts (kind, created_at desc);

-- ───────────── Reading requires sign-in ─────────────
create view public.feed_posts as
  select p.id, p.body, p.kind, p.topic, p.hidden, p.created_at, pr.nickname,
         (p.author_id = auth.uid()) as mine
  from public.posts p join public.profiles pr on pr.id = p.author_id
  where auth.uid() is not null
    and ((not p.hidden) or public.is_admin() or p.author_id = auth.uid());

create or replace view public.feed_replies as
  select r.id, r.post_id, r.body, r.hidden, r.created_at, pr.nickname,
         (r.author_id = auth.uid()) as mine
  from public.replies r join public.profiles pr on pr.id = r.author_id
  where auth.uid() is not null
    and ((not r.hidden) or public.is_admin() or r.author_id = auth.uid());

create or replace view public.rating_summary as
  select target_type, target_id,
         count(*) filter (where helpful)     as helpful_count,
         count(*) filter (where not helpful) as unhelpful_count
  from public.ratings where auth.uid() is not null
  group by target_type, target_id;

create or replace view public.rating_comments as
  select target_type, target_id, helpful, comment, created_at
  from public.ratings
  where auth.uid() is not null and comment is not null and comment <> '';

create or replace view public.topic_counts as
  select topic, count(*) as n from public.posts
  where auth.uid() is not null and not hidden
  group by topic;

revoke all on public.feed_posts, public.feed_replies, public.rating_summary,
              public.rating_comments, public.topic_counts from anon;
grant select on public.feed_posts, public.feed_replies, public.rating_summary,
                public.rating_comments, public.topic_counts to authenticated;

-- ───────────── Private messages ─────────────
create table if not exists public.conversations (
  id              bigint generated always as identity primary key,
  user_a          uuid not null references public.profiles(id) on delete cascade,
  user_b          uuid not null references public.profiles(id) on delete cascade,
  blocked_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create table if not exists public.messages (
  id              bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 1000),
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

create or replace function public.is_member(conv bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations where id = conv and auth.uid() in (user_a, user_b));
$$;

drop policy if exists "conversations members read" on public.conversations;
create policy "conversations members read" on public.conversations
  for select using (auth.uid() in (user_a, user_b));

-- Members read their chat. Admins can read only individual messages that someone reported.
drop policy if exists "messages read" on public.messages;
create policy "messages read" on public.messages for select using (
  public.is_member(conversation_id)
  or (public.is_admin() and exists (
        select 1 from public.reports r where r.target_type = 'message' and r.target_id = messages.id))
);
drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages for insert with check (
  sender_id = auth.uid()
  and public.is_member(conversation_id)
  and public.can_write()
  and not exists (select 1 from public.conversations c where c.id = conversation_id and c.blocked_by is not null)
);

create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;
drop trigger if exists messages_touch on public.messages;
create trigger messages_touch after insert on public.messages
  for each row execute function public.touch_conversation();

-- Flood control now also covers messages (60 per 10 minutes).
create or replace function public.rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int; lim int;
begin
  if tg_table_name = 'posts' then
    select count(*) into n from public.posts where author_id = auth.uid() and created_at > now() - interval '10 minutes'; lim := 5;
  elsif tg_table_name = 'replies' then
    select count(*) into n from public.replies where author_id = auth.uid() and created_at > now() - interval '10 minutes'; lim := 20;
  else
    select count(*) into n from public.messages where sender_id = auth.uid() and created_at > now() - interval '10 minutes'; lim := 60;
  end if;
  if n >= lim then raise exception 'rate_limited'; end if;
  return new;
end $$;
drop trigger if exists messages_rate_limit on public.messages;
create trigger messages_rate_limit before insert on public.messages
  for each row execute function public.rate_limit();

-- Start (or reopen) a chat with the author of a post or reply, without revealing who they are.
create or replace function public.start_conversation(p_type text, p_id bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid; a uuid; b uuid; cid bigint;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if not public.can_write() then raise exception 'banned'; end if;
  if p_type = 'post' then select author_id into other from public.posts where id = p_id and not hidden;
  elsif p_type = 'reply' then select author_id into other from public.replies where id = p_id and not hidden;
  else raise exception 'bad_type'; end if;
  if other is null then raise exception 'not_found'; end if;
  if other = me then raise exception 'self'; end if;
  a := least(me, other); b := greatest(me, other);
  insert into public.conversations (user_a, user_b) values (a, b) on conflict (user_a, user_b) do nothing;
  select id into cid from public.conversations where user_a = a and user_b = b;
  return cid;
end $$;

create or replace function public.mark_read(conv bigint)
returns void language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where conversation_id = conv and sender_id <> auth.uid() and read_at is null and public.is_member(conv);
$$;

-- Block or unblock a chat. Only the person who blocked can unblock.
create or replace function public.set_block(conv bigint, on_off boolean)
returns void language sql security definer set search_path = public as $$
  update public.conversations
     set blocked_by = case when on_off then auth.uid() else null end
   where id = conv and auth.uid() in (user_a, user_b)
     and (blocked_by is null or blocked_by = auth.uid());
$$;

create or replace view public.my_conversations as
  select c.id,
         pr.nickname as other_nickname,
         c.last_message_at,
         (c.blocked_by is not null) as blocked,
         coalesce(c.blocked_by = auth.uid(), false) as blocked_by_me,
         (select m.body from public.messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as last_body,
         (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.read_at is null) as unread
  from public.conversations c
  join public.profiles pr on pr.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
  where auth.uid() in (c.user_a, c.user_b);

revoke all on public.my_conversations from anon;
grant select on public.my_conversations to authenticated;
revoke execute on function public.start_conversation(text, bigint), public.mark_read(bigint), public.set_block(bigint, boolean) from anon;

-- Reports can now point at a private message too.
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('post','reply','message'));
