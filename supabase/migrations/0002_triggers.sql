-- 쓰기 전 점검(시각·날짜·소유자 보호)과 이력 기록

create or replace function public.pt_before_write() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;   -- 만든 시각·주인은 바꿀 수 없음
    new.user_id    := old.user_id;
  end if;

  if tg_table_name = 'pt_logs' then
    -- 미래 시각은 서버 시각으로 (폰 시계가 빠른 경우)
    if new.recorded_at is null or new.recorded_at > now() + interval '5 minutes' then
      new.recorded_at := now();
    end if;
    -- 앞으로 올 날짜는 기록할 수 없음 (한국 날짜 기준)
    if new.log_date > (now() at time zone 'Asia/Seoul')::date then
      raise exception 'future date' using errcode = '22008';
    end if;
  elsif tg_table_name = 'pt_spends' then
    if new.spent_at is null or new.spent_at > now() + interval '5 minutes' then
      new.spent_at := now();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists pt_apps_before   on public.pt_apps;
drop trigger if exists pt_logs_before   on public.pt_logs;
drop trigger if exists pt_spends_before on public.pt_spends;
create trigger pt_apps_before   before insert or update on public.pt_apps   for each row execute function public.pt_before_write();
create trigger pt_logs_before   before insert or update on public.pt_logs   for each row execute function public.pt_before_write();
create trigger pt_spends_before before insert or update on public.pt_spends for each row execute function public.pt_before_write();

-- 이력: 값이 실제로 바뀐 경우만 기록 (앱 화면의 시험용 가짜 서버와 같은 규칙)
create or replace function public.pt_log_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ent text; aid uuid; o jsonb; n jsonb;
begin
  if tg_table_name = 'pt_logs' then
    ent := 'log'; aid := new.app_id;
    n := jsonb_build_object('total', new.total, 'log_date', new.log_date, 'recorded_at', new.recorded_at, 'deleted_at', new.deleted_at);
    if tg_op = 'UPDATE' then
      o := jsonb_build_object('total', old.total, 'log_date', old.log_date, 'recorded_at', old.recorded_at, 'deleted_at', old.deleted_at);
    end if;
  elsif tg_table_name = 'pt_spends' then
    ent := 'spend'; aid := new.app_id;
    n := jsonb_build_object('amount', new.amount, 'memo', new.memo, 'spent_at', new.spent_at, 'deleted_at', new.deleted_at);
    if tg_op = 'UPDATE' then
      o := jsonb_build_object('amount', old.amount, 'memo', old.memo, 'spent_at', old.spent_at, 'deleted_at', old.deleted_at);
    end if;
  else
    ent := 'app'; aid := new.id;
    n := jsonb_build_object('name', new.name, 'deleted_at', new.deleted_at);
    if tg_op = 'UPDATE' then
      o := jsonb_build_object('name', old.name, 'deleted_at', old.deleted_at);
    end if;
  end if;

  if tg_op = 'UPDATE' and o = n then
    return null;
  end if;
  insert into public.pt_history (user_id, entity, entity_id, app_id, action, old, new)
  values (new.user_id, ent, new.id, aid, case when tg_op = 'INSERT' then 'create' else 'update' end, o, n);
  return null;
end $$;

drop trigger if exists pt_apps_hist   on public.pt_apps;
drop trigger if exists pt_logs_hist   on public.pt_logs;
drop trigger if exists pt_spends_hist on public.pt_spends;
create trigger pt_apps_hist   after insert or update on public.pt_apps   for each row execute function public.pt_log_history();
create trigger pt_logs_hist   after insert or update on public.pt_logs   for each row execute function public.pt_log_history();
create trigger pt_spends_hist after insert or update on public.pt_spends for each row execute function public.pt_log_history();
