"""폰 폭 화면 점검: 그림을 shots/ 에 남기고 화면 안 동작(눌러 보기)을 확인합니다.
실행: python tests/ui_check.py   (서버·크롬 앱 연동 도구 없이 Playwright 헤드리스로만 동작)"""
import sys, os, json, datetime
sys.path.insert(0, os.path.dirname(__file__))
from ui_lib import *
from playwright.sync_api import sync_playwright

SHOTS = os.path.join(ROOT, 'shots')
os.makedirs(SHOTS, exist_ok=True)
results = []


def check(name, cond, detail=''):
    results.append({'name': name, 'ok': bool(cond), 'detail': detail})
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))


def shot(pg, name, full=False, wait=500):
    pg.wait_for_timeout(wait)  # 움직임이 끝난 뒤
    pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)


def no_hscroll(pg, label):
    w = pg.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
    check(f'가로로 밀리지 않음: {label}', w[0] <= w[1], str(w))


def tap_sizes(pg, label, minh=56, scope=''):
    bad = pg.evaluate('''([minh, scope]) => {
      const out = [];
      document.querySelectorAll(scope + ' button:not([disabled]), ' + scope + ' .card, ' + scope + ' .chip-date').forEach(e => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.height < minh) out.push((e.className||e.tagName) + ':' + Math.round(r.height));
      });
      return out; }''', [minh, scope])
    check(f'누르는 곳 높이 {minh}px 이상: {label}', not bad, ', '.join(bad[:6]))


def clip_check(pg, label):
    """글자가 잘리거나 칸 밖으로 넘치는지(가로)"""
    bad = pg.evaluate('''() => {
      const out = [];
      document.querySelectorAll('.card *, .row *, .sheet *, .dialog *, .sum *, .bottom *, .login *').forEach(e => {
        if (e.children.length) return;
        if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible') out.push(e.className + '|' + e.textContent.slice(0, 12));
      });
      return out; }''')
    check(f'글자 잘림 없음: {label}', not bad, ', '.join(bad[:5]))


def keys(pg, digits):
    for ch in digits:
        pg.click(f'.key[data-k="{ch}"]')


def text(pg, sel):
    return pg.inner_text(sel)


def new_page(b, w, h, scheme='light', font=None):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, locale='ko-KR', color_scheme=scheme, has_touch=True)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.errs = errs
    return ctx, pg


def open_home(pg, font='normal'):
    pg.goto(BASE + '?mock=1&auto=1')
    pg.wait_for_selector('.home')
    if font != 'normal':
        pg.evaluate(f"window.__pt.store.setFont('{font}')")
    else:
        pg.evaluate("window.__pt.store.setFont('normal')")
    pg.wait_for_timeout(250)


