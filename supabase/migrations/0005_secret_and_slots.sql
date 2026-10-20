-- 비밀값(PEPPER)과 사용자 칸 초기 상태. SQL만으로 초기 설정이 끝나도록 합니다(키·비밀값을 사람이 입력하지 않음).
-- 이 파일은 여러 번 실행해도 안전합니다(이미 있는 값은 유지하고 덮어쓰지 않음).

create extension if not exists pgcrypto with schema extensions;

-- 로그인 함수(pt-auth)만 서비스 권한으로 읽는 비밀값 표. 앱(anon/authenticated)은 접근할 수 없습니다.
create table if not exists public.pt_secret (
  name       text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);
alter table public.pt_secret enable row level security;     -- 정책 없음 = 서비스 권한 외에는 읽기·쓰기 모두 불가
revoke all on public.pt_secret from public, anon, authenticated;
grant select on public.pt_secret to service_role;

-- 무작위 값을 한 번만 만든다. 이미 있으면 그대로 둔다(바꾸면 모든 비밀번호가 무효가 되므로 덮어쓰기 금지).
-- 값은 화면·로그에 출력하지 않는다.
insert into public.pt_secret (name, value)
values ('pepper', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- 사용자 칸: 1·2 = 처음 사용(비밀번호 미설정), 3 = 사용 안 함. 로그인 계정은 첫 설정 때 로그인 함수가 만든다.
insert into public.pt_auth_state (slot, state) values (1, 'unset'), (2, 'unset'), (3, 'disabled')
on conflict (slot) do nothing;
