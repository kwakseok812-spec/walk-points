"""폰의 시스템 글씨 크기(안드로이드 글자 배율 130/150/200%)를 키웠을 때 화면이 넘치는지 점검합니다. (O-0603)
안드로이드 WebView/크롬은 글자 배율을 「글자 크기(루트 글자 포함)만 키우고 화면 폭은 그대로」 적용합니다.
이를 흉내 내려고 html 글자 크기와 최소 글자 크기(--minfs)에 배율을 곱합니다.
실행: python tests/zoom_check.py            (기본: 390px·412px 폭, 6단계 x 배율 1.0/1.3/1.5/2.0, 밝게 + 어둡게 일부)
      python tests/zoom_check.py --quick    (390px, 배율 1.0/2.0만)
      python tests/zoom_check.py --shots    (대표 화면 그림을 shots/zoom_*.png 로 저장)
넘침이 하나라도 있으면 종료 코드 1."""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from ui_lib import *
from playwright.sync_api import sync_playwright

SHOTS = os.path.join(ROOT, 'shots')
FONTS = ['xxsmall', 'xsmall', 'small', 'normal', 'large', 'xlarge']
MINFS = {'xxsmall': 11, 'xsmall': 12, 'small': 14, 'normal': 16, 'large': 16, 'xlarge': 16}
QUICK = '--quick' in sys.argv
WANT_SHOTS = '--shots' in sys.argv

INIT = """(K) => {
  const css = `html{font-size:calc(var(--fs) * ${K}) !important}
html[data-font="xxsmall"]{--minfs:${11 * K}px !important}
html[data-font="xsmall"]{--minfs:${12 * K}px !important}
html[data-font="small"]{--minfs:${14 * K}px !important}
html:not([data-font="xxsmall"]):not([data-font="xsmall"]):not([data-font="small"]){--minfs:${16 * K}px !important}
.fo-sample{font-size:calc(var(--sz, 18px) * ${K}) !important}`;
  const put = () => { if (!document.documentElement || document.getElementById('__zoom')) return;
    const st = document.createElement('style'); st.id = '__zoom'; st.textContent = css; document.documentElement.appendChild(st); };
  put(); new MutationObserver(put).observe(document, { childList: true, subtree: true });

}"""

