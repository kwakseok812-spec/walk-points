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

### 0. 준비물과 키 위치
| 키 | 어디에 쓰나 | 넣는 곳 |
|---|---|---|
| 프로젝트 주소(URL) | 앱·관리 도구 | `js/config.js`의 `SUPABASE_URL` (공개 가능) |
| 공개용 키(anon 또는 `sb_publishable_...`) | 앱이 서버를 부를 때 | `js/config.js`의 `SUPABASE_ANON_KEY` (공개 가능) |
| 서비스 키(service_role 또는 `sb_secret_...`) | 관리 도구(`seed_users.py`)만 | **PC 환경변수에만**. 저장소·파일·화면·기록에 남기지 않는다 |
| `PT_PEPPER` | 로그인 함수 안에서 비밀번호를 섞는 값 | Supabase 함수 비밀값에만. 한 번 정하면 바꾸지 않는다(바꾸면 모든 비밀번호가 무효) |

- **주의(`sb_secret_` 키)**: 새 형식의 서비스 키(`sb_secret_...`)는 JWT가 아니라서 `Authorization: Bearer ...` 머리말에 넣으면 거절됩니다. `seed_users.py`와 로그인 함수(`index.ts`)는 이 형식이면 `apikey` 머리말에만 넣도록 되어 있지만, 실제 서버에서 확인한 적은 없습니다. 첫 실행에서 401이 나면 이 점부터 확인하세요(로그인 함수가 쓰는 `SUPABASE_SERVICE_ROLE_KEY`가 어느 형식인지도 서버에서 확인 필요).
- **서버에서 확인 필요**: 계정 이메일 `slotN@pt.example.com`(N=1·2·3)을 Supabase가 허용하는지(example.com 같은 예약 도메인을 거부하는 설정이 있는지). 거부되면 `logic.js`의 `slotEmail`과 `seed_users.py`의 `email()`을 같은 값으로 바꿔야 합니다.

### 1. 프로젝트 만들기와 설정
1. 새 프로젝트를 만든다(비용 확인 뒤). Authentication > Sign In / Providers에서 「Allow new users to sign up」을 끈다. Authentication > Sessions의 「Time-box」「Inactivity timeout」은 비워 둔다.
2. 이미 로그인한 기기는 잠금·초기화와 상관없이 계속 쓸 수 있습니다(잠금은 「새로 로그인」과 「비밀번호 바꾸기」에만 적용). 반대로 누가 남의 칸에 틀린 비밀번호를 계속 넣어도 최대 1시간 잠길 뿐이며, 이미 로그인된 기기에는 영향이 없습니다.

### 2. SQL 적용 (SQL Editor에서 파일별로 새 쿼리를 열어 전체 붙여넣고 Run)
| 순서 | 파일 | 성공하면 나오는 것 |
|---|---|---|
| 1 | `supabase/migrations/0001_schema.sql` | `Success. No rows returned` |
| 2 | `supabase/migrations/0002_triggers.sql` | 같음 |
| 3 | `supabase/migrations/0003_rls.sql` | 같음 |
| 4 | `supabase/migrations/0004_functions.sql` | 같음 |
- 중간에 오류가 나면 **그 줄 번호의 파일에서 멈추고** 오류 문구를 그대로 전달한다(앞 파일은 다시 실행해도 됩니다. `if not exists`/`or replace`/`drop ... if exists`로 쓰여 있음). 이 SQL은 PostgreSQL 없이 눈으로만 점검했고 실제 실행은 처음입니다.
- 확인: Table Editor에 `pt_apps, pt_auth_state, pt_history, pt_logs, pt_spends`가 보이고 모두 RLS가 켜져(Enabled) 있어야 한다.

