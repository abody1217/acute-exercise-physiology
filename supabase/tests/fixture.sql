-- Isolated PostgreSQL test fixture; never run in a real Supabase project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  is_anonymous boolean default false,
  banned_until timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, storage to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null, metadata jsonb default '{}'::jsonb,
  unique(bucket_id,name)
);
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;

create function public.test_assert(ok boolean, label text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'FAILED: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
create function public.test_denied(statement text, expected_code text, label text) returns void
language plpgsql as $$ begin
  begin execute statement;
  exception when others then
    if sqlstate <> expected_code then raise exception 'FAILED: %: expected %, got % (%)', label, expected_code, sqlstate, sqlerrm; end if;
    raise notice 'PASS: %', label;
    return;
  end;
  raise exception 'FAILED: %: request was allowed', label;
end $$;
