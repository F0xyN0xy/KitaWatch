-- Persist incremental episode playback progress and expose watch-time rankings.
-- Progress batches are idempotent, tied to the authenticated user, and limited
-- to small forward-playback intervals reported by the direct-media player.

create table if not exists public.playback_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  anime_id integer not null check (anime_id > 0),
  episode_number numeric not null check (episode_number > 0),
  watched_seconds integer not null default 0 check (watched_seconds >= 0),
  episode_duration_seconds integer not null check (
    episode_duration_seconds >= 60 and episode_duration_seconds <= 10800
  ),
  last_position_seconds integer not null default 0 check (
    last_position_seconds >= 0 and last_position_seconds <= episode_duration_seconds
  ),
  last_session_id uuid,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, anime_id, episode_number),
  check (watched_seconds <= episode_duration_seconds)
);

create table if not exists public.playback_progress_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  client_event_id uuid not null,
  session_id uuid not null,
  anime_id integer not null check (anime_id > 0),
  episode_number numeric not null check (episode_number > 0),
  position_seconds integer not null check (position_seconds >= 0),
  watched_seconds_delta integer not null check (
    watched_seconds_delta >= 1 and watched_seconds_delta <= 30
  ),
  episode_duration_seconds integer not null check (
    episode_duration_seconds >= 60 and episode_duration_seconds <= 10800
  ),
  created_at timestamptz not null default now(),
  unique (user_id, client_event_id),
  check (position_seconds <= episode_duration_seconds)
);

create index if not exists playback_progress_events_created_at_idx
  on public.playback_progress_events (created_at desc);

create index if not exists playback_progress_events_user_created_at_idx
  on public.playback_progress_events (user_id, created_at desc);

alter table public.playback_progress enable row level security;
alter table public.playback_progress_events enable row level security;

-- Progress is read and written only through narrowly scoped database functions.
revoke all on table public.playback_progress from anon, authenticated;
revoke all on table public.playback_progress_events from anon, authenticated;

