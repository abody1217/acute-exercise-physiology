-- These assertions run only against the disposable PostgreSQL test fixture.
begin;
insert into public.presentations(id,title,original_filename,slide_count,format,original_path)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Versioned original test','original.html',43,'html','cccccccc-cccc-4ccc-8ccc-cccccccccccc/original.html');
update public.presentations set original_path='cccccccc-cccc-4ccc-8ccc-cccccccccccc/original-dddddddd-dddd-4ddd-8ddd-dddddddddddd.html'
where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select public.test_assert((select original_path like '%/original-dddddddd%' from public.presentations where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),'versioned original accepted for the same presentation');
select public.test_denied($q$update public.presentations set original_path='dddddddd-dddd-4ddd-8ddd-dddddddddddd/original-dddddddd-dddd-4ddd-8ddd-dddddddddddd.html' where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'$q$,'23514','versioned original cannot point at another presentation');
select public.test_denied($q$update public.presentations set original_path='cccccccc-cccc-4ccc-8ccc-cccccccccccc/original-dddddddd-dddd-4ddd-8ddd-dddddddddddd.pdf' where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'$q$,'23514','versioned original extension must match its format');
select public.test_denied($q$update public.presentations set original_path='cccccccc-cccc-4ccc-8ccc-cccccccccccc/original-../secret.html' where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'$q$,'23514','versioned original path traversal rejected');
select public.test_denied($q$update public.presentations set original_path='cccccccc-cccc-4ccc-8ccc-cccccccccccc/original-loose.html' where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'$q$,'23514','versioned original requires a canonical UUID');
update public.presentations set original_path='cccccccc-cccc-4ccc-8ccc-cccccccccccc/original.html'
where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select public.test_assert((select original_path like '%/original.html' from public.presentations where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),'legacy path remains valid for rollback');
rollback;
