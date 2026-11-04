-- Add an explicit privacy opt-in for public leaderboard participation.
-- Anonymous Supabase users still use the authenticated database role, so they
-- can read their own profile and call the existing authenticated leaderboard RPC.

alter table public.profiles
  add column if not exists leaderboard_visible boolean not null default false;

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Visible profiles and own profile are readable"
  on public.profiles
  for select
  to anon, authenticated
  using (
    id = (select auth.uid())
    or leaderboard_visible = true
  );

-- The client may change only the opt-in column, not other profile fields.
-- Row-level ownership is enforced by the existing UPDATE policy.
grant update (leaderboard_visible) on table public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  metadata jsonb;
  chosen_name text;
  chosen_avatar text;
begin
  metadata := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  chosen_name := coalesce(
    nullif(left(metadata ->> 'full_name', 80), ''),
    nullif(left(metadata ->> 'name', 80), ''),
    nullif(left(metadata ->> 'user_name', 80), ''),
    case
      when new.is_anonymous then
        'Guest-' || lpad((floor(random() * 1000000))::integer::text, 6, '0')
      else 'KitaWatch user'
    end
  );
  chosen_avatar := coalesce(metadata ->> 'avatar_url', metadata ->> 'picture');
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, chosen_name, chosen_avatar)
  on conflict (id) do nothing;
  return new;
end;
$function$;

create or replace function public.get_leaderboard(
  p_period text default 'weekly',
  p_limit integer default 50
)
returns table(
  user_id uuid,
  display_name text,
  avatar_url text,
  episode_count bigint,
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

  if p_period = 'weekly' then
    since_time := now() - interval '7 days';
  elsif p_period = 'monthly' then
    since_time := now() - interval '30 days';
  else
    since_time := '-infinity'::timestamptz;
  end if;

  return query
  with totals as (
    select e.user_id, count(*)::bigint as total
    from public.watch_events e
    where e.watched_at >= since_time
    group by e.user_id
  )
  select p.id, p.display_name, p.avatar_url, t.total,
         row_number() over (order by t.total desc, p.display_name asc)
  from totals t
  join public.profiles p on p.id = t.user_id
  where p.leaderboard_visible = true
  order by t.total desc, p.display_name asc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$function$;

revoke all on function public.get_leaderboard(text, integer) from public, anon;
grant execute on function public.get_leaderboard(text, integer) to authenticated;
