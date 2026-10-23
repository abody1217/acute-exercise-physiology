-- Optional, connector-driven first-owner setup. No capability or email is seeded.
-- The one-time state is configured separately by the project administrator.
begin;
create table studio_private.bootstrap_state (
  singleton boolean primary key default true check (singleton),
  owner_email text not null check (owner_email = lower(btrim(owner_email)) and length(owner_email) between 3 and 254),
  capability_hash text not null check (capability_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  stage text not null default 'ready' check (stage in ('ready','working','complete')),
  claim_id uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  encrypted_result jsonb,
  check (encrypted_result is null or (jsonb_typeof(encrypted_result) = 'object' and octet_length(encrypted_result::text) <= 8192))
);
revoke all on studio_private.bootstrap_state from public, anon, authenticated, service_role;

create function public.studio_bootstrap_claim(p_capability_hash text, p_claim_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare setup studio_private.bootstrap_state;
begin
  perform pg_advisory_xact_lock(1937012083, 1);
  select * into setup from studio_private.bootstrap_state where singleton for update;
  if not found or p_claim_id is null or p_capability_hash is distinct from setup.capability_hash
     or setup.expires_at <= now() then
    raise sqlstate 'PT403' using message = 'Setup is unavailable or expired.';
  end if;
  if setup.stage = 'complete' then
    return jsonb_build_object('completed',true,'owner_email',setup.owner_email,'encrypted_result',setup.encrypted_result);
  end if;
  if setup.stage = 'working' then raise sqlstate 'PT409' using message = 'Setup is already running.'; end if;
  if exists(select 1 from public.studio_members) then
    raise sqlstate 'PT409' using message = 'Studio already has members. First-owner setup is disabled.';
  end if;
  update studio_private.bootstrap_state set stage='working',claim_id=p_claim_id,claimed_at=now() where singleton;
  return jsonb_build_object('completed',false,'owner_email',setup.owner_email);
end;
$$;

create function public.studio_bootstrap_finish(p_claim_id uuid,p_user_id uuid,p_encrypted_result jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare setup studio_private.bootstrap_state;
begin
  perform pg_advisory_xact_lock(1937012083, 1);
  select * into setup from studio_private.bootstrap_state where singleton for update;
  if not found or setup.stage <> 'working' or p_claim_id is distinct from setup.claim_id then
    raise sqlstate 'PT409' using message = 'Setup claim is no longer active.';
  end if;
  if exists(select 1 from public.studio_members) then
    raise sqlstate 'PT409' using message = 'Studio already has members. First-owner setup is disabled.';
  end if;
  if not exists(select 1 from auth.users where id=p_user_id and lower(email)=setup.owner_email and not coalesce(is_anonymous,false)) then
    raise sqlstate 'PT400' using message = 'The generated account does not match the configured owner.';
  end if;
  if p_encrypted_result is null or jsonb_typeof(p_encrypted_result) <> 'object'
     or jsonb_typeof(p_encrypted_result->'iv') is distinct from 'string'
     or jsonb_typeof(p_encrypted_result->'ciphertext') is distinct from 'string'
     or octet_length(p_encrypted_result::text)>8192 then
    raise sqlstate 'PT400' using message = 'Invalid encrypted setup response.';
  end if;
  -- The Auth invitation confirms the account. Until then current_role() denies it.
  insert into public.studio_members(email,role,created_by) values(setup.owner_email,'admin',p_user_id);
  update studio_private.bootstrap_state set stage='complete',completed_at=now(),encrypted_result=p_encrypted_result where singleton;
  return true;
end;
$$;

create function public.studio_bootstrap_release(p_claim_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(1937012083, 1);
  update studio_private.bootstrap_state set stage='ready',claim_id=null,claimed_at=null
    where singleton and stage='working' and claim_id=p_claim_id;
  return found;
end;
$$;

revoke all on function public.studio_bootstrap_claim(text,uuid), public.studio_bootstrap_finish(uuid,uuid,jsonb),
  public.studio_bootstrap_release(uuid) from public, anon, authenticated;
grant execute on function public.studio_bootstrap_claim(text,uuid), public.studio_bootstrap_finish(uuid,uuid,jsonb),
  public.studio_bootstrap_release(uuid) to service_role;
commit;
