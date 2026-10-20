# 걷기 포인트

걷기 앱(캐시워크 등)의 포인트를 한곳에 기록하는 가족용 설치형 웹앱입니다. 정적 파일(GitHub Pages) + Supabase.

## 파일 구성

| 위치 | 내용 |
|---|---|
| `index.html`, `css/`, `js/`, `sw.js`, `manifest.webmanifest`, `icons/` | 앱 화면 (빌드 과정 없음) |
| `js/calc.js` | 계산 규칙(차이·잔액·점검). 화면·서버와 무관한 순수 함수 |
| `js/data.js` | 서버 연결 계층: Supabase 어댑터 / 시험용 메모리 가짜 서버 |
| `js/store.js` | 상태·수정·되돌리기·오프라인 재전송 |
| `js/ui.js`, `js/demo.js` | 화면 / 서버 없이 눌러 보는 시험 화면(주소 끝에 `?mock=1`) |
| `js/config.js` | **서버 주소와 공개용 키 자리표시자** (비밀 키는 넣지 않음) |
| `supabase/migrations/` | 표·권한·함수 SQL (0001 → 0004 순서) |
| `supabase/functions/pt-auth/` | 로그인 함수(첫 설정·로그인·잠금·비밀번호 바꾸기·전체 로그아웃) |
| `supabase/admin/` | 계정 3개 미리 만들기, 칸 초기화·열기 (관리자용) |
| `supabase/tests/rls_test.sql` | 사용자 분리 서버 시험 (되돌림 트랜잭션) |
| `tests/` | 자동 시험 (`node --test tests/*.test.mjs`, `python tests/ui_check.py`) |

## 서버를 붙일 때 순서 (새 Supabase 프로젝트 기준)

1. 새 프로젝트를 만든다. Authentication 설정에서 「Allow new users to sign up」을 끈다. (Sessions의 시간 제한은 비워 둔다)
2. SQL Editor에서 `supabase/migrations/0001 → 0002 → 0003 → 0004` 순서로 실행한다.
3. Edge Function 비밀값 `PT_PEPPER`(32자 이상 임의 글자, 한 번 정하면 바꾸지 않음)를 넣고 `pt-auth` 함수를 배포한다 (`--no-verify-jwt`).
4. 관리자 PC에서 환경변수 `PT_SUPABASE_URL`, `PT_SUPABASE_SERVICE_KEY`를 잠깐 설정하고 `python supabase/admin/seed_users.py` 실행 (사용자1·2 = 처음 사용, 사용자3 = 사용 안 함).
5. `supabase/tests/rls_test.sql`을 SQL Editor에서 실행해 「PASS」 알림을 확인한다 (끝에서 롤백되어 아무것도 남지 않음).
6. `js/config.js`의 `SUPABASE_URL`, `SUPABASE_ANON_KEY`에 **공개용(anon/publishable) 키**를 넣는다. 서비스 키는 어디에도 넣지 않는다.
7. 화면 파일을 올린 뒤 사용자1 → 사용자2 순서로 바로 비밀번호를 정한다 (정하기 전에는 주소를 다른 곳에 공유하지 않는다).

## 화면 파일을 바꿔 올릴 때

`js/config.js`의 `APP_BUILD`와 `sw.js`의 `CACHE` 숫자를 함께 올린다.

## 사용자 칸 관리

- 비밀번호를 잊은 경우: `supabase/admin/reset_slot.sql` (기록은 보존, 임시 잠금) → 본인이 준비되면 `open_slot.sql` → 곧바로 본인이 새 비밀번호 설정.
- 사용자3을 쓰게 될 때: `open_slot.sql`의 칸 번호를 3으로 두고 실행 → 곧바로 설정.
