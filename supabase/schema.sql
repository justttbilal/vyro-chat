-- VYRO.CHAT starter schema for Supabase.
-- Run the whole file in Supabase Dashboard -> SQL Editor.
-- Then enable Realtime for public.messages and public.chat_sessions if not enabled automatically.

create extension if not exists pgcrypto;

create table if not exists public.match_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  interests text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  participant_a uuid not null references auth.users(id) on delete cascade,
  participant_b uuid not null references auth.users(id) on delete cascade,
  interests text[] not null default '{}',
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint different_participants check (participant_a <> participant_b)
);
create index if not exists chat_sessions_a_idx on public.chat_sessions(participant_a, created_at desc);
create index if not exists chat_sessions_b_idx on public.chat_sessions(participant_b, created_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists messages_session_created_idx on public.messages(session_id, created_at);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 120),
  created_at timestamptz not null default now()
);

alter table public.match_queue enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.messages enable row level security;
alter table public.reports enable row level security;

-- Queue records are private: RLS is on with no policies, so only the RPC functions below can touch the queue.

-- Participants can only read sessions they belong to.
drop policy if exists "participants read own sessions" on public.chat_sessions;
create policy "participants read own sessions" on public.chat_sessions
  for select to authenticated using (auth.uid() = participant_a or auth.uid() = participant_b);

-- Messages are visible to current session participants. Users can only send as themselves.
drop policy if exists "participants read session messages" on public.messages;
create policy "participants read session messages" on public.messages
  for select to authenticated using (
    exists (select 1 from public.chat_sessions s where s.id = session_id and s.ended_at is null and (s.participant_a = auth.uid() or s.participant_b = auth.uid()))
  );
drop policy if exists "participants send own messages" on public.messages;
create policy "participants send own messages" on public.messages
  for insert to authenticated with check (
    sender_id = auth.uid() and exists (
      select 1 from public.chat_sessions s where s.id = session_id and s.ended_at is null and (s.participant_a = auth.uid() or s.participant_b = auth.uid())
    )
  );

-- A user may submit a report only for a session they participated in.
drop policy if exists "participants submit reports" on public.reports;
create policy "participants submit reports" on public.reports
  for insert to authenticated with check (
    reporter_id = auth.uid() and exists (
      select 1 from public.chat_sessions s where s.id = session_id and (s.participant_a = auth.uid() or s.participant_b = auth.uid())
    )
  );

-- Replaces the older one-argument version if it was already installed.
drop function if exists public.find_vyro_match(text[]);

create or replace function public.find_vyro_match(p_interests text[] default '{}', p_reset boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_other uuid;
  v_other_tags text[] := '{}';
  v_session public.chat_sessions%rowtype;
  v_tags text[] := coalesce(p_interests, '{}');
begin
  if v_me is null then raise exception 'Sign in is required.'; end if;
  if cardinality(v_tags) > 10 then raise exception 'Choose up to 10 interests.'; end if;
  -- Serialize requests for this account so rapid taps cannot create duplicate queue rows.
  perform pg_advisory_xact_lock(hashtextextended(v_me::text, 0));

  -- A brand-new search (p_reset) closes any old session left over from a closed tab or reload.
  if p_reset then
    update public.chat_sessions set ended_at = now()
      where ended_at is null and (participant_a = v_me or participant_b = v_me);
  end if;

  -- Drop abandoned queue rows (searchers poll every few seconds, so old rows mean the tab is gone).
  delete from public.match_queue where created_at < now() - interval '30 seconds';

  -- Existing active session (created by someone else matching me while I poll)? Return it.
  select * into v_session from public.chat_sessions s
    where s.ended_at is null and (s.participant_a = v_me or s.participant_b = v_me)
    order by s.created_at desc limit 1;
  if found then
    delete from public.match_queue where user_id = v_me;
    return jsonb_build_object('session_id', v_session.id, 'matched', true);
  end if;

  -- Prefer a shared interest, but fall back to any waiting peer so the queue cannot stall forever.
  select q.user_id, q.interests into v_other, v_other_tags
    from public.match_queue q
    where q.user_id <> v_me
      and not exists (
        select 1 from public.chat_sessions s
        where s.ended_at is null and (s.participant_a = q.user_id or s.participant_b = q.user_id)
      )
    order by case when cardinality(v_tags) > 0 and q.interests && v_tags then 0 else 1 end, q.created_at asc
    limit 1 for update of q skip locked;

  if v_other is null then
    insert into public.match_queue(user_id, interests, created_at)
      values (v_me, v_tags, now())
      on conflict (user_id) do update set interests = excluded.interests, created_at = excluded.created_at;
    return jsonb_build_object('matched', false, 'session_id', null);
  end if;

  delete from public.match_queue where user_id in (v_me, v_other);
  insert into public.chat_sessions(participant_a, participant_b, interests)
    values (v_me, v_other, (select coalesce(array_agg(distinct x), '{}') from unnest(v_tags || coalesce(v_other_tags, '{}')) x))
    returning * into v_session;
  return jsonb_build_object('matched', true, 'session_id', v_session.id);
end;
$$;

create or replace function public.leave_vyro_match(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Sign in is required.'; end if;
  delete from public.match_queue where user_id = v_me;
  update public.chat_sessions set ended_at = now()
    where id = p_session_id and ended_at is null and (participant_a = v_me or participant_b = v_me);
  return true;
end;
$$;

revoke all on function public.find_vyro_match(text[], boolean) from public, anon;
revoke all on function public.leave_vyro_match(uuid) from public, anon;
grant execute on function public.find_vyro_match(text[], boolean) to authenticated;
grant execute on function public.leave_vyro_match(uuid) to authenticated;
grant select on public.chat_sessions to authenticated;
grant select, insert on public.messages to authenticated;
grant insert on public.reports to authenticated;

-- Enable Realtime publication for live chat/session updates. Safe to run more than once.
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
when undefined_object then raise notice 'supabase_realtime publication not found; enable Realtime in Supabase Dashboard.';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.chat_sessions;
exception when duplicate_object then null;
when undefined_object then raise notice 'supabase_realtime publication not found; enable Realtime in Supabase Dashboard.';
end $$;
