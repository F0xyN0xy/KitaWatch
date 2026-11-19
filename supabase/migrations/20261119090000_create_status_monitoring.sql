-- Private, server-managed uptime history for the public KitaWatch status page.
-- The status tables are intentionally not readable from anon/authenticated clients.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema net;

create table if not exists public.status_monitor_samples (
  id bigint generated always as identity primary key,
  monitor_id text not null,
  monitor_name text not null,
  description text not null default '',
  status text not null check (status in ('operational', 'degraded', 'outage', 'paused', 'unknown')),
  response_time_ms numeric,
  sampled_at timestamptz not null,
  constraint status_monitor_samples_monitor_time_key unique (monitor_id, sampled_at)
);

create index if not exists status_monitor_samples_sampled_at_idx
  on public.status_monitor_samples (sampled_at desc);
create index if not exists status_monitor_samples_monitor_time_idx
  on public.status_monitor_samples (monitor_id, sampled_at desc);

create table if not exists public.status_monitor_current (
  monitor_id text primary key,
  monitor_name text not null,
  description text not null default '',
  status text not null check (status in ('operational', 'degraded', 'outage', 'paused', 'unknown')),
  response_time_ms numeric,
  sampled_at timestamptz not null
);

create table if not exists public.status_monitor_incidents (
  id bigint generated always as identity primary key,
  monitor_id text not null,
  monitor_name text not null,
  severity text not null check (severity in ('degraded', 'outage')),
  details text not null,
  started_at timestamptz not null,
  resolved_at timestamptz
);

create index if not exists status_monitor_incidents_started_at_idx
  on public.status_monitor_incidents (started_at desc);
create index if not exists status_monitor_incidents_open_idx
  on public.status_monitor_incidents (monitor_id, started_at desc)
  where resolved_at is null;

alter table public.status_monitor_samples enable row level security;
alter table public.status_monitor_current enable row level security;
alter table public.status_monitor_incidents enable row level security;

revoke all on table public.status_monitor_samples from public, anon, authenticated;
revoke all on table public.status_monitor_current from public, anon, authenticated;
revoke all on table public.status_monitor_incidents from public, anon, authenticated;
grant all on table public.status_monitor_samples to service_role;
grant all on table public.status_monitor_current to service_role;
grant all on table public.status_monitor_incidents to service_role;

