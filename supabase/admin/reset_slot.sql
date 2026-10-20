-- 사용자 칸 초기화 (비밀번호를 잊었을 때). 관리자가 본인 확인 뒤에만 실행합니다.
-- 기록은 그대로 두고, 비밀번호를 「미설정」으로 되돌리고, 그 칸의 모든 기기 로그인을 끊습니다.
-- 초기화한 칸은 「사용 안 함」으로 임시 잠가 둡니다 → 본인이 바로 새 비밀번호를 정할 수 있을 때
-- admin/open_slot.sql 로 열고, 곧바로 본인이 설정합니다. (먼저 차지당하는 위험을 줄이기 위해)
-- 다른 칸에는 영향이 없습니다.
-- 사용법: 아래 slot_no 숫자(1~3)를 고쳐 Supabase SQL Editor 에서 실행.

do $$
declare
  slot_no int := 2;      -- ← 초기화할 칸
  uid uuid;
begin
  if not exists (select 1 from public.pt_auth_state where slot = slot_no) then raise exception 'slot % not found', slot_no; end if;
  select user_id into uid from public.pt_auth_state where slot = slot_no;   -- 아직 한 번도 설정하지 않은 칸은 null
  update public.pt_auth_state
     set state = 'disabled', failed_count = 0, lock_level = 0, locked_until = null, updated_at = now()
   where slot = slot_no;
  if uid is not null then perform public.pt_revoke_sessions(uid); end if;
  raise notice '사용자% 초기화 완료 (임시 잠금). 본인이 준비되면 open_slot.sql 로 여세요.', slot_no;
end $$;