srv = start_server()
with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------------- 로그인 화면 ----------------
    for scheme in ('light', 'dark'):
        ctx, pg = new_page(b, 390, 844, scheme)
        pg.goto(BASE + '?mock=1')
        pg.wait_for_selector('.user-btn')
        shot(pg, f'01_login_pick_{scheme}_390')
        if scheme == 'light':
            check('로그인: 사용자 3칸, 3번째는 눌러지지 않음', pg.locator('.user-btn').count() == 3 and pg.locator('.user-btn[disabled]').count() == 1)
            check('로그인: 아이디 입력 칸 없음', pg.locator('input').count() == 0)
            no_hscroll(pg, '로그인 선택'); tap_sizes(pg, '로그인 선택', 56)
            # 틀린 비밀번호 -> 남은 횟수 문구
            pg.click('.user-btn[data-slot="1"]')
            pg.wait_for_selector('[data-keep="pw1"]')
            pg.fill('[data-keep="pw1"]', 'wrongpw1')
            pg.click('[data-act="login-go"]')
            pg.wait_for_selector('.notice.err')
            check('로그인: 틀리면 「3번 더」가 아니라 남은 횟수를 쉬운 말로', '4번 더 해 볼 수 있어요' in text(pg, '.notice.err'), text(pg, '.notice.err'))
            shot(pg, '02_login_wrong_390')
            for _ in range(4):
                pg.click('[data-act="login-go"]'); pg.wait_for_timeout(120)
            check('로그인: 5번 틀리면 잠김 안내', '잠겼습니다' in text(pg, '.notice.err'), text(pg, '.notice.err'))
            shot(pg, '03_login_locked_390')
            pg.click('[data-act="login-back"]'); pg.wait_for_selector('.user-btn')
            check('로그인: 잠긴 칸은 선택 화면에서 눌러지지 않음', pg.locator('.user-btn[data-slot="1"][disabled]').count() == 1)
            check('로그인: 다른 칸(사용자2)은 그대로 사용 가능', pg.locator('.user-btn[data-slot="2"]:not([disabled])').count() == 1)
            # 처음 사용 설정
            pg.click('.user-btn[data-slot="2"]'); pg.wait_for_selector('[data-keep="pw2"]')
            check('처음 사용: 새 비밀번호 두 번 입력 화면', '처음이시군요' in text(pg, '.login'))
            shot(pg, '04_login_setup_390')
            pg.fill('[data-keep="pw1"]', '1234'); pg.fill('[data-keep="pw2"]', '1234'); pg.click('[data-act="login-go"]')
            check('처음 사용: 흔한 비밀번호 거절', '흔한' in text(pg, '.notice.err'), text(pg, '.notice.err'))
            pg.fill('[data-keep="pw1"]', 'my-pass-2'); pg.fill('[data-keep="pw2"]', 'my-pass-3'); pg.click('[data-act="login-go"]')
            check('처음 사용: 두 번 입력이 다르면 안내', '다릅니다' in text(pg, '.notice.err'))
            pg.fill('[data-keep="pw1"]', 'my-pass-2'); pg.fill('[data-keep="pw2"]', 'my-pass-2'); pg.click('[data-act="login-go"]')
            pg.wait_for_selector('.sheet')
            check('처음 사용: 정하면 바로 시작, 첫 화면은 글씨 크기 고르기', '글씨 크기' in text(pg, '.sheet'))
            shot(pg, '05_font_pick_390')
            pg.click('.font-opt[data-v="large"]')
            pg.wait_for_selector('.home')
            check('글씨 크기: 고르면 저장되어 화면에 반영', pg.evaluate("document.documentElement.dataset.font") == 'large')
            check('처음 사용: 앱이 하나도 없으면 안내 문구', '아직 등록한 걷기 앱이 없습니다' in text(pg, '.home'))
            shot(pg, '06_home_empty_390')
        ctx.close()

    # ---------------- 홈 (밝은/어두운, 접은/펼친) ----------------
    for scheme in ('light', 'dark'):
        for key, (w, h) in SIZES.items():
            ctx, pg = new_page(b, w, h, scheme)
            open_home(pg)
            shot(pg, f'10_home_{scheme}_{key}')
            if scheme == 'light' and w == 390:
                check('홈: 앱 카드 5개', pg.locator('.card').count() == 5)
                check('홈: 오늘 기록이 있는 카드 2개, 「오늘 아직」 3개', pg.locator('.today-val').count() == 2 and pg.locator('.chip-todo').count() == 3)
                check('홈: 비교 날짜 표기 「지난 기록(M/D) 대비」', '지난 기록(' in text(pg, '.cards') and '대비' in text(pg, '.cards'))
                check('홈: 차이에 +/기호 함께 표시', '+312' in text(pg, '.cards') and '▲' in text(pg, '.cards'))
                no_hscroll(pg, '홈 390'); tap_sizes(pg, '홈 390', 56); clip_check(pg, '홈 390')
                # 스크롤 후 아래 버튼이 가리지 않는지 (맨 아래까지 내렸을 때 마지막 카드가 보임)
                pg.evaluate('window.scrollTo(0, document.body.scrollHeight)'); pg.wait_for_timeout(200)
                shot(pg, '11_home_scrolled_light_390')
                last = pg.evaluate('''() => { const c = document.querySelectorAll('.card'); const r = c[c.length-1].getBoundingClientRect(); const b = document.querySelector('.bottom').getBoundingClientRect(); return [r.bottom, b.top]; }''')
                check('홈: 맨 아래로 내리면 마지막 카드가 아래 버튼 위에 보임', last[0] <= last[1] + 1, str(last))
            ctx.close()

    # ---------------- 글씨 아주 크게 ----------------
    for key, (w, h) in SIZES.items():
        ctx, pg = new_page(b, w, h, 'light')
        open_home(pg, 'xlarge')
        shot(pg, f'12_home_xlarge_{key}')
        no_hscroll(pg, f'홈 아주 크게 {key}'); clip_check(pg, f'홈 아주 크게 {key}')
        if w == 390:
            pg.click('.card >> nth=2'); pg.wait_for_selector('.sheet')
            shot(pg, '13_sheet_log_xlarge_390')
            no_hscroll(pg, '입력 시트 아주 크게'); clip_check(pg, '입력 시트 아주 크게')
            sheet_fit = pg.evaluate('''() => { const s = document.querySelector('.sheet').getBoundingClientRect(); return [s.top, s.bottom, innerHeight]; }''')
            check('입력 시트(아주 크게): 화면 안에 들어오고 저장 단추가 보임(시트 안에서 스크롤)', sheet_fit[0] >= 0 and sheet_fit[1] <= sheet_fit[2] + 1, str(sheet_fit))
            pg.click('[data-act="close-sheet"] >> nth=1')
            pg.wait_for_timeout(250)
            pg.evaluate("window.__pt.store.setFont('xlarge')")
            pg.click('[data-act="go-records"]'); pg.wait_for_selector('.row')
            shot(pg, '14_records_xlarge_390'); no_hscroll(pg, '기록 보기 아주 크게'); clip_check(pg, '기록 보기 아주 크게')
        ctx.close()

    # ---------------- 입력 시트·저장·다음 앱·확인창 (390 밝게) ----------------
    ctx, pg = new_page(b, 390, 844, 'light')
    open_home(pg)
    names = pg.eval_on_selector_all('.c-name', 'els => els.map(e => e.textContent)')
    pg.click('.card >> nth=2')  # 에이헬스 (오늘 아직)
    pg.wait_for_selector('.sheet')
    shot(pg, '20_sheet_log_empty_390')
    check('입력 시트: 숫자판이 바로 열려 있음', pg.locator('.numpad .key').count() == 12)
    check('입력 시트: 직전 값이 보임', '지난 기록(' in text(pg, '.sheet'))
    keys(pg, '11500')
    check('입력 시트: 누른 숫자가 큰 글씨로 나옴(천 단위 쉼표)', text(pg, '.display').strip() == '11,500', text(pg, '.display'))
    check('입력 시트: 저장 전에 차이 미리보기', '대비' in text(pg, '.preview'), text(pg, '.preview'))
    shot(pg, '21_sheet_log_typed_390')
    tap_sizes(pg, '입력 시트', 56, '.sheet')
    check('입력 시트: 날짜 칩(오늘)', '오늘' in text(pg, '.chip-date'))
    pg.click('[data-act="save-log"]'); pg.wait_for_selector('.saved-head')
    check('저장 뒤 「저장됨」과 다음 앱 버튼', '저장됨' in text(pg, '.sheet') and pg.locator('[data-act="next-app"]').count() == 1)
    check('저장 뒤 되돌리기 버튼(남은 초 표시)', pg.locator('[data-act="undo-sheet"] .count').count() == 1)
    shot(pg, '22_saved_390', wait=1000)
    nxt = text(pg, '[data-act="next-app"]')
    check('[다음 앱]은 오늘 기록 전인 앱(토스 만보기)으로', '토스 만보기' in nxt, nxt)
    pg.click('[data-act="next-app"]'); pg.wait_for_selector('.sheet .display')
    check('[다음 앱]을 누르면 그 앱의 숫자판이 열림', '토스 만보기' in text(pg, '.sheet-head'))
    # 10배 이상 확인창
    keys(pg, '99999')
    pg.click('[data-act="save-log"]'); pg.wait_for_selector('.dialog')
    check('10배 이상 늘면 저장 전 확인창', '10배 이상' in text(pg, '.dialog'), text(pg, '.dialog'))
    shot(pg, '23_dialog_10x_390')
    pg.click('.dlg-btns .big-btn >> nth=1')  # 다시 입력
    pg.wait_for_selector('.sheet .display')
    check('확인창에서 「다시 입력」하면 숫자가 그대로 남아 있음', text(pg, '.display').strip() == '99,999')
    # 음수 차이 -> 사용으로 기록
    for _ in range(6): pg.click('.key[data-k="bs"]')
    keys(pg, '1000')
    pg.click('[data-act="save-log"]'); pg.wait_for_selector('.dialog')
    check('음수 차이: 「사용으로 기록」 안내 확인창', '줄었습니다' in text(pg, '.dialog') and '사용으로 기록' in text(pg, '.dialog'))
    shot(pg, '24_dialog_negative_390')
    pg.click('.dlg-btns .big-btn >> nth=0')
    pg.wait_for_selector('[data-act="save-spend"]')
    check('「사용으로 기록」을 누르면 사용 화면으로 줄어든 값이 미리 입력됨', text(pg, '.display').replace('-', '').strip() == '1,640', text(pg, '.display'))
    check('사용 화면: 사용처 칩에 「현금 전환」 포함, 기본 선택', '현금 전환' in text(pg, '.mini-chips') and pg.locator('.chip-f.on').inner_text() == '현금 전환')
    shot(pg, '25_sheet_spend_390')
    pg.click('[data-act="save-spend"]'); pg.wait_for_selector('.saved-head')
    check('사용 저장 뒤 남은 잔액 표시', '남은 잔액' in text(pg, '.sheet'))
    shot(pg, '26_saved_spend_390', wait=1000)
    pg.click('[data-act="undo-sheet"]'); pg.wait_for_selector('.home')
    pg.wait_for_timeout(300)
    check('되돌리기를 누르면 사용 기록이 사라짐', pg.evaluate("window.__pt.store.state.spends.filter(s => !s.deleted_at && s.memo === '현금 전환').length") == 1)  # 처음부터 있던 1건만
    # 앱 추가
    pg.click('[data-act="add-app"]'); pg.wait_for_selector('[data-act="save-app"]')
    shot(pg, '27_sheet_addapp_390')
    check('앱 추가: 「앱 화면에 보이는 총 포인트를 그대로 적으세요」 안내', '총 포인트' in text(pg, '.sheet') and '그대로 적으세요' in text(pg, '.sheet'))
    pg.click('.chip-f[data-act="pick-name"] >> nth=0'); keys(pg, '777')
    pg.click('[data-act="save-app"]'); pg.wait_for_selector('.saved-head')
    check('앱 추가: 이름 칩 + 숫자로 첫 기록까지 저장', '앱을 추가했습니다' in text(pg, '.sheet'))
    pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    check('앱 추가 뒤 홈에 카드 6개', pg.locator('.card').count() == 6)
    ctx.close()

    # ---------------- 수정 창·이전 값·지우기·휴지통·기록 보기 ----------------
    ctx, pg = new_page(b, 390, 844, 'light')
    open_home(pg)
    pg.click('.today-val >> nth=0'); pg.wait_for_selector('[data-act="save-edit-log"]')
    shot(pg, '30_edit_log_390')
    check('수정: 홈의 오늘 값을 누르면 바로 수정 창', '기록 고치기' in text(pg, '.sheet-head'))
    check('수정: 현재 값이 미리 들어 있음', text(pg, '.display').strip() != '')
    first_val = text(pg, '.display').strip()
    keys(pg, '9')  # 첫 글자는 기존 값을 바꿔 쓰기
    check('수정: 숫자를 누르면 기존 값을 바꿔 쓰기 시작', text(pg, '.display').strip() == '9', text(pg, '.display'))
    for _ in range(2): pg.click('.key[data-k="bs"]')
    keys(pg, first_val.replace(',', ''))
    # 값을 조금 고쳐 저장하고 이전 값 목록 확인
    pg.click('.key[data-k="bs"]'); keys(pg, '0')
    pg.click('[data-act="save-edit-log"]')
    pg.wait_for_timeout(400)
    if pg.locator('.dialog').count():
        pg.click('.dlg-btns .big-btn >> nth=0')
    pg.wait_for_selector('.saved-head')
    check('수정 저장 뒤 「고쳤습니다」', '고쳤습니다' in text(pg, '.sheet'))
    pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    pg.click('.today-val >> nth=0'); pg.wait_for_selector('.hist li')
    shot(pg, '31_edit_log_history_390')
    check('수정 창 안에 「이전 값」 목록', pg.locator('.hist li').count() >= 1)
    pg.click('[data-act="hist-restore"] >> nth=0'); pg.wait_for_selector('.saved-head')
    check('이전 값 눌러 복원', '이전 값으로' in text(pg, '.sheet'))
    pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    # 기록 보기
    pg.click('[data-act="go-records"]'); pg.wait_for_selector('.row')
    shot(pg, '32_records_390')
    check('기록 보기: 앱 칩 필터와 「전체」', pg.locator('.chip-f').count() == 6)
    check('기록 보기: 지출 행도 같은 목록에 보임', pg.locator('.row.spend').count() >= 1)
    no_hscroll(pg, '기록 보기'); tap_sizes(pg, '기록 보기', 56); clip_check(pg, '기록 보기')
    pg.click('.row.spend >> nth=0'); pg.wait_for_selector('[data-act="save-edit-spend"]')
    shot(pg, '33_edit_spend_390')
    check('지출도 같은 수정 창(고치기/지우기)', pg.locator('[data-act="delete-spend"]').count() == 1)
    pg.click('[data-act="close-sheet"] >> nth=1'); pg.wait_for_timeout(250)
    pg.click('.chip-f[data-act="filter"] >> nth=1'); pg.wait_for_timeout(200)
    check('기록 보기: 앱 필터를 고르면 이름 바꾸기·앱 없애기 줄', pg.locator('[data-act="remove-app"]').count() == 1)
    shot(pg, '34_records_filtered_390')
    # 기록 하나 지우기 -> 휴지통
    pg.click('.row >> nth=0'); pg.wait_for_selector('[data-act="delete-log"], [data-act="delete-spend"]')
    pg.click('[data-act="delete-log"], [data-act="delete-spend"]'); pg.wait_for_selector('.dialog')
    shot(pg, '35_dialog_delete_390')
    check('지우기 전 확인창(휴지통 30일 안내)', '30일' in text(pg, '.dialog'))
    pg.click('.dlg-btns .big-btn >> nth=0'); pg.wait_for_selector('.saved-head')
    check('지운 뒤 「지웠습니다」와 되돌리기', '지웠습니다' in text(pg, '.sheet') and pg.locator('[data-act="undo-sheet"]').count() == 1)
    pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    shot(pg, '36_records_undo_bar_390')
    pg.click('[data-act="go-trash"]'); pg.wait_for_selector('.trash-row')
    shot(pg, '37_trash_390')
    check('휴지통: 항목마다 남은 일수와 되살리기', '일 뒤 완전히 지워집니다' in text(pg, '.list') and pg.locator('[data-act="restore"]').count() >= 2)
    n0 = pg.locator('.trash-row').count()
    pg.click('[data-act="restore"] >> nth=0'); pg.wait_for_timeout(400)
    check('휴지통: 되살리면 목록에서 빠짐', pg.locator('.trash-row').count() == n0 - 1)
    ctx.close()

    # ---------------- 설정 ----------------
    ctx, pg = new_page(b, 390, 844, 'light')
    open_home(pg)
    pg.click('[data-act="go-settings"]'); pg.wait_for_selector('.seg')
    shot(pg, '40_settings_390'); no_hscroll(pg, '설정'); tap_sizes(pg, '설정', 56)
    check('설정: 로그아웃이 맨 아래 한 곳', pg.locator('[data-act="logout"]').count() == 1 and pg.evaluate('''() => { const all=[...document.querySelectorAll("[data-act=logout]")]; const b = document.querySelector("[data-act=logout]").getBoundingClientRect().bottom; return [...document.querySelectorAll("button")].every(x => x.getBoundingClientRect().bottom <= b + 1); }'''))
    pg.click('[data-act="pw-change"]'); pg.wait_for_selector('[data-act="save-pw"]')
    shot(pg, '41_pw_change_390')
    ctx.close()

    # ---------------- 움직임 줄이기 ----------------
    ctx, pg = new_page(b, 390, 844, 'light')
    open_home(pg)
    pg.evaluate("window.__pt.store.setReduceMotion(true)"); pg.wait_for_timeout(200)
    d = pg.evaluate("getComputedStyle(document.querySelector('.card')).transitionDuration")
    check('움직임 줄이기: 설정하면 움직임 시간이 거의 0', d.startswith('1e-') or d in ('0s', '0.001ms', '1e-6s'), d)
    ctx.close()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, reduced_motion='reduce', locale='ko-KR')
    pg = ctx.new_page(); pg.goto(BASE + '?mock=1&auto=1'); pg.wait_for_selector('.home')
    d = pg.evaluate("getComputedStyle(document.querySelector('.press-card')).transitionDuration")
    check('움직임 줄이기: 폰의 「움직임 줄이기」 설정도 따름', d.startswith('1e-') or d == '0s', d)
    ctx.close()

    # ---------------- 펼친 화면(750) 시트들 ----------------
    ctx, pg = new_page(b, 750, 900, 'light')
    open_home(pg)
    pg.click('.card >> nth=0'); pg.wait_for_selector('.sheet'); keys(pg, '123')
    shot(pg, '50_sheet_log_open_750')
    no_hscroll(pg, '시트 750')
    pg.click('[data-act="close-sheet"] >> nth=1'); pg.wait_for_timeout(250)
    pg.click('[data-act="go-records"]'); pg.wait_for_selector('.row'); shot(pg, '51_records_open_750')
    ctx.close()

    ctx, pg = new_page(b, 390, 844, 'dark')
    open_home(pg)
    pg.click('.card >> nth=0'); pg.wait_for_selector('.sheet'); keys(pg, '4567')
    shot(pg, '52_sheet_log_dark_390')
    pg.click('[data-act="close-sheet"] >> nth=1'); pg.wait_for_timeout(250)
    pg.click('[data-act="go-records"]'); pg.wait_for_selector('.row'); shot(pg, '53_records_dark_390')
    pg.click('[data-act="go-trash"]'); pg.wait_for_selector('.trash-row'); shot(pg, '54_trash_dark_390')
    ctx.close()

    # ---------------- 오프라인 입력·재전송 / 빠진 날 소급 ----------------
    ctx, pg = new_page(b, 390, 844, 'light')
    open_home(pg)
    pg.evaluate("window.__pt_demo.server.online = false")
    pg.click('.card >> nth=3'); pg.wait_for_selector('.sheet'); keys(pg, '3000')
    pg.click('[data-act="save-log"]'); pg.wait_for_selector('.saved-head')
    check('오프라인 저장: 「임시로 저장했습니다」 + 아직 올라가지 않음 안내(「저장됨」이라 하지 않음)', '임시로 저장했습니다' in text(pg, '.sheet') and '아직 올라가지 않았습니다' in text(pg, '.sheet') and '저장됨' not in text(pg, '.sheet'), text(pg, '.sheet')[:80])
    shot(pg, '60_offline_saved_390', wait=1000)
    pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    check('오프라인: 홈 위에 안내 줄과 카드에 「아직 올라가지 않음」 표시', '인터넷에 연결되어 있지 않습니다' in text(pg, '.banner') and pg.locator('.badge').count() >= 1)
    shot(pg, '61_offline_home_390')
    pg.evaluate("window.__pt_demo.server.online = true; window.__pt.store.sync()"); pg.wait_for_timeout(600)
    check('연결이 돌아오면 자동으로 올라가고 표시가 사라짐', pg.locator('.badge').count() == 0 and pg.locator('.banner').count() == 0)
    # 소급: 그제 날짜로 빠진 기록 채우기 (신한 쏠 야보는 어제 기록만 있음)
    yday = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
    pg.click('.card >> nth=4'); pg.wait_for_selector('.sheet')
    pg.fill('input[data-keep="date"]', yday); pg.wait_for_timeout(200)
    keys(pg, '700')
    check('날짜 칩으로 지난 날짜를 고르면 칩 글자가 바뀜', '오늘' not in text(pg, '.chip-date'), text(pg, '.chip-date'))
    pg.click('[data-act="save-log"]'); pg.wait_for_timeout(300)
    if pg.locator('.dialog').count(): pg.click('.dlg-btns .big-btn >> nth=1')
    pg.wait_for_selector('.saved-head', timeout=5000)
    check('빠진 날 소급 저장: 이후 날짜의 차이도 다시 계산했다고 안내', '이후 1일의 차이도 다시 계산했습니다' in text(pg, '.sheet'), text(pg, '.sheet')[:120])
    shot(pg, '62_backfill_saved_390', wait=1000)
    ctx.close()

    # 오류 없음
    ctx, pg = new_page(b, 390, 844, 'light')
    open_home(pg)
    pg.click('.card >> nth=0'); pg.wait_for_selector('.sheet'); keys(pg, '1')
    check('화면 오류(콘솔 에러) 없음', not pg.errs, str(pg.errs[:3]))
    ctx.close()
    b.close()
srv.shutdown()

ok = sum(1 for r in results if r['ok'])
print(f'\n== {ok}/{len(results)} 통과 ==')
json.dump(results, open(os.path.join(SHOTS, '_ui_results.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
sys.exit(0 if ok == len(results) else 1)