### 3. 로그인 함수 배포 (관리자 PC, Supabase CLI)
```
supabase login                                  # 브라우저로 로그인(토큰은 CLI가 보관)
supabase link --project-ref <프로젝트 ref>      # 프로젝트 연결 (ref는 URL 앞부분)
supabase secrets set PT_PEPPER=<32자 이상 임의 글자>
supabase functions deploy pt-auth --no-verify-jwt
```
- 예상 출력: `Deployed Functions on project ...: pt-auth`.
- 이 폴더의 `supabase/config.toml`은 설정 조각이라, `supabase link`가 자체 `config.toml`을 만들 경우 `[functions.pt-auth] verify_jwt = false`만 옮겨 두거나 위처럼 `--no-verify-jwt`를 붙인다.

### 4. 계정 3개 미리 만들기
```
set PT_SUPABASE_URL=https://<ref>.supabase.co
set PT_SUPABASE_SERVICE_KEY=<서비스 키>
python supabase/admin/seed_users.py --dry-run   # 계획만 출력
python supabase/admin/seed_users.py             # 실제 실행
```
- 예상 출력: 사용자1·2·3 각각 `완료` 세 줄. 끝나면 환경변수를 지운다(`set PT_SUPABASE_SERVICE_KEY=`).

### 5. 서버 시험
`supabase/tests/rls_test.sql` 전체를 SQL Editor에서 실행한다(끝에서 ROLLBACK).
- 예상: Messages에 `PASS: 사용자 분리 시험 통과 ...`와 `PASS: 설계 8절 8·9·10·11번 통과 ...` 두 줄. `FAIL: ...` 오류가 나면 멈추고 그 문구를 전달한다.
- 그 다음 함수가 실제로 도는지: 브라우저에서 앱을 열어 사용자2 「처음 사용」 화면까지 가면 로그인 함수·표 연결이 된 것이다(비밀번호는 정하지 말고 돌아오기).

### 6. 앱 올리기
1. `js/config.js`의 `SUPABASE_URL`, `SUPABASE_ANON_KEY`에 **공개용 값만** 넣는다. 이 파일에 서비스 키가 들어가면 안 된다.
2. 새 공개 저장소를 만들고(승인 뒤) 이 폴더를 올린다. GitHub 저장소의 Settings > Pages > Build and deployment에서 Source를 「Deploy from a branch」, Branch를 `main` / `/ (root)`로 고르고 Save. 1~2분 뒤 `https://<계정>.github.io/<저장소>/`가 열린다.
3. 시험 화면(`?mock=1`)은 `localhost`·`127.0.0.1`에서만 열리고 배포 주소에서는 무시된다.
4. 사용자1 → 사용자2 순서로 곧바로 비밀번호를 정한다(정하기 전에는 주소를 다른 곳에 공유하지 않는다). 사용자3은 `open_slot.sql`로 열고 곧바로 설정한다.
5. 화면 파일을 바꿔 올릴 때는 `js/config.js`의 `APP_BUILD`와 `sw.js`의 `CACHE` 숫자를 함께 올린다.

## 비밀번호·잠금 정책
- 비밀번호는 4자 이상(글자 종류 제한 없음), 흔한 값 거절. 설정 화면에서는 6자 이상을 권장한다고 안내한다.
- 한 칸에서 5번 틀리면 15분 잠금, 풀린 뒤 또 5번 틀리면 1시간(상한). 24시간 동안 틀림이 없으면 단계를 처음(15분)으로 되돌린다. 하루 잠금은 없다.
- 확인 **전에** 횟수를 먼저 올리고 맞으면 되돌리는 방식이라, 동시에 여러 번 보내도 5번까지만 확인한다.
- 이미 로그인된 기기는 잠금과 상관없이 계속 사용된다.

## 사용자 칸 관리

- 비밀번호를 잊은 경우: `supabase/admin/reset_slot.sql` (기록은 보존, 임시 잠금) → 본인이 준비되면 `open_slot.sql` → 곧바로 본인이 새 비밀번호 설정.
- 사용자3을 쓰게 될 때: `open_slot.sql`의 칸 번호를 3으로 두고 실행 → 곧바로 설정.
