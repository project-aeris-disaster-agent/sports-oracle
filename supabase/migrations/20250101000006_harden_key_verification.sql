-- ============================================================
-- 20250101000006_harden_key_verification.sql
--
-- Closes two exploits in key verification.
--
-- EXPLOIT A — rate-limit bypass by minting keys.
--   The gateway rate-limits on key_id. Nothing stops one account minting ten
--   keys and running ten times its tier's limit. verify_api_key now returns the
--   owning privy_id so the limiter can bucket per ACCOUNT instead of per key.
--
-- EXPLOIT B — access surviving an unstake.
--   Keys were only revoked when the user happened to call verify-stake. An
--   attacker could stake, mint an Analyst key, unstake in the same minute and
--   keep querying live data indefinitely, because nothing re-checked. The RPC now
--   reports whether the key's wallet still holds an active commitment, so the
--   gateway can reject a key whose stake has been withdrawn.
--
--   The commitment row is kept honest by the stake watcher
--   (POST /api/internal/refresh-stakes), which re-reads balances on a schedule.
-- ============================================================

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
  commitment_ok      boolean
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
    -- Paid keys require a live commitment for the same wallet.
    case
      when k.is_sandbox then true
      when k.tier = 'scout' then true
      else exists (
        select 1 from stake_commitments c
        where lower(c.wallet) = lower(k.wallet)
          and c.status = 'active'
      )
    end as commitment_ok
  from api_keys k
  where k.key_hash = encode(digest(raw_key, 'sha256'), 'hex')
    and k.is_active = true
    and k.revoked_at is null
  limit 1;
$$;

-- ── Stake-watcher support ───────────────────────────────────────────────────
-- Returns every wallet with an active paid commitment so the watcher can
-- re-read balances on-chain and revoke any that no longer qualify.
create or replace function commitments_to_audit(p_limit int default 200)
returns table (
  wallet    text,
  tier      text,
  required  numeric,
  locked_at timestamptz,
  unlock_at timestamptz
)
language sql
security definer
stable
as $$
  select c.wallet, c.tier, c.required, c.locked_at, c.unlock_at
  from stake_commitments c
  where c.status = 'active'
    and c.tier <> 'scout'
  order by c.locked_at asc
  limit p_limit;
$$;
