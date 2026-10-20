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
| `supabase/migrations/` | 표·권한·함수·비밀값·사용자 칸 초기 상태 SQL (0001 → 0005 순서) |
| `supabase/functions/pt-auth/` | 로그인 함수. `index.single.ts`(편집기에 붙여넣는 단일 파일), `logic.js`(앱·시험과 공유하는 규칙, 단일 파일 안에 같은 내용이 복사되어 있고 시험이 일치를 검사) |
| `supabase/admin/` | 칸 초기화·열기 SQL (관리자용) |
| `supabase/tests/rls_test.sql` | 사용자 분리 서버 시험 (되돌림 트랜잭션) |
| `tests/` | 자동 시험 (`node --test tests/*.test.mjs`, `python tests/ui_check.py`) |

## 서버를 붙일 때 순서 (새 Supabase 프로젝트 기준)

비밀번호·키·토큰을 사람이 입력하는 단계가 없습니다. 서버 비밀값(비밀번호를 섞는 값)은 SQL이 DB 안에 스스로 만들고, 로그인 함수는 Supabase가 자동으로 넣어 주는 서비스 키를 씁니다.

| 키·값 | 어디에 쓰나 | 넣는 곳 |
|---|---|---|
| 프로젝트 주소(URL) | 앱 | `js/config.js`의 `SUPABASE_URL` (공개 가능) |
| 공개용 키(anon 또는 `sb_publishable_...`) | 앱이 서버를 부를 때 | `js/config.js`의 `SUPABASE_ANON_KEY` (공개 가능) |
| 서비스 키(service_role / `sb_secret_...`) | 로그인 함수만 | **아무 데도 넣지 않는다.** 함수에 Supabase가 자동 주입. 이 파일들·화면에는 절대 넣지 않음 |
| 비밀번호를 섞는 값(pepper) | 로그인 함수 | SQL 0005가 DB(`pt_secret` 표)에 무작위로 한 번 만든다(다시 실행해도 덮어쓰지 않음, 앱은 읽을 수 없음, 바꾸면 모든 비밀번호가 무효) |

### 1. 프로젝트 설정
1. 새 프로젝트를 만든다(비용 확인 뒤). Authentication > Sign In / Providers에서 「Allow new users to sign up」을 끈다. Authentication > Sessions의 「Time-box」「Inactivity timeout」은 비워 둔다.
2. 사용자 칸 1·2·3과 로그인 계정은 따로 만들 필요가 없다. 사용자 칸 상태는 SQL(0005)이 만들고, 로그인 계정은 각자 처음 비밀번호를 정할 때 로그인 함수가 만든다.

### 2. SQL 붙여넣기 (SQL Editor에서 파일마다 새 쿼리에 전체를 붙여넣고 Run)
| 순서 | 파일 | 성공하면 나오는 것 |
|---|---|---|
| 1 | `supabase/migrations/0001_schema.sql` | `Success. No rows returned` |
| 2 | `supabase/migrations/0002_triggers.sql` | 같음 |
| 3 | `supabase/migrations/0003_rls.sql` | 같음 |
| 4 | `supabase/migrations/0004_functions.sql` | 같음 |
| 5 | `supabase/migrations/0005_secret_and_slots.sql` | 같음(비밀값과 사용자 칸 3개가 만들어짐. 값은 화면에 나오지 않음) |
- 중간에 오류가 나면 그 파일에서 멈추고 오류 문구를 그대로 기록한다(앞 파일은 다시 실행해도 된다. `if not exists`/`or replace`로 쓰여 있음). 이 SQL은 PostgreSQL 없이 눈으로만 점검했고 실제 실행은 처음이다.
- 확인: Table Editor에 `pt_apps, pt_auth_state, pt_history, pt_logs, pt_spends, pt_secret`이 보이고 모두 RLS가 켜져(Enabled) 있어야 한다. `pt_auth_state`에는 3줄(1·2=unset, 3=disabled)이 있어야 한다.

