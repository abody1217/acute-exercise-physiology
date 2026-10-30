-- Permit immutable replacement originals while retaining existing object paths.
-- Browser creation/upload rules still use original.<format>; versioned files
-- are uploaded only by a narrowly scoped server-side maintenance operation.
begin;
alter table public.presentations drop constraint presentations_check;
alter table public.presentations add constraint presentations_original_path_check
  check (
    original_path = id::text || '/original.' || format
    or original_path ~ ('^' || id::text || '/original-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.' || format || '$')
  );
commit;
