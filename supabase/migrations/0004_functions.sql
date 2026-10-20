-- 서버 함수. 앱이 부르는 것(authenticated 전용)과 로그인 함수만 부르는 것(service_role 전용)으로 나뉩니다.

-- 1) 방금 만든 것 취소(되돌리기): 만든 지 1시간 안의 본인 행만 지움
create or replace function public.pt_undo_create(p_table text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then raise exception 'not logged in' using errcode = '42501'; end if;
  if p_table = 'pt_logs' then
    if not exists (select 1 from pt_logs where id = p_id and user_id = uid) then return; end if;
    delete from pt_logs where id = p_id and user_id = uid and created_at > now() - interval '60 minutes';
    get diagnostics n = row_count;
    if n = 0 then raise exception 'too old' using errcode = '42501'; end if;
    delete from pt_history where user_id = uid and entity = 'log' and entity_id = p_id;
  elsif p_table = 'pt_spends' then
    if not exists (select 1 from pt_spends where id = p_id and user_id = uid) then return; end if;
    delete from pt_spends where id = p_id and user_id = uid and created_at > now() - interval '60 minutes';
    get diagnostics n = row_count;
    if n = 0 then raise exception 'too old' using errcode = '42501'; end if;
    delete from pt_history where user_id = uid and entity = 'spend' and entity_id = p_id;
  elsif p_table = 'pt_apps' then
    if not exists (select 1 from pt_apps where id = p_id and user_id = uid) then return; end if;
    if not exists (select 1 from pt_apps where id = p_id and user_id = uid and created_at > now() - interval '60 minutes') then
      raise exception 'too old' using errcode = '42501';
    end if;
    delete from pt_logs   where app_id = p_id and user_id = uid;
    delete from pt_spends where app_id = p_id and user_id = uid;
    delete from pt_apps   where id = p_id and user_id = uid;
    delete from pt_history where user_id = uid and (app_id = p_id or entity_id = p_id);
  else
    raise exception 'bad table' using errcode = '22023';
  end if;
end $$;

-- 2) 휴지통 30일이 지난 본인 행을 영구 삭제 (앱을 열 때마다 앱이 부름)
create or replace function public.pt_purge_mine() returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  cutoff timestamptz := now() - interval '30 days';
  gone uuid[];
begin
  if uid is null then raise exception 'not logged in' using errcode = '42501'; end if;
  -- 앱: 앱의 기록·사용·이력까지 함께
  select coalesce(array_agg(id), '{}') into gone from pt_apps where user_id = uid and deleted_at is not null and deleted_at <= cutoff;
  delete from pt_logs   where user_id = uid and app_id = any(gone);
  delete from pt_spends where user_id = uid and app_id = any(gone);
  delete from pt_history where user_id = uid and (app_id = any(gone) or entity_id = any(gone));
  delete from pt_apps   where user_id = uid and id = any(gone);
  -- 개별 기록·사용
  delete from pt_history h using pt_logs l
   where h.user_id = uid and h.entity = 'log' and h.entity_id = l.id and l.user_id = uid and l.deleted_at is not null and l.deleted_at <= cutoff;
  delete from pt_logs   where user_id = uid and deleted_at is not null and deleted_at <= cutoff;
  delete from pt_history h using pt_spends s
   where h.user_id = uid and h.entity = 'spend' and h.entity_id = s.id and s.user_id = uid and s.deleted_at is not null and s.deleted_at <= cutoff;
  delete from pt_spends where user_id = uid and deleted_at is not null and deleted_at <= cutoff;
end $$;

-- 3) 로그인 함수(pt-auth) 전용: 틀린 횟수와 잠금 (한 칸씩, 동시에 와도 줄 세워 처리)
create or replace function public.pt_lock_minutes(p_level int) returns int
language sql immutable as $$
  select case when p_level <= 1 then 15 when p_level = 2 then 60 else 1440 end
$$;   -- 15분 -> 1시간 -> 하루. supabase/functions/pt-auth/logic.js 의 lockMinutes 와 같아야 함

create or replace function public.pt_auth_fail(p_slot int)
returns table (just_locked boolean, remaining int, until_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare s pt_auth_state%rowtype;
begin
  select * into s from pt_auth_state where slot = p_slot for update;
  if not found then raise exception 'no slot'; end if;
  s.failed_count := s.failed_count + 1;
  just_locked := false;
  if s.failed_count >= 5 then
    s.lock_level := s.lock_level + 1;
    s.locked_until := now() + make_interval(mins => public.pt_lock_minutes(s.lock_level));
    s.failed_count := 0;
    just_locked := true;
  end if;
  update pt_auth_state
     set failed_count = s.failed_count, lock_level = s.lock_level, locked_until = s.locked_until, updated_at = now()
   where slot = p_slot;
  remaining := case when just_locked then 0 else 5 - s.failed_count end;
  until_at := s.locked_until;
  return next;
end $$;

create or replace function public.pt_auth_ok(p_slot int) returns void
language sql security definer set search_path = public as $$
  update pt_auth_state set failed_count = 0, lock_level = 0, locked_until = null, updated_at = now() where slot = p_slot;
$$;

-- 첫 설정: 미설정 칸에 한해 한 번만 (먼저 도착한 것만 인정). 성공하면 user_id 를 돌려주고, 아니면 null
create or replace function public.pt_auth_claim(p_slot int) returns uuid
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  update pt_auth_state set state = 'set', updated_at = now()
   where slot = p_slot and state = 'unset'
   returning user_id into u;
  return u;
end $$;

create or replace function public.pt_auth_unclaim(p_slot int) returns void
language sql security definer set search_path = public as $$
  update pt_auth_state set state = 'unset', updated_at = now() where slot = p_slot;
$$;

-- 그 사용자의 모든 기기 로그인 끊기 (전체 로그아웃·비밀번호 바꾸기·초기화에 씀). 접속 토큰은 최대 1시간 더 유효
create or replace function public.pt_revoke_sessions(p_user uuid) returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.sessions where user_id = p_user;
$$;

-- 권한: 앱용은 로그인한 사람만, 로그인 함수용은 서비스 키만
revoke all on function public.pt_undo_create(text, uuid) from public, anon;
revoke all on function public.pt_purge_mine() from public, anon;
grant execute on function public.pt_undo_create(text, uuid) to authenticated;
grant execute on function public.pt_purge_mine() to authenticated;

revoke all on function public.pt_lock_minutes(int) from public, anon, authenticated;
revoke all on function public.pt_auth_fail(int) from public, anon, authenticated;
revoke all on function public.pt_auth_ok(int) from public, anon, authenticated;
revoke all on function public.pt_auth_claim(int) from public, anon, authenticated;
revoke all on function public.pt_auth_unclaim(int) from public, anon, authenticated;
revoke all on function public.pt_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.pt_lock_minutes(int), public.pt_auth_fail(int), public.pt_auth_ok(int),
  public.pt_auth_claim(int), public.pt_auth_unclaim(int), public.pt_revoke_sessions(uuid) to service_role;
