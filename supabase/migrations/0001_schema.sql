-- 걷기 포인트 앱 서버 표 (모든 이름이 pt_ 로 시작합니다. 새 Supabase 프로젝트 전용)
-- 적용 순서: 0001 -> 0002 -> 0003 -> 0004 (SQL Editor 에 차례로 붙여 넣거나 supabase db push)
-- 이 파일들은 실제 서버에 아직 적용하지 않았습니다.

-- 사용자 칸(1~3)의 로그인 상태. 앱(브라우저)은 이 표에 접근할 수 없고, 로그인 함수(pt-auth)만 서비스 키로 읽고 씁니다.
create table if not exists public.pt_auth_state (
  slot         int primary key check (slot between 1 and 3),
  user_id      uuid unique,                       -- auth.users.id (미리 만들어 둔 계정)
  state        text not null default 'unset' check (state in ('unset', 'set', 'disabled')),
  failed_count int  not null default 0,
  lock_level   int  not null default 0,
  locked_until timestamptz,
  last_failed_at timestamptz,                     -- 24시간 틀림이 없으면 잠금 단계를 처음으로
  updated_at   timestamptz not null default now()
);

-- 걷기 앱 (캐시워크 등)
create table if not exists public.pt_apps (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name       text not null check (char_length(btrim(name)) between 1 and 30),
  sort       int  not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,                         -- 휴지통(30일 뒤 pt_purge_mine 이 영구 삭제)
  unique (id, user_id)                            -- 아래 복합 외래키용: 남의 앱에 내 기록을 붙일 수 없게
);

-- 그날 기록(앱·날짜당 한 줄). 입력 시각을 따로 저장해 시각 순서로 계산합니다.
create table if not exists public.pt_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete restrict,
  app_id      uuid not null,
  log_date    date not null,                      -- 한국 날짜
  total       bigint not null check (total between 0 and 999999999),
  recorded_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  foreign key (app_id, user_id) references public.pt_apps (id, user_id) on delete restrict
);
create unique index if not exists pt_logs_one_per_day on public.pt_logs (app_id, log_date) where deleted_at is null;
create index if not exists pt_logs_user_app on public.pt_logs (user_id, app_id, log_date);

-- 포인트 사용(지출)
create table if not exists public.pt_spends (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete restrict,
  app_id     uuid not null,
  amount     bigint not null check (amount > 0 and amount <= 999999999),
  memo       text not null default '기타' check (char_length(memo) <= 30),
  spent_at   timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (app_id, user_id) references public.pt_apps (id, user_id) on delete restrict
);
create index if not exists pt_spends_user_app on public.pt_spends (user_id, app_id, spent_at);

-- 모든 변경의 이력(앱 화면의 「이전 값」). 트리거만 씁니다.
create table if not exists public.pt_history (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null,
  entity    text not null check (entity in ('log', 'spend', 'app')),
  entity_id uuid not null,
  app_id    uuid,
  action    text not null check (action in ('create', 'update')),
  old       jsonb,
  new       jsonb,
  at        timestamptz not null default now()
);
create index if not exists pt_history_lookup on public.pt_history (user_id, entity, entity_id, at desc);