### 3. 로그인 함수 배포 (대시보드 편집기, CLI 없음)
1. Edge Functions > 「Deploy a new function」(또는 Via Editor) > 이름 `pt-auth`.
2. 편집기에 `supabase/functions/pt-auth/index.single.ts` **전체**를 붙여넣고 Deploy.
3. **함수 설정에서 「Verify JWT」(JWT 검증)를 반드시 끈다.** 로그인 전에 부르는 함수라 켜져 있으면 모든 호출이 401로 거절된다(함수 안에서 필요한 확인은 직접 한다).
4. 비밀값 설정은 필요 없다(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`는 자동 주입, 비밀번호를 섞는 값은 SQL 0005가 DB에 만들어 둠).

### 4. 키 확인과 앱 연결
- Project Settings > API에서 프로젝트 주소와 **공개용 키**만 확인해 `js/config.js`에 넣는다(공개 가능한 값). 서비스 키는 확인할 필요가 없다.
- **서버에서 확인 필요**: ①계정 이메일 `slotN@pt.example.com`(N=1·2·3)을 Supabase가 허용하는지(처음 비밀번호를 정할 때 계정이 만들어지므로 그때 확인됨. 거부되면 `logic.js`의 `slotEmail`을 바꾸고 `index.single.ts`의 같은 줄도 맞춘다) ②`SUPABASE_SERVICE_ROLE_KEY`가 새 형식(`sb_secret_...`)이면 함수가 `Authorization` 머리말 없이 `apikey`로만 보내도록 되어 있으나 실제 서버에서 확인한 적은 없다.

### 5. 서버 시험
`supabase/tests/rls_test.sql` 전체를 SQL Editor에서 실행한다(끝에서 ROLLBACK, 시험용 계정도 롤백됨).
- 예상: Messages에 `PASS: 사용자 분리 시험 통과 ...`와 `PASS: 설계 8절 8·9·10·11번 통과 ...` 두 줄. `FAIL: ...` 오류가 나면 멈추고 그 문구를 기록한다.
- 함수 확인: 앱을 열어 로그인 화면에 사용자 3칸(사용자1·2 「처음 사용」, 사용자3 「아직 사용할 수 없습니다」)이 보이면 함수와 표 연결이 된 것이다(비밀번호는 아직 정하지 않는다).

### 6. 앱 올리기
1. `js/config.js`에 공개용 값만 넣는다.
2. 새 공개 저장소를 만들고(승인 뒤) 이 폴더를 올린다. GitHub 저장소의 Settings > Pages > Build and deployment에서 Source를 「Deploy from a branch」, Branch를 `main` / `/ (root)`로 고르고 Save. 1~2분 뒤 `https://<계정>.github.io/<저장소>/`가 열린다.
3. 시험 화면(`?mock=1`)은 `localhost`·`127.0.0.1`에서만 열리고 배포 주소에서는 무시된다.
4. 사용자1 → 사용자2 순서로 곧바로 비밀번호를 정한다(정하기 전에는 주소를 다른 곳에 공유하지 않는다). 사용자3은 `supabase/admin/open_slot.sql`로 열고 곧바로 설정한다.
5. 화면 파일을 바꿔 올릴 때는 `js/config.js`의 `APP_BUILD`와 `sw.js`의 `CACHE` 숫자를 함께 올린다.

## 비밀번호·잠금 정책
- 비밀번호는 4자 이상(글자 종류 제한 없음), 흔한 값 거절. 설정 화면에서는 6자 이상을 권장한다고 안내한다.
- 한 칸에서 5번 틀리면 15분 잠금, 풀린 뒤 또 5번 틀리면 1시간(상한). 24시간 동안 틀림이 없으면 단계를 처음(15분)으로 되돌린다. 하루 잠금은 없다.
- 확인 **전에** 횟수를 먼저 올리고 맞으면 되돌리는 방식이라, 동시에 여러 번 보내도 5번까지만 확인한다.
- 이미 로그인된 기기는 잠금과 상관없이 계속 사용된다.

## 사용자 칸 관리

- 비밀번호를 잊은 경우: `supabase/admin/reset_slot.sql` (기록은 보존, 임시 잠금) → 본인이 준비되면 `open_slot.sql` → 곧바로 본인이 새 비밀번호 설정.
- 사용자3을 쓰게 될 때: `open_slot.sql`의 칸 번호를 3으로 두고 실행 → 곧바로 설정.
