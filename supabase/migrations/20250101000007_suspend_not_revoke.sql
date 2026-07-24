-- ============================================================
-- 20250101000007_suspend_not_revoke.sql
--
-- Three enforcement fixes. All of them tighten security EXCEPT the first, which
-- deliberately makes a punishment reversible — the enforcement is unchanged, the
-- collateral damage is not.
--
-- FIX 1 — unstaking suspends keys instead of destroying them.
--   Dropping below your tier threshold used to set is_active = false and
--   revoked_at = now(), which is permanent. A user who unstaked one token too
--   many lost credentials that may be deployed in production, and re-staking
--   minted DIFFERENT keys — so recovering meant rotating secrets everywhere.
--   That is a punishment out of all proportion to the mistake, and it punished
--   exactly the users who were trying to give us money.
--
--   The gateway already refuses any key whose wallet lacks an active commitment
--   (see commitment_ok below), so cancelling the commitment is by itself
--   sufficient to cut off access. Hard-revoking the key row added nothing to
--   enforcement and everything to the blast radius. Now a breach marks the key
--   suspended, the gateway keeps refusing it, and re-staking reinstates the same
--   key — which is what the gateway's own "re-stake to reactivate" message has
--   been promising all along.
--
--   Deliberately unchanged: a user who revokes a key themselves still destroys
--   it permanently. That one is intentional and should not come back.
--
-- FIX 2 — a commitment now only backs keys belonging to the SAME account.
--   commitment_ok matched on wallet alone. Two Privy accounts linked to one
--   wallet would therefore both hold live keys off a single stake, each with its
--   own rate-limit bucket. Privy may refuse to link one wallet twice, but our
--   paywall should not depend on a third party's uniqueness rule to hold.
--
-- FIX 3 — the stake audit no longer stops protecting past 200 stakers.
--   commitments_to_audit was `order by locked_at asc limit 200` with no cursor,
--   and nothing in the audit changed that ordering. At 201 active commitments the
--   201st would never be audited — a security control that fails silently at
--   precisely the moment the product succeeds. It now orders by least-recently-
--   audited, so every commitment comes round.
-- ============================================================

-- ── Schema ──────────────────────────────────────────────────────────────────
alter table api_keys add column if not exists suspended_at   timestamptz;
alter table api_keys add column if not exists suspend_reason text;

create index if not exists idx_api_keys_suspended
  on api_keys(suspended_at) where suspended_at is not null;

alter table stake_commitments add column if not exists last_audited_at timestamptz;

create index if not exists idx_commitment_audit
  on stake_commitments(last_audited_at nulls first) where status = 'active';

-- ── Backfill the account binding FIX 2 depends on ───────────────────────────
-- Commitments created before this migration may have a null privy_id. Requiring
-- a match without backfilling would refuse every existing paid key. Any row that
-- is still null afterwards has no key to bind to, and rebinds on the owner's next
-- dashboard visit when verify-stake upserts it with the right account.
update stake_commitments c
set privy_id = k.privy_id
from api_keys k
where c.privy_id is null
  and k.privy_id is not null
  and lower(k.wallet) = lower(c.wallet);

update stake_commitments c
set privy_id = s.privy_id
from staker_sessions s
where c.privy_id is null
  and s.privy_id is not null
  and lower(s.wallet) = lower(c.wallet);

-- ── Suspend, rather than revoke, on a broken commitment ─────────────────────
create or replace function suspend_keys_for_wallet(p_wallet text, p_reason text)
returns int
language plpgsql security definer
as $$
declare
  affected int;
begin
  -- The key row survives intact. Access is cut by the commitment going inactive,
  -- which the gateway checks on every request; suspended_at exists so the
  -- dashboard can say *why* and so reinstatement has something to clear.
  update api_keys
  set suspended_at   = coalesce(suspended_at, now()),
      suspend_reason = p_reason
  where lower(wallet) = lower(p_wallet)
    and is_active   = true
    and revoked_at  is null
    -- Sandbox keys are free and carry no stake requirement, so they survive.
    and is_sandbox  = false
    and suspended_at is null;

  get diagnostics affected = row_count;

  update stake_commitments
  set status        = 'cancelled',
      cancelled_at  = now(),
      cancel_reason = p_reason
  where lower(wallet) = lower(p_wallet)
    and status = 'active';

  return affected;
end;
$$;

-- Called when a stake returns to a qualifying level.
create or replace function reinstate_keys_for_wallet(p_wallet text)
returns int
language plpgsql security definer
as $$
declare
  affected int;