MEASURE = """() => {
  const issues = []; const vw = innerWidth; const vh = innerHeight;
  const de = document.documentElement;
  if (de.scrollWidth > vw + 1) issues.push('가로 밀림 ' + de.scrollWidth + '>' + vw);
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
  const sel = 'button,.card,.row,.chip-f,.chip-date,.display,.input,.seg-btn,.tab,.key,.notice,.banner,.sum,.dialog,.sheet,.font-opt,.toggle,.undo-bar,.hist li,.today-val,.big-btn,.badge,.tag';
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); if (!t) continue;
    const p = n.parentElement; if (!p || p.closest('noscript,script,style,.mock-flag,.toast')) continue;
    if (!vis(p)) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    const r = rg.getBoundingClientRect(); if (r.width === 0) continue;
    const label = t.slice(0, 14);
    if (r.right > vw + 1 || r.left < -1) issues.push('글자 화면 밖|' + label + '|' + Math.round(r.left) + '~' + Math.round(r.right));
    const c = p.closest(sel);
    if (c) {
      const cr = c.getBoundingClientRect();
      const inScroller = c.classList.contains('sheet') || c.classList.contains('dialog');
      const hOver = r.right > cr.right + 1 || r.left < cr.left - 1;
      const vOver = !inScroller && (r.bottom > cr.bottom + 1 || r.top < cr.top - 1);
      if (hOver || vOver) issues.push('글자가 칸 밖|' + (c.className || c.tagName) + '|' + label);
    }
  }
  document.querySelectorAll('*').forEach((e) => {
    if (!vis(e)) return;
    const cs = getComputedStyle(e);
    if (cs.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 2 && !e.classList.contains('sheet-body') && e.tagName !== 'HTML' && e.tagName !== 'BODY')
      issues.push('칸 안에서 잘림|' + (e.className || e.tagName) + '|' + e.scrollWidth + '>' + e.clientWidth);
  });
  document.querySelectorAll(sel).forEach((e) => {
    if (!vis(e) || e.classList.contains('sheet') || e.classList.contains('dialog') || e.classList.contains('toast')) return;
    if (e.scrollHeight > e.clientHeight + 2 && getComputedStyle(e).overflowY !== 'auto') issues.push('칸 높이가 내용보다 낮음|' + (e.className || e.tagName) + '|' + e.scrollHeight + '>' + e.clientHeight);
  });
  const dk = document.querySelector('.dock');
  if (dk && vis(dk)) {
    const dr = dk.getBoundingClientRect();
    if (!dk.classList.contains('flow') && dr.height > vh * 0.4) issues.push('아래 줄이 화면의 절반 가까이 차지|' + Math.round(dr.height) + '/' + vh);
    const main = document.querySelector('main');
    if (main) { const last = [...main.children].filter((c) => c !== dk && vis(c)).pop(); if (last) { const lr = last.getBoundingClientRect(); const scrollEnd = (window.scrollY + innerHeight) >= document.documentElement.scrollHeight - 2;
      if (scrollEnd && !dk.classList.contains('flow') && lr.bottom > dr.top + 1) issues.push('맨 아래 내용이 아래 줄에 가려짐|' + (last.className || last.tagName)); } }
  }
  const sh = document.querySelector('.sheet');
  if (sh) { const r = sh.getBoundingClientRect(); if (r.top < -1 || r.bottom > vh + 1 || r.left < -1 || r.right > vw + 1) issues.push('시트가 화면 밖|' + Math.round(r.top) + '~' + Math.round(r.bottom) + '/' + vh); }
  document.querySelectorAll('.sticky-save, .bottom, .undo-bar').forEach((e) => { if (!vis(e) || e.closest('.dock.flow')) return; const r = e.getBoundingClientRect(); if (r.bottom > vh + 1 || r.top < 0) issues.push('고정 단추가 화면 밖|' + e.className); });
  const dg = document.querySelector('.dialog');
  if (dg) { const r = dg.getBoundingClientRect(); if (r.top < -1 || r.bottom > vh + 1) issues.push('확인창이 화면 밖(안에서 스크롤)|' + Math.round(r.top) + '~' + Math.round(r.bottom)); }
  return issues;
}"""


