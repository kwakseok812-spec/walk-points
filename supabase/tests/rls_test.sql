-- 사용자 분리 서버 시험 (DESIGN 8절 1~7번). 새 프로젝트에 0001~0004 를 적용하고 seed_users.py 를 실행한 뒤
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
  select user_id into u1 from public.pt_auth_state where slot = 1;
  select user_id into u2 from public.pt_auth_state where slot = 2;
  select user_id into u3 from public.pt_auth_state where slot = 3;
  if u1 is null or u2 is null or u3 is null then raise exception 'FAIL: seed_users.py 를 먼저 실행하세요'; end if;

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

  raise notice 'PASS: 사용자 분리 시험 통과 (곧 ROLLBACK 합니다)';
end $$;

rollback;
