-- 사용자 칸 열기: 「사용 안 함」(또는 초기화 직후 임시 잠금) 상태를 「처음 사용(비밀번호 미설정)」으로 바꿉니다.
-- 연 직후 쓰실 분이 바로 비밀번호를 정할 수 있을 때만 실행하세요. (주소를 아는 누구든 먼저 차지할 수 있는 시간이 생깁니다)
-- 이미 비밀번호가 정해진 칸(state = 'set')은 건드리지 않습니다.

do $$
declare
  slot_no int := 3;      -- ← 열 칸
begin
  update public.pt_auth_state
     set state = 'unset', failed_count = 0, lock_level = 0, locked_until = null, updated_at = now()
   where slot = slot_no and state = 'disabled';
  if not found then raise notice '사용자%는 「사용 안 함」 상태가 아니어서 바꾸지 않았습니다.', slot_no; end if;
end $$;
