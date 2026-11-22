\set ON_ERROR_STOP 0
insert into auth.users values ('00000000-0000-0000-0000-00000000000a','a'),('00000000-0000-0000-0000-00000000000b','b'),('00000000-0000-0000-0000-00000000000c','org'),('00000000-0000-0000-0000-00000000000d','stranger');
insert into teams values ('00000000-0000-0000-0000-00000000000a','team01','A'),('00000000-0000-0000-0000-00000000000b','team02','B');
insert into organisers values ('00000000-0000-0000-0000-00000000000c','judge');
create function as_user(uid text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', uid, false); end $$;
grant execute on function as_user to authenticated;

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
\echo '-- A inserts (expect ok)'
insert into reports (title, observed, fix) values ('A bug one','something odd here','changed the thing') returning id, team_id;
\echo '-- A tries to insert as B (expect permission denied on team_id column)'
insert into reports (team_id, title, observed, fix) values ('00000000-0000-0000-0000-00000000000b','x bug','something odd here','changed the thing');
\echo '-- A sets created_at (expect denied)'
insert into reports (title, observed, fix, created_at) values ('A bug','something odd here','changed the thing', now() - interval '1 day');
select as_user('00000000-0000-0000-0000-00000000000b');
insert into reports (title, observed, fix) values ('B bug one','something odd here','changed the thing');
\echo '-- B sees only own (expect 1)'
select count(*) from reports;
\echo '-- B updates A report (expect UPDATE 0)'
update reports set title='hacked!' where team_id='00000000-0000-0000-0000-00000000000a';
\echo '-- B deletes A report (expect DELETE 0)'
delete from reports where team_id='00000000-0000-0000-0000-00000000000a';
\echo '-- B reads reviews / other teams / settings'
select count(*) as reviews from report_reviews;
select count(*) as teams_visible from teams;
select * from settings;
\echo '-- B tries to close submissions (expect UPDATE 0)'
update settings set submissions_open=false;
\echo '-- B tries to insert review (expect RLS error)'
insert into report_reviews (report_id, verdict) values (1,'valid');
\echo '-- stranger (no team) inserts (expect RLS error)'
select as_user('00000000-0000-0000-0000-00000000000d');
insert into reports (title, observed, fix) values ('S bug one','something odd here','changed the thing');
\echo '-- organiser sees all (expect 2), reviews, closes submissions'
select as_user('00000000-0000-0000-0000-00000000000c');
select id, title from reports order by id;
insert into report_reviews (report_id, verdict, points) values (1,'valid',10);
update settings set submissions_open=false where id;
\echo '-- organiser tries to edit team report (expect UPDATE 0)'
update reports set title='organiser edit' where id=1;
\echo '-- A after close: insert fails, update 0, select ok'
select as_user('00000000-0000-0000-0000-00000000000a');
insert into reports (title, observed, fix) values ('late bug','something odd here','changed the thing');
update reports set title='late edit' where id=1;
select id, title from reports;
select count(*) as a_reviews from report_reviews;
reset role;
set role anon;
\echo '-- anon reads (expect permission denied)'
select count(*) from reports;