def run_combo(b, width, height, scheme, font, K, results, shots=False):
    ctx = b.new_context(viewport={'width': width, 'height': height}, device_scale_factor=1 if not shots else 2, locale='ko-KR',
                        color_scheme=scheme, has_touch=True)
    ctx.add_init_script(script=f"({INIT})({K})")
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    tag = f'{width}px/{scheme}/{font}/x{K}'

    def m(label, shot=None):
        pg.wait_for_timeout(260)
        iss = pg.evaluate(MEASURE)
        results.append((tag, label, iss))
        if shots and shot:
            pg.screenshot(path=os.path.join(SHOTS, f'zoom_{shot}_{width}_{scheme}_{font}_x{K}.png'))

    def setfont():
        pg.evaluate(f"window.__pt.store.setFont('{font}')"); pg.wait_for_timeout(200)

    def softfont():  # 「처음 사용 글씨 고르기」가 뜨지 않게 값만 바꾼다(고름 표시는 안 함)
        pg.evaluate(f"window.__pt.store.state.settings.font = '{font}'; document.documentElement.dataset.font = '{font}'")
        pg.wait_for_timeout(150)

    def keys(d):
        for ch in d:
            pg.click(f'.key[data-k="{ch}"]')

    # --- 로그인 계열
    pg.goto(BASE + '?mock=1'); pg.wait_for_selector('.user-btn'); softfont()
    exp = {'xxsmall': 12, 'xsmall': 14, 'small': 16, 'normal': 18, 'large': 20.5, 'xlarge': 23}[font] * K
    got = pg.evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)")
    if abs(got - exp) > 0.05:
        results.append((tag, '배율 흉내가 적용되지 않음(시험 장치 오류)', [f'기대 {exp} 실제 {got}']))
    m('로그인 선택', 'login')
    pg.click('.user-btn[data-slot="1"]'); pg.wait_for_selector('[data-keep="pw1"]')
    pg.fill('[data-keep="pw1"]', 'wrongpw1'); pg.click('[data-act="login-go"]'); pg.wait_for_selector('.notice.err')
    m('로그인 틀림 안내')
    for _ in range(4):
        pg.click('[data-act="login-go"]'); pg.wait_for_timeout(100)
    m('로그인 잠김 안내')
    pg.click('[data-act="login-back"]'); pg.wait_for_selector('.user-btn')
    pg.click('.user-btn[data-slot="2"]'); pg.wait_for_selector('[data-keep="pw2"]')
    pg.fill('[data-keep="pw1"]', '1234'); pg.fill('[data-keep="pw2"]', '1234'); pg.click('[data-act="login-go"]')
    m('처음 사용 비밀번호 설정(오류 안내)', 'setup')
    pg.fill('[data-keep="pw1"]', 'my-pass-2'); pg.fill('[data-keep="pw2"]', 'my-pass-2'); pg.click('[data-act="login-go"]')
    pg.wait_for_selector('.sheet'); softfont()
    m('글씨 크기 고르기(처음 사용)', 'fontpick')
    pg.click('.font-opt[data-v="normal"]'); pg.wait_for_selector('.home'); setfont()
    m('홈(앱 없음)', 'home_empty')

    # --- 홈 이후
    pg.goto(BASE + '?mock=1&auto=1'); pg.wait_for_selector('.home'); setfont()
    m('홈', 'home')
    pg.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)'); m('홈 맨 아래')
    pg.evaluate('window.scrollTo(0, 0)')
    pg.click('.card >> nth=2'); pg.wait_for_selector('.sheet'); m('입력 시트(비어 있음)', 'log')
    keys('9999999'); m('입력 시트(큰 숫자 입력)', 'log_typed')
    pg.click('[data-act="save-log"]'); pg.wait_for_timeout(300)
    if pg.locator('.dialog').count():
        m('10배 확인창', 'dialog10')
        pg.click('.dlg-btns .big-btn >> nth=1'); pg.wait_for_selector('.sheet .display')
        for _ in range(7): pg.click('.key[data-k="bs"]')
        keys('1000'); pg.click('[data-act="save-log"]'); pg.wait_for_timeout(300)
        if pg.locator('.dialog').count():
            m('음수 확인창', 'dialogneg')
            pg.click('.dlg-btns .big-btn >> nth=0'); pg.wait_for_selector('[data-act="save-spend"]')
            m('사용 기록 시트', 'spend')
            pg.click('[data-act="close-sheet"] >> nth=1'); pg.wait_for_timeout(300)
    else:
        pg.wait_for_selector('.saved-head'); m('저장됨 시트', 'saved')
        pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    if pg.locator('.sheet').count():
        pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    pg.wait_for_selector('.home')
    pg.click('[data-act="add-app"]'); pg.wait_for_selector('[data-act="save-app"]'); m('앱 추가 시트', 'addapp')
    pg.click('[data-act="close-sheet"] >> nth=1'); pg.wait_for_timeout(300)
    pg.click('.today-val >> nth=0'); pg.wait_for_selector('[data-act="save-edit-log"]'); m('기록 고치기 시트', 'editlog')
    pg.click('[data-act="close-sheet"] >> nth=1'); pg.wait_for_timeout(300)
    pg.click('[data-act="go-records"]'); pg.wait_for_selector('.row'); m('기록 보기', 'records')
    pg.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)'); m('기록 보기 맨 아래'); pg.evaluate('window.scrollTo(0, 0)')
    pg.click('.chip-f[data-act="filter"] >> nth=1'); pg.wait_for_timeout(200); m('기록 보기(앱 고름)', 'records_f')
    pg.click('.row.spend >> nth=0') if pg.locator('.row.spend').count() else None
    pg.wait_for_timeout(250)
    if pg.locator('[data-act="save-edit-spend"]').count():
        m('사용 고치기 시트', 'editspend'); pg.click('[data-act="close-sheet"] >> nth=1'); pg.wait_for_timeout(300)
    pg.click('[data-act="go-trash"]'); pg.wait_for_selector('.trash-row'); m('휴지통', 'trash')
    pg.goto(BASE + '?mock=1&auto=1'); pg.wait_for_selector('.home'); setfont()
    pg.click('[data-act="go-settings"]'); pg.wait_for_selector('.seg'); m('설정', 'settings')
    pg.click('[data-act="pw-change"]'); pg.wait_for_selector('[data-act="save-pw"]'); m('비밀번호 바꾸기 시트', 'pw')
    pg.goto(BASE + '?mock=1&auto=1'); pg.wait_for_selector('.home'); setfont()
    pg.evaluate("window.__pt_demo.server.online = false")
    pg.click('.card >> nth=3'); pg.wait_for_selector('.sheet'); keys('3000'); pg.click('[data-act="save-log"]')
    pg.wait_for_selector('.saved-head'); m('오프라인 저장 시트', 'offline_saved')
    pg.click('[data-act="close-sheet"] >> nth=-1'); pg.wait_for_timeout(300)
    m('오프라인 홈(안내 줄·되돌리기 줄)', 'offline_home')
    if errs:
        results.append((tag, '스크립트 오류', errs[:2]))
    ctx.close()


