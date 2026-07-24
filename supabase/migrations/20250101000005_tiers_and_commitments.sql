-- ============================================================
-- 20250101000005_tiers_and_commitments.sql
--
-- Repricing + commitment tracking + sandbox keys.
--
--   scout    free        no commitment   sandbox data only
--   analyst  1,000,000   7-day           live data
--   oracle  20,000,000  30-day           live data + reward eligibility
--
-- The deployed staking contract has no lock-up (withdraw() is always callable),
-- so commitments are enforced here instead: a stake_commitments row records what
-- was promised, and if the on-chain balance later drops below the tier threshold
-- we revoke that wallet's keys. Cancelling early costs the API — which is the
-- intended deal, and needs no contract redeployment.
-- ============================================================

-- ── Sandbox keys ────────────────────────────────────────────────────────────
-- Scout keys serve synthetic data and never reach the upstream provider.
alter table api_keys add column if not exists is_sandbox boolean not null default false;

create index if not exists idx_api_keys_sandbox on api_keys(is_sandbox) where is_sandbox = true;

-- ── Commitments ─────────────────────────────────────────────────────────────
create table if not exists stake_commitments (
  id            uuid primary key default gen_random_uuid(),
  wallet        text not null,
  privy_id      text,
  tier          text not null check (tier in ('scout','analyst','oracle')),
  -- Balance observed on-chain when the commitment was opened, in whole DARE.
  staked_amount numeric(38, 0) not null default 0,
  -- Threshold that must hold for the commitment to stay valid.
  required      numeric(38, 0) not null default 0,
  locked_at     timestamptz not null default now(),
  unlock_at     timestamptz,
  status        text not null default 'active'
                  check (status in ('active','completed','cancelled')),
  cancelled_at  timestamptz,
  -- Why it ended, for support and audit.
  cancel_reason text,
  created_at    timestamptz not null default now()
);

-- One active commitment per wallet; history is retained.
create unique index if not exists idx_commitment_active_wallet
  on stake_commitments(wallet) where status = 'active';
create index if not exists idx_commitment_wallet  on stake_commitments(wallet);
create index if not exists idx_commitment_unlock  on stake_commitments(unlock_at) where status = 'active';

alter table stake_commitments enable row level security;

drop policy if exists "commitments: read own" on stake_commitments;
create policy "commitments: read own"
  on stake_commitments for select
  using (privy_id = auth.uid()::text);

-- ── Revoke a wallet's keys when its stake no longer qualifies ────────────────
-- Called by the stake-verification path. Returns the number of keys revoked so
-- the caller can report it back to the user.
create or replace function revoke_keys_for_wallet(p_wallet text, p_reason text)
returns int
language plpgsql security definer
as $$
declare
  revoked int;
begin
  update api_keys
  set is_active  = false,
      revoked_at = now()
  where lower(wallet) = lower(p_wallet)
    and is_active = true
    -- Sandbox keys are free and carry no stake requirement, so they survive.
    and is_sandbox = false;

  get diagnostics revoked = row_count;

  update stake_commitments
  set status        = 'cancelled',
      cancelled_at  = now(),
      cancel_reason = p_reason
  where lower(wallet) = lower(p_wallet)
    and status = 'active';

  return revoked;
end;
$$;

-- ── Open or refresh a commitment ────────────────────────────────────────────
-- Idempotent: re-verifying an unchanged stake keeps the original locked_at, so a
-- user cannot silently restart their own commitment window by re-checking.
create or replace function upsert_commitment(
  p_wallet   text,
  p_privy_id text,
  p_tier     text,
  p_staked   numeric,
  p_required numeric,
  p_lock_days int
)
returns table (locked_at timestamptz, unlock_at timestamptz, is_new boolean)
language plpgsql security definer
as $$
declare
  existing stake_commitments%rowtype;
begin
  select * into existing
  from stake_commitments
  where lower(wallet) = lower(p_wallet) and status = 'active'
  limit 1;

  if found and existing.tier = p_tier then
    -- Same tier, still active: refresh the observed balance only.
    update stake_commitments
    set staked_amount = p_staked
    where id = existing.id;
    return query select existing.locked_at, existing.unlock_at, false;
    return;
  end if;

  if found then
    -- Tier changed. Close the old commitment and open a new window.
    update stake_commitments
    set status = 'completed', cancelled_at = now(), cancel_reason = 'tier change'
    where id = existing.id;
  end if;

  return query
  insert into stake_commitments (wallet, privy_id, tier, staked_amount, required, locked_at, unlock_at)
  values (
    lower(p_wallet), p_privy_id, p_tier, p_staked, p_required, now(),
    case when p_lock_days > 0 then now() + (p_lock_days || ' days')::interval else null end
  )
  returning stake_commitments.locked_at, stake_commitments.unlock_at, true;
end;
$$;

-- ── Tier reference, for the dashboard and docs ──────────────────────────────
create table if not exists tier_config (
  tier          text primary key check (tier in ('scout','analyst','oracle')),
  required_dare numeric(38, 0) not null,
  lock_days     int  not null default 0,
  rpm           int  not null,
  sandbox       boolean not null default false,
  realtime      boolean not null default false,
  rewards       boolean not null default false
);

insert into tier_config (tier, required_dare, lock_days, rpm, sandbox, realtime, rewards) values
  ('scout',            0,  0,  30, true,  false, false),
  ('analyst',   1000000,  7, 120, false, true,  false),
  ('oracle',   20000000, 30, 600, false, true,  true)
on conflict (tier) do update set
  required_dare = excluded.required_dare,
  lock_days     = excluded.lock_days,
  rpm           = excluded.rpm,
  sandbox       = excluded.sandbox,
  realtime      = excluded.realtime,
  rewards       = excluded.rewards;

-- staker_sessions gains the commitment window for display.
alter table staker_sessions add column if not exists unlock_at timestamptz;