create or replace function public.record_status_monitor_snapshot(p_monitors jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := date_trunc('minute', clock_timestamp());
  v_monitor jsonb;
  v_monitor_id text;
  v_monitor_name text;
  v_description text;
  v_status text;
  v_response_time numeric;
  v_previous_status text;
  v_recorded integer := 0;
begin
  if jsonb_typeof(p_monitors) <> 'array' then
    raise exception 'p_monitors must be a JSON array';
  end if;

  if jsonb_array_length(p_monitors) < 1 or jsonb_array_length(p_monitors) > 200 then
    raise exception 'p_monitors must contain between 1 and 200 monitors';
  end if;

  for v_monitor in select value from jsonb_array_elements(p_monitors)
  loop
    v_monitor_id := nullif(v_monitor ->> 'id', '');
    v_monitor_name := coalesce(nullif(v_monitor ->> 'name', ''), 'Unnamed monitor');
    v_description := coalesce(v_monitor ->> 'description', '');
    v_status := lower(coalesce(v_monitor ->> 'status', 'unknown'));
    v_response_time := nullif(v_monitor ->> 'latencyMs', '')::numeric;

    if v_monitor_id is null then
      raise exception 'Every monitor must have an id';
    end if;

    if v_status not in ('operational', 'degraded', 'outage', 'paused', 'unknown') then
      raise exception 'Invalid status value for monitor %', v_monitor_id;
    end if;

    select c.status
      into v_previous_status
      from public.status_monitor_current as c
      where c.monitor_id = v_monitor_id
      for update;

    insert into public.status_monitor_samples (
      monitor_id, monitor_name, description, status, response_time_ms, sampled_at
    ) values (
      v_monitor_id, v_monitor_name, v_description, v_status, v_response_time, v_now
    )
    on conflict (monitor_id, sampled_at) do update
      set monitor_name = excluded.monitor_name,
          description = excluded.description,
          status = excluded.status,
          response_time_ms = excluded.response_time_ms;

    if v_status in ('degraded', 'outage')
       and coalesce(v_previous_status, '') not in ('degraded', 'outage') then
      insert into public.status_monitor_incidents (
        monitor_id, monitor_name, severity, details, started_at
      ) values (
        v_monitor_id,
        v_monitor_name,
        v_status,
        case when v_status = 'outage'
          then 'The monitor reported that the service was down.'
          else 'The monitor reported a degraded service state.'
        end,
        v_now
      );
    elsif v_status = 'operational'
       and v_previous_status in ('degraded', 'outage') then
      update public.status_monitor_incidents
        set resolved_at = v_now
        where id = (
          select i.id
          from public.status_monitor_incidents as i
          where i.monitor_id = v_monitor_id
            and i.resolved_at is null
          order by i.started_at desc
          limit 1
        );
    end if;

    insert into public.status_monitor_current (
      monitor_id, monitor_name, description, status, response_time_ms, sampled_at
    ) values (
      v_monitor_id, v_monitor_name, v_description, v_status, v_response_time, v_now
    )
    on conflict (monitor_id) do update
      set monitor_name = excluded.monitor_name,
          description = excluded.description,
          status = excluded.status,
          response_time_ms = excluded.response_time_ms,
          sampled_at = excluded.sampled_at;

    v_recorded := v_recorded + 1;
    v_previous_status := null;
  end loop;

  delete from public.status_monitor_samples
    where sampled_at < v_now - interval '30 days';

  delete from public.status_monitor_incidents
    where started_at < v_now - interval '30 days'
      and resolved_at is not null;

  return jsonb_build_object('recorded', v_recorded, 'sampledAt', v_now);
end;
$$;

create or replace function public.get_status_page_data()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with sample_stats as (
    select
      s.monitor_id,
      count(*) filter (where s.status in ('operational', 'degraded', 'outage')) as valid_samples,
      count(*) filter (where s.status = 'operational') as operational_samples,
      count(*) filter (where s.status in ('degraded', 'outage')) as downtime_samples
    from public.status_monitor_samples as s
    where s.sampled_at >= now() - interval '30 days'
    group by s.monitor_id
  ),
  service_rows as (
    select
      c.monitor_id,
      c.monitor_name,
      c.description,
      case when c.sampled_at < now() - interval '15 minutes' then 'unknown' else c.status end as status,
      c.response_time_ms,
      c.sampled_at,
      case
        when coalesce(st.valid_samples, 0) = 0 then null
        else round(100.0 * st.operational_samples / st.valid_samples, 2)
      end as uptime_30d,
      coalesce(st.downtime_samples, 0) * 300 as estimated_downtime_seconds_30d,
      (
        select count(*)
        from public.status_monitor_incidents as i
        where i.monitor_id = c.monitor_id
          and i.started_at >= now() - interval '30 days'
      ) as incident_count_30d
    from public.status_monitor_current as c
    left join sample_stats as st on st.monitor_id = c.monitor_id
  ),
  daily_stats as (
    select
      s.monitor_id,
      (s.sampled_at at time zone 'UTC')::date as sample_day,
      count(*) filter (where s.status in ('operational', 'degraded', 'outage')) as valid_samples,
      count(*) filter (where s.status = 'operational') as operational_samples,
      count(*) filter (where s.status = 'degraded') as degraded_samples,
      count(*) filter (where s.status = 'outage') as outage_samples
    from public.status_monitor_samples as s
    where s.sampled_at >= now() - interval '30 days'
    group by s.monitor_id, (s.sampled_at at time zone 'UTC')::date
  ),
  daily_json as (
    select
      d.monitor_id,
      jsonb_agg(
        jsonb_build_object(
          'date', to_char(d.sample_day, 'YYYY-MM-DD'),
          'status', case
            when d.outage_samples > 0 then 'outage'
            when d.degraded_samples > 0 then 'degraded'
            when d.operational_samples > 0 then 'operational'
            else 'unknown'
          end,
          'uptime', case
            when d.valid_samples = 0 then null
            else round(100.0 * d.operational_samples / d.valid_samples, 2)
          end,
          'sampleCount', d.valid_samples
        )
        order by d.sample_day
      ) as days
    from daily_stats as d
    group by d.monitor_id
  ),
  incident_rows as (
    select i.*
    from public.status_monitor_incidents as i
    where i.started_at >= now() - interval '30 days'
       or i.resolved_at is null
    order by i.started_at desc
    limit 12
  )
  select jsonb_build_object(
    'generatedAt', (select max(c.sampled_at) from public.status_monitor_current as c),
    'overall', (
      select case
        when count(*) = 0 then 'unknown'
        when bool_and(c.status = 'operational') then 'operational'
        when bool_or(c.status = 'outage') then 'outage'
        when bool_or(c.status = 'degraded') then 'degraded'
        else 'unknown'
      end
      from service_rows as c
    ),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.monitor_id,
        'name', s.monitor_name,
        'description', s.description,
        'status', s.status,
        'latencyMs', s.response_time_ms,
        'uptime30d', s.uptime_30d,
        'downtimeSeconds30d', s.estimated_downtime_seconds_30d,
        'incidentCount30d', s.incident_count_30d
      ) order by s.monitor_name)
      from service_rows as s
    ), '[]'::jsonb),
    'current', coalesce((
      select jsonb_object_agg(s.monitor_id, jsonb_build_object(
        'status', s.status,
        'latencyMs', s.response_time_ms,
        'sampledAt', s.sampled_at
      ))
      from service_rows as s
    ), '{}'::jsonb),
    'dailyHistory', coalesce((
      select jsonb_object_agg(d.monitor_id, d.days)
      from daily_json as d
    ), '{}'::jsonb),
    'incidents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id::text,
        'serviceId', i.monitor_id,
        'title', i.monitor_name || ' experienced a ' || i.severity,
        'description', i.details,
        'startedAt', i.started_at,
        'resolvedAt', i.resolved_at
      ) order by i.started_at desc)
      from incident_rows as i
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.record_status_monitor_snapshot(jsonb) from public, anon, authenticated;
revoke all on function public.get_status_page_data() from public, anon, authenticated;
grant execute on function public.record_status_monitor_snapshot(jsonb) to service_role;
grant execute on function public.get_status_page_data() to service_role;
