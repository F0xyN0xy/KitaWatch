-- Run this only after storing STATUS_COLLECTOR_TOKEN in Supabase Vault
-- under the secret name: kitawatch_status_collector_token.
-- Re-running cron.schedule with the same job name updates the existing job.

select cron.schedule(
  'kitawatch-status-collector',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := 'https://kitawatch-status-api.onrender.com/api/collect',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'kitawatch_status_collector_token'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 15000
    );
  $job$
);
