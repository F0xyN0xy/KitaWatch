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
  five_minute_seconds bigint;
  one_hour_seconds bigint;
  oldest_five_minute_event timestamptz;
  five_minute_budget bigint;
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

  -- Serialize writes per account so concurrent player sessions cannot each
  -- spend an independent copy of the same user's watch-time allowance.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_user_id::text, 0)
  );

  insert into public.playback_progress_events (
    user_id, client_event_id, session_id, anime_id, episode_number,
    position_seconds, watched_seconds_delta, episode_duration_seconds
  ) values (
    current_user_id, p_client_event_id, p_session_id, p_anime_id, p_episode_number,
    p_position_seconds, p_watched_seconds_delta, p_episode_duration_seconds
  )
  on conflict (user_id, client_event_id) do nothing
  returning id into inserted_event_id;

  -- A retry after a lost response is idempotent and does not spend the budget
  -- a second time.
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

  -- Count every session for this account. The short rolling window prevents
  -- a client from submitting many intervals immediately. Both limits
  -- allow up to 2x media-time credit for the built-in playback-speed control.
  select
    (count(*) filter (
      where events.created_at > now() - interval '1 hour'
    ))::integer,
    coalesce(sum(events.watched_seconds_delta) filter (
      where events.created_at > now() - interval '5 minutes'
    ), 0)::bigint,
    min(events.created_at) filter (
      where events.created_at > now() - interval '5 minutes'
    ),
    coalesce(sum(events.watched_seconds_delta) filter (
      where events.created_at > now() - interval '1 hour'
    ), 0)::bigint
  into
    recent_event_count,
    five_minute_seconds,
    oldest_five_minute_event,
    one_hour_seconds
  from public.playback_progress_events as events
  where events.user_id = current_user_id;

  if recent_event_count > 600 then
    raise exception 'Playback progress request limit reached' using errcode = 'P0001';
  end if;

  five_minute_budget := least(
    630::bigint,
    greatest(
      30::bigint,
      floor(extract(epoch from (now() - oldest_five_minute_event)) * 2)::bigint + 30
    )
  );

  if five_minute_seconds > five_minute_budget then
    raise exception 'Playback progress exceeds the 2x five-minute allowance'
      using errcode = 'P0001';
  end if;

  if one_hour_seconds > 7230 then
    raise exception 'Playback progress exceeds the 2x hourly watch-time allowance'
      using errcode = 'P0001';
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
