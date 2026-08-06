-- ============================================================
-- 20250101000012_scheduler_pg_cron.sql
--
-- Moves scheduled work OFF GitHub Actions and INTO the database.
--
-- Why: the crons ran on GitHub-hosted runners. This is a private repo on a
-- personal account (2,000 free Actions-minutes/month), and the schedules
-- (stake-watcher every 10 min, esports warm every 15 min, a 9-sport warm matrix
-- ~16×/day) burned ~11,700 min/month — 5.8× the allowance, exhausted in ~5 days.
-- After that every run failed with "job was not acquired by Runner", which
-- silently froze cache warming AND stake enforcement. pg_cron has no runner-minute
-- concept and runs inside the database we already pay nothing for.
--
-- Applied live to production on 2026-08-06 via a direct connection; this file
-- exists for reproducibility. It is idempotent (create ... if not exists,
-- cron.schedule upserts by name), so re-applying via `db push` is a safe no-op.
--
-- ── ONE MANUAL STEP for a fresh environment ─────────────────────────────────
-- The HTTP jobs read two secrets from Supabase Vault by NAME. Seed them once
-- (never commit the values):
--
--   select vault.create_secret('<INTERNAL_CRON_SECRET>', 'internal_cron_secret');
--   select vault.create_secret('https://<your-prod-host>', 'app_url');
--
-- Until those exist the pg_net jobs post to a null URL and no-op.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── cache-cleanup — pure SQL, no HTTP. Every 2 hours at :15. ─────────────────
-- Deleting expired cache rows is a database operation; it never needed a runner.
select cron.schedule(
  'cache-cleanup',
  '15 */2 * * *',
  $job$ delete from sports_cache where expires_at < now() $job$
);

-- ── cache-warm — hourly. One async POST per entitled sport. ──────────────────
-- The endpoint skips paths a sport doesn't expose and paths needing a
-- request-specific id, so a generous type list is safe. Budget checks upstream
-- keep this from overspending a metered provider.
select cron.schedule(
  'cache-warm',
  '0 * * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'app_url') || '/api/internal/warm',
    body    := jsonb_build_object('sport', q.sport, 'types', jsonb_build_array('scores','schedule','standings','teams','events')),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_cron_secret')
    )
  )
  from sport_quota q
  where q.entitled = true
  $job$
);

-- ── stake-watcher — every 30 min. ───────────────────────────────────────────
-- Reads on-chain balances (in the app, via viem) and suspends keys whose stake
-- dropped below threshold. This being frozen is the real risk of the CI outage:
-- a staker could withdraw and keep a working paid key until the next audit.
select cron.schedule(
  'stake-watcher',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'app_url') || '/api/internal/refresh-stakes',
    headers := jsonb_build_object(
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_cron_secret')
    )
  )
  $job$
);
