-- 행 단위 보안: 로그인한 사람은 자기 행만 읽고 쓴다. 삭제 권한은 아무에게도 주지 않는다(휴지통은 deleted_at).

alter table public.pt_auth_state enable row level security;   -- 정책 없음 = 앱에서는 접근 불가(서비스 키만)
alter table public.pt_apps       enable row level security;
alter table public.pt_logs       enable row level security;
alter table public.pt_spends     enable row level security;
alter table public.pt_history    enable row level security;

-- 기본으로 열려 있던 권한을 모두 회수한 뒤 필요한 것만 준다
revoke all on public.pt_auth_state, public.pt_apps, public.pt_logs, public.pt_spends, public.pt_history from anon, authenticated;
grant select, insert, update on public.pt_apps, public.pt_logs, public.pt_spends to authenticated;
grant select on public.pt_history to authenticated;
grant all on public.pt_auth_state, public.pt_apps, public.pt_logs, public.pt_spends, public.pt_history to service_role;

drop policy if exists pt_apps_select on public.pt_apps;
drop policy if exists pt_apps_insert on public.pt_apps;
drop policy if exists pt_apps_update on public.pt_apps;
create policy pt_apps_select on public.pt_apps for select to authenticated using (user_id = (select auth.uid()));
create policy pt_apps_insert on public.pt_apps for insert to authenticated with check (user_id = (select auth.uid()));
create policy pt_apps_update on public.pt_apps for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists pt_logs_select on public.pt_logs;
drop policy if exists pt_logs_insert on public.pt_logs;
drop policy if exists pt_logs_update on public.pt_logs;
create policy pt_logs_select on public.pt_logs for select to authenticated using (user_id = (select auth.uid()));
create policy pt_logs_insert on public.pt_logs for insert to authenticated with check (user_id = (select auth.uid()));
create policy pt_logs_update on public.pt_logs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists pt_spends_select on public.pt_spends;
drop policy if exists pt_spends_insert on public.pt_spends;
drop policy if exists pt_spends_update on public.pt_spends;
create policy pt_spends_select on public.pt_spends for select to authenticated using (user_id = (select auth.uid()));
create policy pt_spends_insert on public.pt_spends for insert to authenticated with check (user_id = (select auth.uid()));
create policy pt_spends_update on public.pt_spends for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists pt_history_select on public.pt_history;
create policy pt_history_select on public.pt_history for select to authenticated using (user_id = (select auth.uid()));
