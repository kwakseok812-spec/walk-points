-- 사용자 분리 서버 시험 (DESIGN 8절 1~7번). 새 프로젝트에 0001~0005 를 적용한 뒤
-- SQL Editor 에서 통째로 실행합니다. 끝에서 항상 ROLLBACK 하므로 아무것도 남지 않습니다(실제 기록 변경 0).
-- 실패하면 「FAIL: ...」 오류로 멈춥니다. 끝까지 오면 「PASS」 알림이 나옵니다.
-- (이 파일은 작성만 했고 아직 실제 서버에서 실행하지 않았습니다)

begin;

do $$
declare
  u1 uuid; u2 uuid; u3 uuid;
  a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid(); a3 uuid := gen_random_uuid();
  l1 uuid := gen_random_uuid();
  n int;
  ok boolean;
begin
  -- 로그인 계정은 첫 설정 때 만들어지므로, 이 시험은 롤백될 시험용 계정 3개를 직접 만들어 쓴다
  u1 := gen_random_uuid(); u2 := gen_random_uuid(); u3 := gen_random_uuid();
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'rls-test-1@pt.example.com'),
    (u2, 'authenticated', 'authenticated', 'rls-test-2@pt.example.com'),
    (u3, 'authenticated', 'authenticated', 'rls-test-3@pt.example.com');

  -- 각 사용자로 자기 앱·기록·사용을 만든다
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.pt_apps (id, name) values (a1, 'T1');
  insert into public.pt_logs (id, app_id, log_date, total) values (l1, a1, (now() at time zone 'Asia/Seoul')::date, 100);
  insert into public.pt_spends (app_id, amount) values (a1, 10);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.pt_apps (id, name) values (a2, 'T2');
  insert into public.pt_logs (app_id, log_date, total) values (a2, (now() at time zone 'Asia/Seoul')::date, 200);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.pt_apps (id, name) values (a3, 'T3');
  reset role;

  -- 1·2·7: 사용자2 로 읽으면 사용자1·3 의 행(앱·기록·사용·이력)이 0 행
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pt_apps where user_id <> u2;    if n <> 0 then raise exception 'FAIL: 앱이 보임 %', n; end if;
  select count(*) into n from public.pt_logs where user_id <> u2;    if n <> 0 then raise exception 'FAIL: 기록이 보임 %', n; end if;
  select count(*) into n from public.pt_spends where user_id <> u2;  if n <> 0 then raise exception 'FAIL: 사용이 보임 %', n; end if;
  select count(*) into n from public.pt_history where user_id <> u2; if n <> 0 then raise exception 'FAIL: 이력이 보임 %', n; end if;
  select count(*) into n from public.pt_apps; if n <> 1 then raise exception 'FAIL: 내 앱 수 %', n; end if;

  -- 3: 남의 user_id 를 달아 쓰기 -> 거부
  ok := false;
  begin insert into public.pt_apps (user_id, name) values (u1, 'X'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 남의 user_id 로 앱 쓰기가 통과됨'; end if;
  -- 남의 앱에 내 기록 붙이기 -> 거부(복합 외래키)
  ok := false;
  begin insert into public.pt_logs (app_id, log_date, total) values (a1, (now() at time zone 'Asia/Seoul')::date - 1, 5); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 남의 앱에 기록이 붙음'; end if;

  -- 4: 남의 행 수정·삭제 -> 0행 영향, 이전 값 복원/되살리기도 같은 경로라 동일
  update public.pt_logs set total = 999999 where id = l1; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: 남의 기록을 수정함'; end if;
  ok := false;
  begin delete from public.pt_logs where id = l1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 삭제 권한이 열려 있음'; end if;
  ok := false;
  begin perform public.pt_undo_create('pt_logs', l1); ok := true; exception when others then ok := true; end;
  select count(*) into n from public.pt_logs where id = l1;  -- 사용자2 눈에는 원래 안 보임
  reset role;
  select count(*) into n from public.pt_logs where id = l1;
  if n <> 1 then raise exception 'FAIL: 남의 기록이 지워짐'; end if;

  -- 5: 로그인 안 한(anon) 상태 -> 모든 pt_ 표와 함수 거부
  set local role anon;
  ok := false;
  begin perform 1 from public.pt_apps limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: anon 이 pt_apps 를 읽음'; end if;
  ok := false;
  begin perform 1 from public.pt_auth_state limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: anon 이 pt_auth_state 를 읽음'; end if;
  ok := false;
  begin perform public.pt_purge_mine(); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: anon 이 함수를 부름'; end if;
  reset role;

  -- 로그인한 사용자도 pt_auth_state(비밀번호 상태 표)는 못 읽음, 로그인 전용 함수도 못 부름
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin perform 1 from public.pt_auth_state limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 로그인한 사용자가 pt_auth_state 를 읽음'; end if;
  ok := false;
  begin perform public.pt_auth_fail(2); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 로그인한 사용자가 잠금 함수를 부름'; end if;
  reset role;

  -- 비밀값 표(pt_secret)는 앱 권한으로 읽을 수 없음
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin perform 1 from public.pt_secret limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 로그인한 사용자가 pt_secret 을 읽음'; end if;
  reset role;
  set local role anon;
  ok := false;
  begin perform 1 from public.pt_secret limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: anon 이 pt_secret 을 읽음'; end if;
  reset role;
  if not exists (select 1 from public.pt_secret where name = 'pepper' and length(value) >= 32) then raise exception 'FAIL: 0005 의 비밀값(pepper)이 없음'; end if;
  if (select count(*) from public.pt_auth_state) <> 3 then raise exception 'FAIL: 사용자 칸 3개가 없음 (0005 확인)'; end if;

  raise notice 'PASS: 사용자 분리 시험 통과 (곧 ROLLBACK 합니다)';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 설계 8절 8·9·10·11번: 첫 설정 선착순 / 초기화 영향 0 / 칸별 잠금 독립 / 사용자3 비활성
-- (관리자 권한으로 실행. 모든 변경은 마지막 ROLLBACK 으로 사라집니다)
-- ---------------------------------------------------------------------------------------------
do $$
declare
  u1 uuid; u2 uuid; u3 uuid;
  r record; n int; ok1 boolean; ok2 boolean; i int;
  sess_before int; sess_after int; apps_before int;
begin
  -- 시험용 계정 3개(롤백됨)와 칸 연결
  u1 := gen_random_uuid(); u2 := gen_random_uuid(); u3 := gen_random_uuid();
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'rls-test-b1@pt.example.com'),
    (u2, 'authenticated', 'authenticated', 'rls-test-b2@pt.example.com'),
    (u3, 'authenticated', 'authenticated', 'rls-test-b3@pt.example.com');
  update public.pt_auth_state set user_id = u1 where slot = 1;
  update public.pt_auth_state set user_id = u2 where slot = 2;
  update public.pt_auth_state set user_id = u3 where slot = 3;

  -- 시험 준비: 1 = 미설정, 2 = 설정됨(기록 있음), 3 = 사용 안 함
  update public.pt_auth_state set state = 'unset', failed_count = 0, lock_level = 0, locked_until = null, last_failed_at = null where slot = 1;
  update public.pt_auth_state set state = 'set',   failed_count = 0, lock_level = 0, locked_until = null, last_failed_at = null where slot = 2;
  update public.pt_auth_state set state = 'disabled', failed_count = 0, lock_level = 0, locked_until = null, last_failed_at = null where slot = 3;

  -- 8) 첫 설정: 미설정 칸은 첫 번째만 성공(user_id 반환), 두 번째·이미 설정된 칸은 null
  select claimed into ok1 from public.pt_auth_claim(1);
  select claimed into ok2 from public.pt_auth_claim(1);
  if not ok1 then raise exception 'FAIL(8): 첫 설정이 받아들여지지 않음'; end if;
  if ok2 then raise exception 'FAIL(8): 같은 칸 두 번째 설정이 통과됨'; end if;
  select claimed into ok1 from public.pt_auth_claim(2);
  if ok1 then raise exception 'FAIL(8): 이미 설정된 칸에 설정이 통과됨'; end if;

  -- 11) 사용자3 「사용 안 함」: 첫 설정 거부
  select claimed into ok1 from public.pt_auth_claim(3);
  if ok1 then raise exception 'FAIL(11): 사용 안 함 칸에 첫 설정이 통과됨'; end if;
  if (select state from public.pt_auth_state where slot = 3) <> 'disabled' then raise exception 'FAIL(11): 사용자3 상태가 바뀜'; end if;

  -- 10) 잠금: 사용자2 를 5번 틀려 잠가도 사용자1 은 영향 없음, 잠긴 동안 시도는 allowed=false
  for i in 1..4 loop
    select * into r from public.pt_auth_fail(2);
    if not r.allowed or r.just_locked or r.remaining <> 5 - i then raise exception 'FAIL(10): % 번째 틀림 계산이 다름 (%)', i, r; end if;
  end loop;
  select * into r from public.pt_auth_fail(2);
  if not r.allowed or not r.just_locked then raise exception 'FAIL(10): 5번째에 잠기지 않음'; end if;
  select * into r from public.pt_auth_fail(2);
  if r.allowed then raise exception 'FAIL(10): 잠긴 동안에도 시도가 허용됨'; end if;
  select * into r from public.pt_auth_fail(1);
  if not r.allowed or r.just_locked or r.remaining <> 4 then raise exception 'FAIL(10): 다른 칸이 영향을 받음 (%)', r; end if;
  if (select locked_until from public.pt_auth_state where slot = 1) is not null then raise exception 'FAIL(10): 사용자1 이 잠김'; end if;
  -- 잠금 시간: 처음 15분, 풀린 뒤 또 5번 틀리면 1시간, 그 다음도 1시간(상한)
  if (select locked_until from public.pt_auth_state where slot = 2) not between now() + interval '14 minutes' and now() + interval '16 minutes' then raise exception 'FAIL(10): 첫 잠금이 15분이 아님'; end if;
  update public.pt_auth_state set locked_until = now() - interval '1 minute' where slot = 2;
  for i in 1..5 loop perform * from public.pt_auth_fail(2); end loop;
  if (select locked_until from public.pt_auth_state where slot = 2) not between now() + interval '59 minutes' and now() + interval '61 minutes' then raise exception 'FAIL(10): 두 번째 잠금이 1시간이 아님'; end if;
  update public.pt_auth_state set locked_until = now() - interval '1 minute' where slot = 2;
  for i in 1..5 loop perform * from public.pt_auth_fail(2); end loop;
  if (select locked_until from public.pt_auth_state where slot = 2) > now() + interval '61 minutes' then raise exception 'FAIL(10): 1시간 상한을 넘음'; end if;
  -- 24시간 틀림이 없으면 처음으로
  update public.pt_auth_state set locked_until = null, last_failed_at = now() - interval '25 hours' where slot = 2;
  for i in 1..5 loop perform * from public.pt_auth_fail(2); end loop;
  if (select locked_until from public.pt_auth_state where slot = 2) > now() + interval '16 minutes' then raise exception 'FAIL(10): 24시간 뒤 단계가 처음으로 돌아가지 않음'; end if;
  -- 성공하면 모두 초기화
  perform public.pt_auth_ok(2);
  if (select failed_count + lock_level from public.pt_auth_state where slot = 2) <> 0 or (select locked_until from public.pt_auth_state where slot = 2) is not null then raise exception 'FAIL(10): 성공 뒤 잠금이 풀리지 않음'; end if;

  -- 9) 초기화(reset_slot.sql 과 같은 동작): 사용자2 를 초기화해도 사용자1·3 의 상태와 모든 사용자의 기록은 그대로
  update public.pt_auth_state set state = 'set' where slot = 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.pt_apps (name) values ('R1');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.pt_apps (name) values ('R2');
  reset role;
  select count(*) into apps_before from public.pt_apps where name in ('R1', 'R2');
  select count(*) into sess_before from auth.sessions where user_id in (u1, u3);
  update public.pt_auth_state set state = 'disabled', failed_count = 0, lock_level = 0, locked_until = null, last_failed_at = null where slot = 2;
  perform public.pt_revoke_sessions(u2);
  select count(*) into sess_after from auth.sessions where user_id in (u1, u3);
  if sess_before <> sess_after then raise exception 'FAIL(9): 다른 사용자의 로그인 세션이 끊김'; end if;
  if (select count(*) from public.pt_apps where name in ('R1', 'R2')) <> apps_before then raise exception 'FAIL(9): 초기화로 기록이 바뀜'; end if;
  if (select state from public.pt_auth_state where slot = 1) <> 'set' or (select state from public.pt_auth_state where slot = 3) <> 'disabled' then raise exception 'FAIL(9): 다른 칸의 상태가 바뀜'; end if;
  if (select count(*) from auth.sessions where user_id = u2) <> 0 then raise exception 'FAIL(9): 초기화한 칸의 세션이 남음'; end if;

  raise notice 'PASS: 설계 8절 8·9·10·11번 통과 (곧 ROLLBACK 합니다)';
end $$;

rollback;
