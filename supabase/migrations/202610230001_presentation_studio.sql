-- Presentation Studio. Run in a dedicated Supabase project as postgres.
-- Only public client keys belong in the Studio. This migration contains no secrets.
begin;

create schema if not exists studio_private;
revoke all on schema studio_private from public, anon, authenticated;
grant usage on schema studio_private to authenticated;

create table public.studio_members (
  email text primary key check (email = lower(btrim(email)) and length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text not null check (role in ('admin', 'editor')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table public.presentations (
  id uuid primary key,
  title text not null check (length(btrim(title)) between 1 and 160),
  original_filename text not null check (length(original_filename) between 1 and 255),
  slide_count integer not null check (slide_count between 1 and 500),
  format text not null check (format in ('html', 'pdf', 'pptx')),
  original_path text not null unique check (original_path = id::text || '/original.' || format),
  cover_path text unique check (cover_path is null or cover_path ~ ('^' || id::text || '/cover\.(png|jpeg|webp)$')),
  patches jsonb not null default '{}'::jsonb check (jsonb_typeof(patches) = 'object' and octet_length(patches::text) <= 2097152),
  revision integer not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create table public.studio_access_audit (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text not null,
  action text not null check (action in ('invite', 'update_role', 'revoke')),
  member_email text not null,
  old_role text,
  new_role text,
  check (old_role is null or old_role in ('admin', 'editor')),
  check (new_role is null or new_role in ('admin', 'editor'))
);

alter table public.studio_members enable row level security;
alter table public.presentations enable row level security;
alter table public.studio_access_audit enable row level security;
revoke all on public.studio_members, public.presentations, public.studio_access_audit from public, anon, authenticated;
grant select on public.presentations to authenticated;
grant all on public.studio_members, public.presentations, public.studio_access_audit to service_role;
grant usage, select on sequence public.studio_access_audit_id_seq to service_role;

-- Always resolve the verified email from auth.users, not editable user_metadata
-- or a potentially stale JWT email claim. Revocation takes effect on the next request.
create function studio_private.current_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role
  from public.studio_members m join auth.users u on m.email = lower(u.email)
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
    and not coalesce(u.is_anonymous, false)
    and (u.banned_until is null or u.banned_until < now())
$$;
revoke all on function studio_private.current_role() from public, anon, authenticated;
grant execute on function studio_private.current_role() to authenticated;

create policy studio_members_read_presentations on public.presentations
for select to authenticated using ((select studio_private.current_role()) in ('admin', 'editor'));

create function public.studio_identity() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('email', m.email, 'role', m.role)
  from public.studio_members m join auth.users u on m.email = lower(u.email)
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
    and not coalesce(u.is_anonymous, false)
    and (u.banned_until is null or u.banned_until < now())
$$;
revoke all on function public.studio_identity() from public, anon, authenticated;
grant execute on function public.studio_identity() to authenticated;

create function studio_private.validate_patches(p_id uuid, p_patches jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  item record;
  v jsonb;
  image_path text;
begin
  if p_patches is null or jsonb_typeof(p_patches) <> 'object' or octet_length(p_patches::text) > 2097152 then
    raise sqlstate 'PT400' using message = 'Changes must be an object no larger than 2 MiB.';
  end if;
  if (select count(*) from jsonb_object_keys(p_patches)) > 5000 then
    raise sqlstate 'PT400' using message = 'Too many changed items (maximum 5,000).';
  end if;
  for item in select key, value from jsonb_each(p_patches) loop
    v := item.value;
    if length(item.key) > 100 or item.key !~ '^s[0-9]{2,}-e[0-9]{4,}-(t[0-9]+|i|m)$'
       or jsonb_typeof(v) is distinct from 'object' then
      raise sqlstate 'PT400' using message = 'Invalid slide item.';
    end if;
    if item.key ~ '-t[0-9]+$' then
      if jsonb_typeof(v->'text') is distinct from 'string' or length(v->>'text') > 10000
         or (v - 'text') <> '{}'::jsonb then
        raise sqlstate 'PT400' using message = 'Text must contain at most 10,000 characters.';
      end if;
    elsif right(item.key, 2) = '-i' then
      if jsonb_typeof(v->'alt') is distinct from 'string' or length(v->>'alt') > 2000
         or (v - 'asset' - 'alt') <> '{}'::jsonb then
        raise sqlstate 'PT400' using message = 'Invalid image description or image properties.';
      end if;
      if v ? 'asset' then
        image_path := v->>'asset';
        if jsonb_typeof(v->'asset') is distinct from 'string' or image_path !~
          ('^' || p_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpeg|webp|gif)$') then
          raise sqlstate 'PT400' using message = 'Image must belong to this presentation.';
        end if;
        if not exists (select 1 from storage.objects where bucket_id = 'studio-images' and name = image_path) then
          raise sqlstate 'PT400' using message = 'Upload the replacement image before saving.';
        end if;
      end if;
    else
      if jsonb_typeof(v->'effect') is distinct from 'string' or (v->>'effect') not in
          ('original','none','fade','up','down','left','right','zoom','pop')
         or jsonb_typeof(v->'duration') is distinct from 'number'
         or jsonb_typeof(v->'delay') is distinct from 'number'
         or (v - 'effect' - 'duration' - 'delay') <> '{}'::jsonb then
        raise sqlstate 'PT400' using message = 'Invalid motion properties.';
      end if;
      if (v->>'duration')::numeric not between 100 and 10000 or (v->>'delay')::numeric not between 0 and 10000 then
        raise sqlstate 'PT400' using message = 'Motion timing is outside the supported range.';
      end if;
    end if;
  end loop;
end;
$$;
revoke all on function studio_private.validate_patches(uuid, jsonb) from public, anon, authenticated;

create function public.create_presentation(
  p_id uuid, p_title text, p_original_filename text, p_slide_count integer,
  p_format text, p_original_path text, p_cover_path text default null
) returns public.presentations
language plpgsql security definer set search_path = '' as $$
declare result public.presentations;
begin
  if studio_private.current_role() is distinct from 'admin' then
    raise sqlstate 'PT403' using message = 'Only an administrator can add presentations.';
  end if;
  if p_id is null or p_format is null or p_format not in ('html', 'pdf', 'pptx')
     or p_original_path is distinct from p_id::text || '/original.' || p_format
     or p_title is null or length(btrim(p_title)) not between 1 and 160
     or p_original_filename is null or length(p_original_filename) not between 1 and 255
     or p_slide_count is null or p_slide_count not between 1 and 500
     or (p_cover_path is not null and p_cover_path !~ ('^' || p_id::text || '/cover\.(png|jpeg|webp)$')) then
    raise sqlstate 'PT400' using message = 'Invalid presentation metadata.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'studio-originals' and name = p_original_path)
     or (p_cover_path is not null and not exists (select 1 from storage.objects where bucket_id = 'studio-covers' and name = p_cover_path)) then
    raise sqlstate 'PT400' using message = 'Upload presentation files before creating the presentation.';
  end if;
  insert into public.presentations(id, title, original_filename, slide_count, format, original_path, cover_path, created_by, updated_by)
  values (p_id, btrim(p_title), p_original_filename, p_slide_count, p_format, p_original_path, p_cover_path, auth.uid(), auth.uid())
  returning * into result;
  return result;
end;
$$;
revoke all on function public.create_presentation(uuid,text,text,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.create_presentation(uuid,text,text,integer,text,text,text) to authenticated;

create function public.save_presentation(p_id uuid, p_patches jsonb, p_expected_revision integer)
returns public.presentations language plpgsql security definer set search_path = '' as $$
declare result public.presentations;
begin
  if coalesce(studio_private.current_role(), '') not in ('admin', 'editor') then
    raise sqlstate 'PT403' using message = 'Your account does not have access to this studio.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise sqlstate 'PT400' using message = 'A valid revision is required.';
  end if;
  select * into result from public.presentations where id = p_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Presentation not found.'; end if;
  if result.revision <> p_expected_revision then
    raise sqlstate 'PT409' using message = 'Another session saved newer changes. Reload before saving.', detail = result.revision::text;
  end if;
  perform studio_private.validate_patches(p_id, p_patches);
  update public.presentations set patches = p_patches, revision = revision + 1,
    updated_at = now(), updated_by = auth.uid() where id = p_id returning * into result;
  return result;
end;
$$;
revoke all on function public.save_presentation(uuid,jsonb,integer) from public, anon, authenticated;
grant execute on function public.save_presentation(uuid,jsonb,integer) to authenticated;

-- Removes metadata first. The caller then removes the private Storage files;
-- remaining orphan files are inaccessible to editors and can be retried by an admin.
create function public.delete_presentation(p_id uuid, p_expected_revision integer)
returns public.presentations language plpgsql security definer set search_path = '' as $$
declare result public.presentations;
begin
  if studio_private.current_role() is distinct from 'admin' then
    raise sqlstate 'PT403' using message = 'Only an administrator can delete presentations.';
  end if;
  select * into result from public.presentations where id = p_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Presentation not found.'; end if;
  if p_expected_revision is null or result.revision <> p_expected_revision then
    raise sqlstate 'PT409' using message = 'The presentation changed. Reload before deleting.';
  end if;
  delete from public.presentations where id = p_id;
  return result;
end;
$$;
revoke all on function public.delete_presentation(uuid,integer) from public, anon, authenticated;
grant execute on function public.delete_presentation(uuid,integer) to authenticated;

-- Service-only RPC used by studio-access after getUser(jwt). It repeats the
-- actor check inside the same locked transaction as the change and audit entry.
create function public.studio_manage_member(p_actor_id uuid, p_email text, p_action text, p_role text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor_email text; target_email text; old_role text; actor_role text;
begin
  perform pg_advisory_xact_lock(1937012083, 1);
  select lower(u.email), m.role into actor_email, actor_role
    from auth.users u join public.studio_members m on m.email = lower(u.email)
    where u.id = p_actor_id and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
      and (u.banned_until is null or u.banned_until < now());
  if actor_role is distinct from 'admin' then raise sqlstate 'PT403' using message = 'Administrator access is required.'; end if;
  target_email := lower(btrim(p_email));
  if target_email is null or length(target_email) not between 3 and 254 or target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_action is null or p_action not in ('invite', 'update_role', 'revoke')
     or (p_action <> 'revoke' and (p_role is null or p_role not in ('admin', 'editor'))) then
    raise sqlstate 'PT400' using message = 'Invalid member request.';
  end if;
  if target_email = actor_email then
    raise sqlstate 'PT400' using message = 'You cannot change or generate access links for your own account here.';
  end if;
  select role into old_role from public.studio_members where email = target_email;
  if p_action = 'invite' and old_role is not null and old_role <> p_role then
    raise sqlstate 'PT409' using message = 'Member already exists with a different role. Change their role explicitly first.';
  end if;
  if p_action in ('update_role', 'revoke') and old_role is null then
    raise sqlstate 'PT404' using message = 'Member not found.';
  end if;
  if old_role = 'admin' and (p_action = 'revoke' or p_role = 'editor')
     and (select count(*) from public.studio_members where role = 'admin') <= 1 then
    raise sqlstate 'PT409' using message = 'The last administrator cannot be removed.';
  end if;
  if p_action = 'revoke' then
    delete from public.studio_members where email = target_email;
  elsif p_action = 'invite' then
    insert into public.studio_members(email,role,created_by) values(target_email,p_role,p_actor_id)
    on conflict (email) do update set updated_at = now();
  else
    update public.studio_members set role = p_role, updated_at = now() where email = target_email;
  end if;
  insert into public.studio_access_audit(actor_id,actor_email,action,member_email,old_role,new_role)
    values(p_actor_id,actor_email,p_action,target_email,old_role,case when p_action = 'revoke' then null else p_role end);
  return jsonb_build_object('email',target_email,'role',case when p_action = 'revoke' then null else p_role end,'action',p_action);
end;
$$;
revoke all on function public.studio_manage_member(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.studio_manage_member(uuid,text,text,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('studio-originals','studio-originals',false,41943040,array['text/html','application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation']),
  ('studio-covers','studio-covers',false,2097152,array['image/png','image/jpeg','image/webp']),
  ('studio-images','studio-images',false,10485760,array['image/png','image/jpeg','image/webp','image/gif']);

create policy studio_read_files on storage.objects for select to authenticated using (
  bucket_id in ('studio-originals','studio-covers','studio-images')
  and (select studio_private.current_role()) in ('admin','editor')
  and ((select studio_private.current_role()) = 'admin' or exists (
    select 1 from public.presentations p where split_part(name,'/',1) = p.id::text
  ))
);
create policy studio_upload_originals on storage.objects for insert to authenticated with check (
  (select studio_private.current_role()) = 'admin' and (
    (bucket_id = 'studio-originals' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original\.(html|pdf|pptx)$') or
    (bucket_id = 'studio-covers' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/cover\.(png|jpeg|webp)$')
  )
);
create policy studio_upload_images on storage.objects for insert to authenticated with check (
  bucket_id = 'studio-images' and (select studio_private.current_role()) in ('admin','editor')
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpeg|webp|gif)$'
  and exists(select 1 from public.presentations p where p.id::text = split_part(name,'/',1))
);
-- No UPDATE policy: originals and replacement images are immutable.
create policy studio_delete_unused_files on storage.objects for delete to authenticated using (
  bucket_id in ('studio-originals','studio-covers','studio-images')
  and (select studio_private.current_role()) = 'admin'
  and not exists (select 1 from public.presentations p where
    (bucket_id = 'studio-originals' and p.original_path = name) or
    (bucket_id = 'studio-covers' and p.cover_path = name) or
    (bucket_id = 'studio-images' and exists(select 1 from jsonb_each(p.patches) item where item.value->>'asset' = name))
  )
);

commit;