create or replace function public.record_playback_progress(
  p_client_event_id uuid,
  p_session_id uuid,
  p_anime_id integer,
  p_episode_number numeric,
  p_position_seconds integer,
  p_watched_seconds_delta integer,
  p_episode_duration_seconds integer
)
returns table(watched_seconds integer, completed boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_user_id uuid := auth.uid();
  inserted_event_id bigint;
  current_total integer;
  recent_event_count integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_client_event_id is null
     or p_session_id is null
     or p_anime_id is null or p_anime_id <= 0
     or p_episode_number is null or p_episode_number <= 0
     or p_position_seconds is null or p_position_seconds < 0
     or p_watched_seconds_delta is null
     or p_watched_seconds_delta < 1 or p_watched_seconds_delta > 30
     or p_episode_duration_seconds is null
     or p_episode_duration_seconds < 60 or p_episode_duration_seconds > 10800
     or p_position_seconds > p_episode_duration_seconds then
    raise exception 'Invalid playback progress data' using errcode = '22023';
  end if;

  insert into public.playback_progress_events (
    user_id, client_event_id, session_id, anime_id, episode_number,
    position_seconds, watched_seconds_delta, episode_duration_seconds
  ) values (
    current_user_id, p_client_event_id, p_session_id, p_anime_id, p_episode_number,
    p_position_seconds, p_watched_seconds_delta, p_episode_duration_seconds
  )
  on conflict (user_id, client_event_id) do nothing
  returning id into inserted_event_id;

  -- A retry after a lost response must not add the same interval twice.
  if inserted_event_id is null then
    select progress.watched_seconds
      into current_total
    from public.playback_progress as progress
    where progress.user_id = current_user_id
      and progress.anime_id = p_anime_id
      and progress.episode_number = p_episode_number;

    return query
      select coalesce(current_total, 0),
             coalesce(current_total >= ceil(p_episode_duration_seconds * 0.8), false);
    return;
  end if;

  select count(*)::integer
    into recent_event_count
  from public.playback_progress_events as events
  where events.user_id = current_user_id
    and events.created_at > now() - interval '1 hour';

  if recent_event_count > 600 then
    raise exception 'Playback progress rate limit reached' using errcode = 'P0001';
  end if;

  insert into public.playback_progress as progress (
    user_id, anime_id, episode_number, watched_seconds,
    episode_duration_seconds, last_position_seconds, last_session_id,
    updated_at, completed_at
  ) values (
    current_user_id, p_anime_id, p_episode_number,
    least(p_watched_seconds_delta, p_episode_duration_seconds),
    p_episode_duration_seconds, p_position_seconds, p_session_id,
    now(),
    case
      when p_watched_seconds_delta >= ceil(p_episode_duration_seconds * 0.8) then now()
      else null
    end
  )
  on conflict (user_id, anime_id, episode_number)
  do update set
    watched_seconds = least(
      excluded.episode_duration_seconds,
      progress.watched_seconds + excluded.watched_seconds
    ),
    episode_duration_seconds = excluded.episode_duration_seconds,
    last_position_seconds = excluded.last_position_seconds,
    last_session_id = excluded.last_session_id,
    updated_at = now(),
    completed_at = coalesce(
      progress.completed_at,
      case
        when least(
          excluded.episode_duration_seconds,
          progress.watched_seconds + excluded.watched_seconds
        ) >= ceil(excluded.episode_duration_seconds * 0.8) then now()
        else null
      end
    )
  returning progress.watched_seconds into current_total;

  -- Keep the existing completed-episode table as the episode-count source.
  -- This is inserted once per user/anime/episode, even across many sessions.
  if current_total >= ceil(p_episode_duration_seconds * 0.8) then
    insert into public.watch_events (
      user_id, client_event_id, anime_id, episode_number,
      watched_seconds, episode_duration_seconds
    ) values (
      current_user_id, p_client_event_id, p_anime_id, p_episode_number,
      current_total, p_episode_duration_seconds
    )
    on conflict (user_id, anime_id, episode_number)
    do update set
      watched_seconds = greatest(public.watch_events.watched_seconds, excluded.watched_seconds);
  end if;

  return query
    select current_total,
           current_total >= ceil(p_episode_duration_seconds * 0.8);
end;
$function$;

revoke all on function public.record_playback_progress(uuid, uuid, integer, numeric, integer, integer, integer)
  from public, anon;
grant execute on function public.record_playback_progress(uuid, uuid, integer, numeric, integer, integer, integer)
  to authenticated;

-- The RPC now returns both metrics and ranks by the selected metric.
drop function if exists public.get_leaderboard(text, integer);

create function public.get_leaderboard(
  p_period text default 'weekly',
  p_limit integer default 50,
  p_metric text default 'episodes'
)
returns table(
  user_id uuid,
  display_name text,
  avatar_url text,
  episode_count bigint,
  watched_seconds bigint,
  rank bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  since_time timestamptz;
begin
  if p_period not in ('weekly', 'monthly', 'all_time') then
    raise exception 'Period must be weekly, monthly, or all_time' using errcode = '22023';
  end if;

  if p_metric not in ('episodes', 'watch_time') then
    raise exception 'Metric must be episodes or watch_time' using errcode = '22023';
  end if;

  if p_period = 'weekly' then
    since_time := now() - interval '7 days';
  elsif p_period = 'monthly' then
    since_time := now() - interval '30 days';
  else
    since_time := '-infinity'::timestamptz;
  end if;

  return query
  with episode_totals as (
    select events.user_id, count(*)::bigint as episode_count
    from public.watch_events as events
    where events.watched_at >= since_time
    group by events.user_id
  ),
  time_totals as (
    select events.user_id, sum(events.watched_seconds_delta)::bigint as watched_seconds
    from public.playback_progress_events as events
    where events.created_at >= since_time
    group by events.user_id
  ),
  totals as (
    select
      coalesce(episodes.user_id, watch_time.user_id) as user_id,
      coalesce(episodes.episode_count, 0)::bigint as episode_count,
      coalesce(watch_time.watched_seconds, 0)::bigint as watched_seconds
    from episode_totals as episodes
    full outer join time_totals as watch_time using (user_id)
  )
  select
    profiles.id,
    profiles.display_name,
    profiles.avatar_url,
    totals.episode_count,
    totals.watched_seconds,
    row_number() over (
      order by
        case when p_metric = 'watch_time' then totals.watched_seconds else totals.episode_count end desc,
        profiles.display_name asc,
        profiles.id asc
    )
  from totals
  join public.profiles as profiles on profiles.id = totals.user_id
  where profiles.leaderboard_visible = true
    and (totals.episode_count > 0 or totals.watched_seconds > 0)
  order by
    case when p_metric = 'watch_time' then totals.watched_seconds else totals.episode_count end desc,
    profiles.display_name asc,
    profiles.id asc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$function$;

revoke all on function public.get_leaderboard(text, integer, text) from public, anon;
grant execute on function public.get_leaderboard(text, integer, text) to authenticated;