begin
  update api_keys
  set suspended_at   = null,
      suspend_reason = null
  where lower(wallet) = lower(p_wallet)
    and is_active    = true
    and revoked_at   is null
    and suspended_at is not null;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- ── Key verification ────────────────────────────────────────────────────────
drop function if exists verify_api_key(text);

create or replace function verify_api_key(raw_key text)
returns table (
  key_id             uuid,
  user_id            uuid,
  privy_id           text,
  wallet             text,
  tier               text,
  sport_mask         text[],
  is_sandbox         boolean,
  commitment_ok      boolean,
  suspended          boolean
)
language sql
security definer
stable
as $$
  select
    k.id,
    k.user_id,
    k.privy_id,
    k.wallet,
    k.tier,
    k.sport_mask,
    k.is_sandbox,
    -- Sandbox keys carry no stake requirement, so they are always compliant.
    -- Paid keys require a live commitment for the same wallet AND the same
    -- account — see FIX 2. Matching on wallet alone let one stake back the keys
    -- of every account that linked that wallet.
    case
      when k.is_sandbox then true
      when k.tier = 'scout' then true
      else exists (
        select 1 from stake_commitments c
        where lower(c.wallet) = lower(k.wallet)
          and c.status   = 'active'
          and c.privy_id = k.privy_id
      )
    end as commitment_ok,
    (k.suspended_at is not null) as suspended
  from api_keys k
  where k.key_hash = encode(digest(raw_key, 'sha256'), 'hex')
    and k.is_active = true
    and k.revoked_at is null
  limit 1;
$$;

-- ── Stake-watcher support ───────────────────────────────────────────────────
drop function if exists commitments_to_audit(int);

create or replace function commitments_to_audit(p_limit int default 200)
returns table (
  wallet          text,
  tier            text,
  required        numeric,
  locked_at       timestamptz,
  unlock_at       timestamptz,
  last_audited_at timestamptz
)
language sql
security definer
stable
as $$
  select c.wallet, c.tier, c.required, c.locked_at, c.unlock_at, c.last_audited_at
  from stake_commitments c
  where c.status = 'active'
    and c.tier <> 'scout'
  -- Least-recently-audited first, never-audited before that. Combined with the
  -- watcher stamping last_audited_at, every commitment is reached in ceil(n/200)
  -- runs instead of the oldest 200 being re-checked forever.
  order by c.last_audited_at asc nulls first, c.locked_at asc
  limit p_limit;
$$;

-- Stamps the audit clock. Separate from the balance update so a compliant wallet
-- and a breached one both advance the queue.
create or replace function mark_commitment_audited(p_wallet text, p_staked numeric)
returns void
language sql
security definer
as $$
  update stake_commitments
  set last_audited_at = now(),
      staked_amount   = p_staked
  where lower(wallet) = lower(p_wallet)
    and status = 'active';
$$;

-- ── Commitments are bound to one account ────────────────────────────────────
drop function if exists upsert_commitment(text, text, text, numeric, numeric, int);

create or replace function upsert_commitment(
  p_wallet   text,
  p_privy_id text,
  p_tier     text,
  p_staked   numeric,
  p_required numeric,
  p_lock_days int
)
returns table (locked_at timestamptz, unlock_at timestamptz, is_new boolean, conflict boolean)
language plpgsql security definer
as $$
declare
  existing stake_commitments%rowtype;
begin
  select * into existing
  from stake_commitments
  where lower(wallet) = lower(p_wallet) and status = 'active'
  limit 1;

  -- FIX 2, at the write end: a wallet's stake backs exactly one account. Without
  -- this, account B could point at account A's staked wallet and be handed the
  -- same tier — one stake, two sets of keys, two rate-limit buckets.
  if found and existing.privy_id is not null and existing.privy_id <> p_privy_id then
    return query select existing.locked_at, existing.unlock_at, false, true;
    return;
  end if;

  if found and existing.tier = p_tier then
    -- Same tier, still active: refresh the observed balance only.
    update stake_commitments
    set staked_amount = p_staked,
        -- Claim an unbound legacy row for this account on first sight.
        privy_id      = coalesce(privy_id, p_privy_id)
    where id = existing.id;
    return query select existing.locked_at, existing.unlock_at, false, false;
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
  returning stake_commitments.locked_at, stake_commitments.unlock_at, true, false;
end;
$$;