def main():
    srv = start_server()
    results = []
    combos = []
    scales = [1.0, 2.0] if QUICK else [1.0, 1.3, 1.5, 2.0]
    for f in FONTS:
        for K in scales:
            combos.append((390, 844, 'light', f, K))
    if not QUICK:
        for f in FONTS:
            for K in (1.5, 2.0):
                combos.append((412, 915, 'light', f, K))
                combos.append((390, 844, 'dark', f, K))
        combos.append((360, 780, 'light', 'xlarge', 1.3))
        combos.append((750, 900, 'light', 'xlarge', 2.0))
    if WANT_SHOTS:
        combos = [(390, 844, 'light', f, K) for f, K in (('normal', 1.0), ('normal', 2.0), ('xlarge', 1.5), ('xxsmall', 2.0), ('xlarge', 2.0))] + [(390, 844, 'dark', 'xlarge', 2.0)]
    with sync_playwright() as p:
        b = p.chromium.launch()
        for (w, h, sc, f, K) in combos:
            try:
                run_combo(b, w, h, sc, f, K, results, WANT_SHOTS)
            except Exception as ex:  # 화면 흐름이 막혔다면 그 자체가 실패
                results.append((f'{w}px/{sc}/{f}/x{K}', '시험 흐름 중단', [str(ex)[:160]]))
        b.close()
    srv.shutdown()
    bad = [(t, l, i) for (t, l, i) in results if i]
    total = len(results)
    from collections import Counter
    byk = Counter()
    for t, l, i in bad:
        byk[(t.split('/')[3], l)] += 1
    print(f'점검한 화면 {total}곳, 넘침·잘림이 있는 곳 {len(bad)}곳')
    for t, l, i in bad[:80]:
        print('FAIL', t, l, '; '.join(i[:4]))
    if len(bad) > 80:
        print('... 외', len(bad) - 80, '곳')
    print('--- 배율·화면별 건수')
    for (k, l), c in sorted(byk.items()):
        print(' ', k, l, c)
    with open(os.path.join(ROOT, 'shots', '_zoom_result.json'), 'w', encoding='utf-8') as fh:
        json.dump([{'tag': t, 'screen': l, 'issues': i} for t, l, i in results], fh, ensure_ascii=False, indent=0)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
