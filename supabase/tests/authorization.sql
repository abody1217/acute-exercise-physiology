insert into auth.users(id,email,email_confirmed_at) values
 ('11111111-1111-4111-8111-111111111111','owner@example.test',now()),
 ('22222222-2222-4222-8222-222222222222','editor@example.test',now()),
 ('33333333-3333-4333-8333-333333333333','outsider@example.test',now()),
 ('44444444-4444-4444-8444-444444444444','unverified@example.test',null),
 ('55555555-5555-4555-8555-555555555555','other-admin@example.test',now());
insert into public.studio_members(email,role) values
 ('owner@example.test','admin'),('editor@example.test','editor'),('unverified@example.test','admin');

set role anon;
select public.test_denied('select * from public.presentations','42501','anonymous cannot read presentations');
select public.test_denied('select public.studio_identity()','42501','anonymous cannot call membership RPC');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.test_assert(public.studio_identity() is null,'outsider has no role');
select public.test_assert((select count(*) = 0 from public.presentations),'outsider sees no presentations');
select public.test_denied($q$insert into public.studio_members(email,role) values('outsider@example.test','admin')$q$,'42501','cannot grant own membership');
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
select public.test_assert(public.studio_identity() is null,'unverified allowlisted admin has no access');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.test_assert(public.studio_identity()->>'role' = 'admin','verified owner is admin');

insert into storage.objects(bucket_id,name) values('studio-originals','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/original.html');
select public.test_assert((public.create_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Test deck','test.html',43,'html','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/original.html')).revision=0,'admin creates presentation after upload');
select public.test_denied($q$select public.create_presentation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Missing','missing.pdf',1,'pdf','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/original.pdf')$q$,'PT400','cannot create a presentation without original file');
select public.test_denied($q$insert into storage.objects(bucket_id,name) values('studio-originals','invalid/path.html')$q$,'42501','storage restricts original path');
with removed as (delete from storage.objects where name='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/original.html' returning id) select public.test_assert(count(*)=0,'cannot delete an original referenced by a live presentation') from removed;

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.test_assert((select count(*)=1 from public.presentations),'editor can read presentation');
select public.test_denied($q$select public.create_presentation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','No','no.html',1,'html','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/original.html')$q$,'PT403','editor cannot create presentation');
select public.test_denied($q$update public.presentations set title='changed'$q$,'42501','editor cannot bypass revision RPC');
select public.test_denied($q$insert into storage.objects(bucket_id,name) values('studio-originals','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/original.html')$q$,'42501','editor cannot upload originals');
insert into storage.objects(bucket_id,name) values('studio-images','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999.png');
select public.test_denied($q$insert into storage.objects(bucket_id,name) values('studio-images','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/99999999-9999-4999-8999-999999999999.png')$q$,'42501','editor cannot upload images for missing deck');
with updated as (update storage.objects set metadata='{"modified":true}' where bucket_id='studio-images' returning id) select public.test_assert(count(*)=0,'existing images cannot be overwritten') from updated;

select public.test_assert((public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '{"s01-e0001-t0":{"text":"<script>Literal text</script>"},"s01-e0002-i":{"asset":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999.png","alt":"Replacement"},"s01-e0001-m":{"effect":"fade","duration":500,"delay":0}}',0)).revision=1,'valid edit advances revision');
select public.test_denied($q$select public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{}',0)$q$,'PT409','stale save is rejected');
select public.test_assert((select revision=1 and patches->'s01-e0001-t0'->>'text'='<script>Literal text</script>' from public.presentations),'stale save did not overwrite data');
select public.test_denied($q$select public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"s01-e0002-i":{"src":"data:image/png;base64,aaaa","alt":"No"}}',1)$q$,'PT400','database rejects embedded image URLs');
select public.test_denied($q$select public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"s01-e0002-i":{"asset":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/99999999-9999-4999-8999-999999999999.png","alt":"No"}}',1)$q$,'PT400','image reference cannot cross decks');
select public.test_denied($q$select public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"s01-e0002-i":{"asset":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/88888888-8888-4888-8888-888888888888.png","alt":"Missing"}}',1)$q$,'PT400','image must be uploaded before save');
select public.test_denied($q$select public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"s01-e0001-m":{"effect":"fade","delay":0}}',1)$q$,'PT400','motion requires duration');
select public.test_denied($q$select public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"__proto__":{"text":"No"}}',1)$q$,'PT400','unsafe item key rejected');
select public.test_denied($q$select public.studio_manage_member('11111111-1111-4111-8111-111111111111','outsider@example.test','invite','admin')$q$,'42501','user cannot spoof actor on service-only RPC');
select public.test_denied($q$select public.delete_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1)$q$,'PT403','editor cannot delete presentation');

reset role;
set role service_role;
select public.test_denied($q$select public.studio_manage_member('22222222-2222-4222-8222-222222222222','outsider@example.test','invite','admin')$q$,'PT403','service RPC independently checks actor membership');
select public.test_denied($q$select public.studio_manage_member('11111111-1111-4111-8111-111111111111','owner@example.test','revoke',null)$q$,'PT400','admin cannot revoke self');
select public.test_assert(public.studio_manage_member('11111111-1111-4111-8111-111111111111','other-admin@example.test','invite','admin')->>'role'='admin','admin can grant admin role explicitly');
select public.test_denied($q$select public.studio_manage_member('11111111-1111-4111-8111-111111111111','editor@example.test','invite','admin')$q$,'PT409','reinvite cannot silently change existing role');
select public.test_assert(public.studio_manage_member('11111111-1111-4111-8111-111111111111','editor@example.test','revoke',null)->>'role' is null,'admin can revoke editor');
select public.test_assert((select count(*)=2 from public.studio_access_audit),'successful membership changes are audited');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.test_assert((select count(*)=0 from public.presentations),'revocation blocks an existing session');
select public.test_assert((select count(*)=0 from storage.objects),'revocation blocks file reads');
select public.test_denied($q$select public.save_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{}',1)$q$,'PT403','revoked user cannot save');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.test_assert((public.delete_presentation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1)).id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin deletion returns removed metadata');
with removed as (delete from storage.objects returning id) select public.test_assert(count(*)=2,'admin can clean orphan files after deletion') from removed;
reset role;
