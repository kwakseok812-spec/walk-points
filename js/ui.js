// ui.js - 화면 그리기와 누르기 처리. 계산은 calc.js, 저장은 store.js 가 맡습니다.
import * as C from './calc.js';
import { SaveError } from './store.js';
import { ApiError, NetworkError } from './data.js';
import { validatePassword, SLOT_LABEL } from '../supabase/functions/pt-auth/logic.js';
import { APP_VERSION } from './config.js';

const SUGGEST_APPS = ['캐시워크', '손목닥터', '에이헬스', '토스 만보기', '신한 쏠 야보', '오늘의 만보기'];
const SPEND_MEMOS = ['현금 전환', '기프티콘', '쇼핑', '기부', '기타'];
const FONT_LABEL = { xxsmall: '가장 작게', xsmall: '아주 작게', small: '작게', normal: '보통', large: '크게', xlarge: '아주 크게' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = C.fmtNum;

const ICON = {
  check: '<svg class="ic-check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3"/><path d="M15 27l8 8 14-16" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  caret: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  foot: '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><ellipse cx="22" cy="40" rx="9" ry="14" fill="currentColor"/><circle cx="14" cy="22" r="3.4" fill="currentColor"/><circle cx="21" cy="18" r="3.4" fill="currentColor"/><circle cx="28.5" cy="19" r="3.2" fill="currentColor"/><ellipse cx="44" cy="30" rx="9" ry="14" fill="currentColor" opacity=".55"/></svg>',
};

export function createUI({ root, store, haptics = true, onReload }) {
  const S = store.state;
  const ui = {
    screen: 'home', // home | records | trash | settings
    login: { step: 'pick', slot: null, error: '', busy: false, show: false },
    sheet: null,
    dialog: null,
    filterApp: 'all',
    busy: false,
    notice: '',
  };
  let renderQueued = false;
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.setAttribute('role', 'status');
  document.body.appendChild(toast);

  /* ============================== 보조 ============================== */
  const appName = (id) => (S.apps.find((a) => a.id === id) || {}).name || '';
  const todayStr = () => store.today();
  const mdw = (d) => C.fmtLongDate(d);
  const parseDigits = (d) => (d ? parseInt(d, 10) : NaN);
  const slotLabel = (n) => SLOT_LABEL[n] || `사용자${n}`;
  function buzz() { try { if (haptics && navigator.vibrate && !S.settings.reduceMotion) navigator.vibrate(8); } catch { /* 지원 안 함 */ } }

  function diffHtml(diff, prev) {
    if (diff === null || diff === undefined) return '<span class="muted">첫 기록입니다</span>';
    const cls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : 'zero';
    const sign = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
    return `<span class="diff ${cls}"><span aria-hidden="true">${sign}</span> ${C.fmtDiff(diff)}</span> <span class="muted small">지난 기록(${C.fmtMD(prev.log_date)}) 대비</span>`;
  }

  /* ============================== 그리기 ============================== */
  function render() {
    renderQueued = false;
    const el = document.activeElement;
    const keep = el && el.dataset && el.dataset.keep ? { k: el.dataset.keep, s: el.selectionStart, e: el.selectionEnd } : null;
    const vals = {};
    root.querySelectorAll('[data-keep]').forEach((i) => { vals[i.dataset.keep] = i.value; });

    const sb = root.querySelector('.sheet-body'); const sbTop = sb ? sb.scrollTop : 0; const winY = window.scrollY;
    const html = S.phase === 'login' ? loginHtml() : S.phase === 'app' ? appHtml() : '<div class="boot">불러오는 중입니다…</div>';
    root.innerHTML = html + sheetHtml() + dialogHtml();
    { const nb = root.querySelector('.sheet-body'); if (nb && sbTop) nb.scrollTop = sbTop; if (winY && Math.abs(window.scrollY - winY) > 1) window.scrollTo(0, winY); }
    fitDisplays(); fitDock();
    document.documentElement.dataset.font = S.settings.font;
    document.documentElement.dataset.reduce = S.settings.reduceMotion ? '1' : '0';

    root.querySelectorAll('[data-keep]').forEach((i) => { if (vals[i.dataset.keep] !== undefined && i.dataset.restore !== '0') i.value = vals[i.dataset.keep]; });
    if (keep) {
      const n = root.querySelector(`[data-keep="${keep.k}"]`);
      if (n) { n.focus(); try { n.setSelectionRange(keep.s, keep.e); } catch { /* 숫자·날짜 칸 */ } }
    }
    const af = root.querySelector('[data-autofocus]');
    if (af && !keep && !ui._focused) { af.focus(); }
    ui._focused = !!af;
    document.body.classList.toggle('no-scroll', !!ui.sheet || !!ui.dialog);
    toast.textContent = ui.notice; toast.classList.toggle('show', !!ui.notice);
  }
  const rerender = () => { if (!renderQueued) { renderQueued = true; queueMicrotask(render); } };

  /* ---------------------------- 로그인 ---------------------------- */
  function loginHtml() {
    const L = ui.login;
    if (L.step === 'pick') {
      const slots = S.slots.length ? S.slots : [1, 2, 3].map((s) => ({ slot: s, state: 'set', locked_until: null }));
      const btns = slots.map((s) => {
        const locked = s.locked_until && Date.parse(s.locked_until) > store.now();
        let sub = ''; let dis = false;
        if (s.state === 'disabled') { sub = '아직 사용할 수 없습니다'; dis = true; }
        else if (locked) { sub = `잠겼습니다 (${Math.max(1, Math.ceil((Date.parse(s.locked_until) - store.now()) / 60000))}분 뒤)`; dis = true; }
        else if (s.state === 'unset') sub = '처음 사용';
        else if (S.lastSlot === s.slot) sub = '마지막으로 쓴 사용자';
        return `<button class="big-btn user-btn press ${dis ? 'is-off' : ''}" data-act="pick-user" data-slot="${s.slot}" ${dis ? 'disabled' : ''}><span class="u-name">${slotLabel(s.slot)}</span><span class="u-sub">${sub}</span></button>`;
      }).join('');
      const off = !S.online ? '<p class="notice warn">인터넷에 연결되어 있지 않습니다. 연결한 뒤 다시 열어 주세요.</p>' : '';
      const re = S.needReauth ? '<p class="notice">로그인이 풀렸습니다. 비밀번호를 한 번만 다시 입력해 주세요.</p>' : '';
      return `<main class="login"><div class="login-head"><div class="logo-foot">${ICON.foot}</div><h1>걷기 포인트</h1><p class="lead">누구신가요?</p></div>${re}${off}<div class="stack">${btns}</div><p class="ver">버전 ${esc(APP_VERSION)}</p></main>`;
    }
    const first = L.step === 'setup';
    const t = first
      ? `<p class="lead">처음이시군요.<br>사용할 비밀번호를 정해 주세요.</p><p class="muted">4자 이상이면 되지만 6자 이상을 권장합니다. 숫자 6자리도 좋습니다.</p>`
      : `<p class="lead">비밀번호를 입력해 주세요.</p>`;
    const type = L.show ? 'text' : 'password';
    return `<main class="login"><button class="back press" data-act="login-back" aria-label="뒤로">${ICON.back}<span>다른 사용자</span></button>
      <div class="login-head small"><h1>${slotLabel(L.slot)}</h1>${S.needReauth && !first ? '<p class="notice">로그인이 풀렸습니다. 비밀번호를 한 번만 다시 입력해 주세요.</p>' : ''}${t}</div>
      <label class="field"><span class="lbl">${first ? '새 비밀번호' : '비밀번호'}</span><input class="input" data-keep="pw1" data-autofocus type="${type}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="${first ? 'next' : 'go'}"></label>
      ${first ? `<label class="field"><span class="lbl">한 번 더 입력</span><input class="input" data-keep="pw2" type="${type}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></label>` : ''}
      <button class="link press" data-act="toggle-show">${L.show ? '가리기' : '비밀번호 보기'}</button>
      ${L.error ? `<p class="notice err" role="alert">${esc(L.error)}</p>` : ''}
      <button class="big-btn primary press" data-act="login-go" ${L.busy ? 'disabled' : ''}>${L.busy ? '확인 중…' : first ? '정하고 시작하기' : '열기'}</button></main>`;
  }

  /* ---------------------------- 본 화면 ---------------------------- */
  function appHtml() {
    if (ui.screen === 'records') return recordsHtml();
    if (ui.screen === 'trash') return trashHtml();
    if (ui.screen === 'settings') return settingsHtml();
    return homeHtml();
  }

  function banners() {
    let b = '';
    const pend = S.outbox.reduce((n, e) => n + e.steps.reduce((m, s) => m + (s.rows ? s.rows.length : 1), 0), 0);
    if (!S.online) b += `<div class="banner warn">인터넷에 연결되어 있지 않습니다.${pend ? ` 올라가지 않은 기록 ${pend}건은 연결되면 자동으로 올라갑니다.` : ' 저장된 기록을 보여 드리는 중입니다.'}</div>`;
    else if (pend) b += `<div class="banner warn">올라가지 않은 기록 ${pend}건을 올리는 중입니다.</div>`;
    if (S.failed.length) b += `<div class="banner err"><div>올리지 못한 기록 ${S.failed.length}건이 있습니다.<br><span class="small">${esc(S.failed[0].message)}</span></div><div class="b-btns"><button class="mini press" data-act="retry-failed">다시 시도</button><button class="mini ghost press" data-act="discard-failed">버리기</button></div></div>`;
    if (S.needReauth) b += `<div class="banner err">로그인이 풀렸습니다. <button class="mini press" data-act="reauth">비밀번호 다시 입력</button></div>`;
    return b;
  }

  function homeHtml() {
    const sums = store.summaries();
    const pend = store.pendingIds();
    const total = store.totalBalance();
    const t = todayStr();
    const cards = sums.map((s) => {
      const a = s.app;
      const hasToday = !!s.todayLog;
      const todayBlock = hasToday
        ? `<button class="today-val press" data-act="edit-log" data-id="${s.todayLog.id}" aria-label="오늘 값 고치기"><span class="tv-lbl">오늘</span><span class="tv-num">${num(s.todayLog.total)}</span><span class="tv-edit">고치기</span></button>
           <div class="c-diff">${diffHtml(s.diff, s.prev)}${pend.has(s.todayLog.id) ? ' <span class="badge">아직 올라가지 않음</span>' : ''}</div>`
        : `<div class="today-none"><span class="chip-todo">오늘 아직</span>${s.lastLog ? `<span class="muted small">마지막 기록 ${C.fmtMD(s.lastLog.log_date)} · ${num(s.lastLog.total)}</span>` : '<span class="muted small">기록이 없습니다</span>'}</div>`;
      return `<article class="card press-card" data-act="open-app" data-id="${a.id}" role="button" tabindex="0">
        <div class="c-top"><h2 class="c-name">${esc(a.name)}</h2><div class="c-bal"><span class="b-lbl">잔액</span><span class="b-num">${s.balance === null ? '-' : num(s.balance)}</span></div></div>
        ${todayBlock}</article>`;
    }).join('');
    const empty = `<div class="empty"><div class="empty-foot">${ICON.foot}</div><p class="lead">아직 등록한 걷기 앱이 없습니다.</p><p class="muted">아래 「앱 추가」를 눌러 처음 한 번만 등록해 주세요.</p></div>`;
    return `<main class="home">
      <header class="top"><div><div class="date">${mdw(t)}</div><div class="who">${slotLabel(S.slot)}</div></div>
        <button class="set-btn press" data-act="go-settings" aria-label="설정">${ICON.gear}<span>설정</span></button></header>
      <section class="sum"><span class="sum-lbl">전체 잔액</span><span class="sum-num">${num(total)}</span></section>
      ${banners()}
      <section class="cards">${sums.length ? cards : empty}</section>
      ${dockHtml(undoBarHtml(), '<nav class="bottom"><button class="big-btn press" data-act="go-records">기록 보기</button><button class="big-btn primary press" data-act="add-app">앱 추가</button></nav>')}</main>`;
  }

  // 아래에 붙는 줄(되돌리기 줄 + 아래 단추). 글씨가 커져 단추가 두 줄이 되어도 서로 겹치거나 내용을 가리지 않게 한 덩어리로 묶는다.
  function dockHtml(undo, nav) { return undo || nav ? `<div class="dock">${undo}${nav}</div>` : ''; }

  function undoBarHtml() {
    const u = S.undo;
    if (!u || ui.sheet) return '';
    const left = Math.max(0, Math.ceil((u.expires - store.now()) / 1000));
    if (left <= 0) return '';
    const enter = !u._in; u._in = true; // 나타나는 움직임은 처음 한 번만 (다시 그려도 깜빡이지 않게)
    return `<div class="undo-bar${enter ? ' enter' : ''}" role="status"><span>${u.status === 'queued' ? '임시로 저장했습니다 (아직 올라가지 않음)' : `방금 ${esc(u.label)}`}</span><button class="undo-btn press" data-act="undo">되돌리기 <span class="count">${left}</span></button></div>`;
  }

  /* ---------------------------- 기록 보기 ---------------------------- */
  function recordRows() {
    const act = new Map(store.activeApps().map((a) => [a.id, a]));
    const fid = ui.filterApp === 'all' ? null : ui.filterApp;
    const rows = [];
    for (const l of S.logs) if (!l.deleted_at && act.has(l.app_id) && (!fid || l.app_id === fid)) rows.push({ k: 'log', r: l, t: Date.parse(l.recorded_at), d: l.log_date });
    for (const s of S.spends) if (!s.deleted_at && act.has(s.app_id) && (!fid || s.app_id === fid)) rows.push({ k: 'spend', r: s, t: Date.parse(s.spent_at), d: C.kstDate(s.spent_at) });
    return rows.sort((a, b) => (a.d === b.d ? b.t - a.t : a.d < b.d ? 1 : -1));
  }

  function recordsHtml() {
    const pend = store.pendingIds();
    const apps = store.activeApps();
    const chips = [`<button class="chip-f press ${ui.filterApp === 'all' ? 'on' : ''}" data-act="filter" data-id="all">전체</button>`]
      .concat(apps.map((a) => `<button class="chip-f press ${ui.filterApp === a.id ? 'on' : ''}" data-act="filter" data-id="${a.id}">${esc(a.name)}</button>`)).join('');
    const rows = recordRows().map((x) => {
      const showApp = ui.filterApp === 'all';
      if (x.k === 'log') {
        const { diff, prev } = C.logDiff(S.logs, S.spends, x.r);
        return `<button class="row press" data-act="edit-log" data-id="${x.r.id}"><div class="r-l"><div class="r-date">${C.fmtMD(x.r.log_date)} <span class="muted">${C.fmtLongDate(x.r.log_date).slice(-3)}</span></div>${showApp ? `<div class="r-app">${esc(appName(x.r.app_id))}</div>` : ''}</div>
          <div class="r-m"><div class="r-val">${num(x.r.total)}</div><div class="r-sub">${diff === null ? '첫 기록' : `<span class="diff ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : 'zero'}">${diff > 0 ? '▲' : diff < 0 ? '▼' : ''} ${C.fmtDiff(diff)}</span> <span class="muted small">${C.fmtMD(prev.log_date)} 대비</span>`}${pend.has(x.r.id) ? ' <span class="badge">올라가지 않음</span>' : ''}</div></div></button>`;
      }
      return `<button class="row spend press" data-act="edit-spend" data-id="${x.r.id}"><div class="r-l"><div class="r-date">${C.fmtMD(x.d)} <span class="muted">${C.fmtLongDate(x.d).slice(-3)}</span></div>${showApp ? `<div class="r-app">${esc(appName(x.r.app_id))}</div>` : ''}</div>
        <div class="r-m"><div class="r-val spend-val"><span class="tag">사용</span> -${num(x.r.amount)}</div><div class="r-sub"><span class="muted">${esc(x.r.memo || '기타')}</span>${pend.has(x.r.id) ? ' <span class="badge">올라가지 않음</span>' : ''}</div></div></button>`;
    }).join('');
    const fapp = ui.filterApp === 'all' ? null : S.apps.find((a) => a.id === ui.filterApp);
    const manage = fapp ? `<div class="manage"><button class="mini ghost press" data-act="rename-app" data-id="${fapp.id}">이름 바꾸기</button><button class="mini ghost danger press" data-act="remove-app" data-id="${fapp.id}">이 앱 없애기</button></div>` : '';
    const trashCount = store.trashItems().length;
    return `<main class="page has-bottom"><header class="bar"><button class="back press" data-act="go-home" aria-label="뒤로">${ICON.back}<span>처음 화면</span></button></header>
      <h1 class="page-title">기록 보기</h1>${banners()}
      <div class="chips" role="tablist">${chips}</div>${manage}
      <section class="list">${rows || '<p class="muted pad">아직 기록이 없습니다.</p>'}</section>
      <button class="big-btn press trash-link" data-act="go-trash">휴지통${trashCount ? ` <span class="count-badge">${trashCount}</span>` : ''}</button>
      ${dockHtml(undoBarHtml(), '<nav class="bottom three"><button class="big-btn press" data-act="rec-add-log">기록 추가</button><button class="big-btn press" data-act="rec-add-spend">사용 추가</button><button class="big-btn primary press" data-act="add-app">앱 추가</button></nav>')}</main>`;
  }

  function trashHtml() {
    const items = store.trashItems();
    const rows = items.map((it) => `<div class="row trash-row"><div class="r-l"><div class="r-app strong">${it.kind === 'app' ? `앱 · ${esc(it.label)}` : esc(it.label)}</div>
        <div class="r-sub muted">${it.left}일 뒤 완전히 지워집니다${it.kind === 'app' ? ` · 기록 ${it.count}건 포함` : ''}</div></div>
        <button class="mini press" data-act="restore" data-kind="${it.kind}" data-id="${it.row.id}">되살리기</button></div>`).join('');
    return `<main class="page"><header class="bar"><button class="back press" data-act="go-records" aria-label="뒤로">${ICON.back}<span>기록 보기</span></button></header>
      <h1 class="page-title">휴지통</h1><p class="muted pad">지운 것은 30일 동안 여기에 있다가 완전히 지워집니다.</p>
      <section class="list">${rows || '<p class="muted pad">휴지통이 비어 있습니다.</p>'}</section>${dockHtml(undoBarHtml(), '')}</main>`;
  }

  function settingsHtml() {
    const seg = (k) => `<button class="seg-btn press ${S.settings.font === k ? 'on' : ''}" data-act="set-font" data-v="${k}">${FONT_LABEL[k]}</button>`;
    return `<main class="page"><header class="bar"><button class="back press" data-act="go-home" aria-label="뒤로">${ICON.back}<span>처음 화면</span></button></header>
      <h1 class="page-title">설정</h1>
      <section class="set"><h2>글씨 크기</h2><div class="seg">${seg('xxsmall')}${seg('xsmall')}${seg('small')}${seg('normal')}${seg('large')}${seg('xlarge')}</div></section>
      <section class="set"><h2>움직임</h2><button class="toggle press ${S.settings.reduceMotion ? 'on' : ''}" data-act="toggle-motion" role="switch" aria-checked="${S.settings.reduceMotion}"><span>움직임 줄이기</span><span class="sw"><i></i></span></button></section>
      <section class="set"><h2>비밀번호</h2><button class="big-btn press" data-act="pw-change">비밀번호 바꾸기</button></section>
      <section class="set"><h2>기기</h2><button class="big-btn press" data-act="logout-all">모든 기기에서 로그아웃</button><p class="muted small pad0">폰을 잃어버렸을 때 눌러 주세요.</p></section>
      <section class="set"><h2>사용자</h2><p class="muted">${slotLabel(S.slot)} · 버전 ${esc(APP_VERSION)}</p><button class="big-btn danger press" data-act="logout">로그아웃</button></section></main>`;
  }

  /* ---------------------------- 시트(아래에서 올라오는 창) ---------------------------- */
  function numpadHtml() {
    const k = (v, label, cls = '') => `<button class="key press ${cls}" data-act="key" data-k="${v}" aria-label="${v === 'bs' ? '지우기' : label}">${label}</button>`;
    return `<div class="numpad">${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => k(n, n)).join('')}${k('00', '00')}${k('0', '0')}${k('bs', '⌫', 'fn')}</div>`;
  }

  function dateChip(sh) {
    const t = todayStr();
    const label = sh.date === t ? `날짜: 오늘 ${C.fmtMD(sh.date)}` : `날짜: ${C.fmtMD(sh.date)} (${C.fmtLongDate(sh.date).slice(-2, -1)}요일)`;
    return `<label class="chip-date press">${esc(label)} <span class="chg">· 바꾸기</span> ${ICON.caret}<input type="date" data-keep="date" data-restore="0" value="${sh.date}" max="${t}" aria-label="날짜 바꾸기"></label>`;
  }

  function tabsHtml(sh) {
    const t = (id, label) => `<button class="tab press ${sh.kind === id ? 'on' : ''}" data-act="tab" data-v="${id}">${label}</button>`;
    return `<div class="tabs" role="tablist">${t('log', '기록')}${t('spend', '사용')}<button class="tab press" data-act="tab" data-v="history">이 앱 기록</button></div>`;
  }

  function sheetInner(sh) {
    let inner = '';
    let title = '';
    if (sh.kind === 'log') { title = appName(sh.appId); inner = logSheet(sh); }
    else if (sh.kind === 'spend') { title = appName(sh.appId); inner = spendSheet(sh); }
    else if (sh.kind === 'addapp') { title = '앱 추가'; inner = addAppSheet(sh); }
    else if (sh.kind === 'edit-log') { title = '기록 고치기'; inner = editLogSheet(sh); }
    else if (sh.kind === 'edit-spend') { title = '사용 고치기'; inner = editSpendSheet(sh); }
    else if (sh.kind === 'rename') { title = '이름 바꾸기'; inner = renameSheet(sh); }
    else if (sh.kind === 'saved') { title = ''; inner = savedSheet(sh); }
    else if (sh.kind === 'pickapp') { title = sh.mode === 'spend' ? '사용 추가' : '기록 추가'; inner = pickAppSheet(sh); }
    else if (sh.kind === 'font') { title = '글씨 크기'; inner = fontSheet(); }
    else if (sh.kind === 'pwchange') { title = '비밀번호 바꾸기'; inner = pwSheet(sh); }
    return { title, inner };
  }

  function sheetHtml() {
    const sh = ui.sheet;
    if (!sh) return '';
    const { title, inner } = sheetInner(sh);
    const showClose = sh.kind !== 'font';
    const enter = !sh._in && !sh.closing; sh._in = true; // 올라오는 움직임은 시트가 처음 열릴 때만
    return `<div class="scrim ${sh.closing ? 'out' : enter ? 'enter' : ''}" data-act="${sh.kind === 'font' ? 'noop' : 'close-sheet'}"></div>
      <div class="sheet ${sh.closing ? 'out' : enter ? 'enter' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-head"><h2>${esc(title)}</h2>${showClose ? `<button class="icon-btn press" data-act="close-sheet" aria-label="닫기">${ICON.close}</button>` : ''}</div>
        <div class="sheet-body">${inner}</div></div>`;
  }

  function errLine(sh) { return sh.error ? `<p class="notice err" role="alert">${esc(sh.error)}</p>` : ''; }

  function logSheet(sh) {
    const total = parseDigits(sh.digits);
    const t = todayStr();
    const prev = C.prevLogBefore(S.logs, sh.appId, sh.date);
    const existing = C.liveLogs(S.logs, sh.appId).find((l) => l.log_date === sh.date);
    let pv = '';
    if (!Number.isNaN(total)) {
      const chk = C.checkLogEntry({ logs: S.logs, spends: S.spends, appId: sh.appId, dateStr: sh.date, total, today: t, nowIso: store.nowIso() });
      pv = chk.diff === null ? '<span class="muted">첫 기록입니다</span>' : diffHtml(chk.diff, chk.prev);
    }
    const prevLine = prev ? `<div class="prev-line">지난 기록(${C.fmtMD(prev.log_date)}) <b>${num(prev.total)}</b></div>` : '<div class="prev-line muted">처음 기록하는 날입니다</div>';
    const warn = existing ? `<p class="notice small">${C.fmtMD(sh.date)} 기록이 이미 있습니다 (${num(existing.total)}). 저장하면 새 값으로 바꿉니다.</p>` : '';
    const display = sh.digits ? num(total) : '<span class="ph">앱 화면의 총 포인트</span>';
    return `${tabsHtml(sh)}<div class="row-between">${dateChip(sh)}${prevLine}</div>
      <div class="display" aria-live="polite">${display}</div><div class="preview">${pv}</div>${warn}${errLine(sh)}
      ${numpadHtml()}<button class="big-btn primary press sticky-save" data-act="save-log" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '저장 중…' : '저장'}</button>`;
  }

  function spendSheet(sh) {
    const amount = parseDigits(sh.digits);
    const bal = C.balanceOf(S.logs, S.spends, sh.appId);
    let pv = '';
    if (!Number.isNaN(amount) && bal !== null) pv = `잔액 ${num(bal)} → <b class="${bal - amount < 0 ? 'neg' : ''}">${num(bal - amount)}</b>`;
    else if (bal !== null) pv = `지금 잔액 ${num(bal)}`;
    const chips = SPEND_MEMOS.map((m) => `<button class="chip-f press ${sh.memo === m ? 'on' : ''}" data-act="memo" data-v="${esc(m)}">${esc(m)}</button>`).join('');
    const display = sh.digits ? num(amount) : '<span class="ph">사용한 포인트</span>';
    return `${tabsHtml(sh)}<div class="row-between">${dateChip(sh)}<div class="prev-line">${pv}</div></div>
      <div class="chips mini-chips">${chips}</div>
      <div class="display" aria-live="polite"><span class="minus">-</span>${display}</div>${errLine(sh)}
      ${numpadHtml()}<button class="big-btn primary press sticky-save" data-act="save-spend" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '저장 중…' : '사용 기록'}</button>`;
  }

  function addAppSheet(sh) {
    const have = new Set(store.activeApps().map((a) => a.name));
    const chips = SUGGEST_APPS.filter((n) => !have.has(n)).map((n) => `<button class="chip-f press ${sh.name === n ? 'on' : ''}" data-act="pick-name" data-v="${esc(n)}">${esc(n)}</button>`).join('');
    const display = sh.digits ? num(parseDigits(sh.digits)) : '<span class="ph">지금 포인트</span>';
    return `<p class="lead small-lead">걷기 앱 이름을 고르거나 직접 적어 주세요.</p>
      <div class="chips mini-chips">${chips}</div>
      <input class="input" data-keep="appname" data-restore="0" type="text" maxlength="30" placeholder="앱 이름을 직접 적기" value="${esc(sh.name)}" autocomplete="off">
      <p class="hint">앱 화면에 보이는 <b>총 포인트</b>를 그대로 적으세요.</p>
      <div class="display" aria-live="polite">${display}</div>${errLine(sh)}${numpadHtml()}
      <button class="big-btn primary press sticky-save" data-act="save-app" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '저장 중…' : '추가'}</button>`;
  }

  function historyHtml(sh, kind) {
    const list = C.valueHistory(kind, sh.history || []);
    if (!sh.historyLoaded) return '<p class="muted small">이전 값을 불러오는 중입니다…</p>';
    if (!list.length) return '<p class="muted small">고친 적이 없습니다.</p>';
    const f = (h, side) => {
      const o = h[side] || {};
      if (kind === 'log') return num(o.total);
      if (kind === 'spend') return `${num(o.amount)} (${esc(o.memo || '기타')})`;
      return esc(o.name);
    };
    return `<ul class="hist">${list.map((h) => `<li><div><div class="h-time">${C.fmtMD(C.kstDate(h.at))} ${C.kstTime(h.at)}에 고침</div><div class="h-vals"><b>${f(h, 'old')}</b> <span class="muted small">→ ${f(h, 'new')}</span></div></div><button class="mini ghost press" data-act="hist-restore" data-id="${h.id}">이 값으로</button></li>`).join('')}</ul>`;
  }

  function editLogSheet(sh) {
    const log = S.logs.find((l) => l.id === sh.id);
    if (!log) return '<p class="muted">찾을 수 없습니다.</p>';
    const total = parseDigits(sh.digits);
    const chk = Number.isNaN(total) ? null : C.checkLogEntry({ logs: S.logs, spends: S.spends, appId: log.app_id, dateStr: sh.date, total, today: todayStr(), existingId: log.id, nowIso: store.nowIso(), recordedAt: sh.date === log.log_date ? log.recorded_at : undefined });
    const pv = chk && chk.diff !== null ? diffHtml(chk.diff, chk.prev) : '<span class="muted">첫 기록입니다</span>';
    const later = C.laterLogCount(S.logs, log.app_id, sh.date);
    const pending = store.pendingIds().has(log.id) ? '<p class="notice small">이 기록은 아직 올라가지 않았습니다.</p>' : '';
    const display = sh.digits ? num(total) : '<span class="ph">총 포인트</span>';
    return `<div class="row-between"><div class="prev-line"><b>${esc(appName(log.app_id))}</b></div>${dateChip(sh)}</div>
      <div class="display" aria-live="polite">${display}</div><div class="preview">${pv}</div>
      ${later && sh.date < todayStr() ? `<p class="notice small">고치면 이후 ${later}일의 차이도 다시 계산됩니다.</p>` : ''}${pending}${errLine(sh)}
      ${numpadHtml()}<div class="two-btn sticky-save"><button class="big-btn danger press" data-act="delete-log" ${ui.busy ? 'disabled' : ''}>지우기</button><button class="big-btn primary press" data-act="save-edit-log" ${ui.busy ? 'disabled' : ''}>저장</button></div>
      <h3 class="sub-h">이전 값</h3>${historyHtml(sh, 'log')}`;
  }

  function editSpendSheet(sh) {
    const sp = S.spends.find((l) => l.id === sh.id);
    if (!sp) return '<p class="muted">찾을 수 없습니다.</p>';
    const amount = parseDigits(sh.digits);
    const chips = SPEND_MEMOS.map((m) => `<button class="chip-f press ${sh.memo === m ? 'on' : ''}" data-act="memo" data-v="${esc(m)}">${esc(m)}</button>`).join('');
    const display = sh.digits ? num(amount) : '<span class="ph">사용한 포인트</span>';
    return `<div class="row-between"><div class="prev-line"><b>${esc(appName(sp.app_id))}</b></div>${dateChip(sh)}</div>
      <div class="chips mini-chips">${chips}</div>
      <div class="display"><span class="minus">-</span>${display}</div>${errLine(sh)}
      ${numpadHtml()}<div class="two-btn sticky-save"><button class="big-btn danger press" data-act="delete-spend" ${ui.busy ? 'disabled' : ''}>지우기</button><button class="big-btn primary press" data-act="save-edit-spend" ${ui.busy ? 'disabled' : ''}>저장</button></div>
      <h3 class="sub-h">이전 값</h3>${historyHtml(sh, 'spend')}`;
  }

  function renameSheet(sh) {
    return `<input class="input" data-keep="newname" data-restore="0" data-autofocus type="text" maxlength="30" value="${esc(sh.name)}" autocomplete="off">${errLine(sh)}
      <button class="big-btn primary press sticky-save" data-act="save-rename" ${ui.busy ? 'disabled' : ''}>저장</button>`;
  }

  function savedSheet(sh) {
    const u = S.undo;
    const left = u ? Math.max(0, Math.ceil((u.expires - store.now()) / 1000)) : 0;
    const queued = sh.status === 'queued';
    const next = sh.kind2 === 'log' ? store.nextApp(sh.appId) : null;
    const allDone = sh.kind2 === 'log' && !next && store.activeApps().length > 0;
    const play = !sh._play ? ' play' : ''; sh._play = true; // 체크 그리기는 처음 한 번만
    const head = queued
      ? `<div class="saved-head queued"><div class="ic-wrap${play}">${ICON.check}</div><h2>임시로 저장했습니다</h2><p class="muted">인터넷이 연결되면 자동으로 올라갑니다.<br>아직 올라가지 않았습니다.</p></div>`
      : `<div class="saved-head"><div class="ic-wrap${play}">${ICON.check}</div><h2>${esc(sh.headline)}</h2></div>`;
    const undoBtn = u && left > 0 ? `<button class="big-btn press" data-act="undo-sheet">되돌리기 <span class="count">${left}</span></button>` : '';
    return `${head}<div class="saved-body">${sh.lines.map((l) => `<p>${l}</p>`).join('')}</div>
      <div class="saved-actions">${next ? `<button class="big-btn primary press" data-act="next-app" data-id="${next.id}">다음 앱 · ${esc(next.name)}</button>` : ''}
      ${allDone ? '<p class="all-done">오늘 기록을 모두 마쳤습니다.</p>' : ''}
      ${undoBtn}<button class="big-btn ${next ? '' : 'primary'} press" data-act="close-sheet">${next ? '여기까지만 하기' : '닫기'}</button></div>`;
  }

  function pickAppSheet(sh) {
    const btns = store.activeApps().map((a) => `<button class="big-btn press pick-app" data-act="pick-app-go" data-id="${a.id}">${esc(a.name)}</button>`).join('');
    return `<p class="lead small-lead">어느 앱인가요?</p><div class="stack">${btns}</div>`;
  }

  function fontSheet() {
    const b = (k, sz) => `<button class="font-opt press ${S.settings.font === k ? 'on' : ''}" data-act="set-font-first" data-v="${k}"><span class="fo-name">${FONT_LABEL[k]}</span><span class="fo-sample" style="--sz:${sz}px">12,345</span></button>`;
    return `<p class="lead small-lead">글씨 크기를 고르세요.<br><span class="muted">나중에 설정에서 바꿀 수 있습니다.</span></p>${b('xxsmall', 14)}${b('xsmall', 16)}${b('small', 19)}${b('normal', 22)}${b('large', 28)}${b('xlarge', 34)}`;
  }

  function pwSheet(sh) {
    return `<p class="hint">새 비밀번호는 4자 이상이면 되지만 6자 이상을 권장합니다.</p><label class="field"><span class="lbl">지금 비밀번호</span><input class="input" data-keep="pwcur" data-restore="0" type="password" autocomplete="off"></label>
      <label class="field"><span class="lbl">새 비밀번호</span><input class="input" data-keep="pwnew" data-restore="0" type="password" autocomplete="off"></label>
      <label class="field"><span class="lbl">새 비밀번호 한 번 더</span><input class="input" data-keep="pwnew2" data-restore="0" type="password" autocomplete="off"></label>
      ${errLine(sh)}<button class="big-btn primary press sticky-save" data-act="save-pw" ${ui.busy ? 'disabled' : ''}>바꾸기</button>`;
  }

  /* ---------------------------- 확인창 ---------------------------- */
  function dialogHtml() {
    const d = ui.dialog;
    if (!d) return '';
    const enter = !d._in; d._in = true;
    return `<div class="scrim dlg-scrim"></div><div class="dialog${enter ? ' enter' : ''}" role="alertdialog" aria-modal="true"><h2>${esc(d.title)}</h2>${d.body.map((l) => `<p>${l}</p>`).join('')}
      <div class="dlg-btns">${d.buttons.map((b) => `<button class="big-btn ${b.kind || ''} press" data-act="dlg" data-i="${b.i}">${esc(b.label)}</button>`).join('')}</div></div>`;
  }
  function ask({ title, body, buttons }) {
    return new Promise((resolve) => {
      ui.dialog = { title, body, buttons: buttons.map((b, i) => ({ ...b, i })), resolve };
      rerender();
    });
  }
  function answer(i) {
    const d = ui.dialog; ui.dialog = null; rerender();
    if (d) d.resolve(d.buttons[i].value);
  }

  /* ============================== 시트 열고 닫기 ============================== */
  function openSheet(sh) {
    ui.notice = '';
    ui.sheet = { error: '', ...sh };
    try { history.pushState({ s: 1 }, ''); ui._pushed = (ui._pushed || 0) + 1; } catch { /* 무시 */ }
    rerender();
  }
  function closeSheet({ fromPop = false } = {}) {
    if (!ui.sheet) return;
    const reduce = S.settings.reduceMotion;
    if (!fromPop && ui._pushed) { ui._pushed--; ui._ignorePop = true; try { history.back(); } catch { /* 무시 */ } }
    if (reduce || !root.querySelector('.sheet')) { ui.sheet = null; rerender(); return; }
    ui.sheet.closing = true; rerender();
    setTimeout(() => { ui.sheet = null; rerender(); }, 160);
  }
  function openLog(appId, extra = {}) {
    const date = todayStr();
    ui.sheet = null;
    openSheet({ kind: 'log', appId, date, digits: '', fresh: false, ...extra });
  }
  function switchSheet(sh) { // 뒤로가기 기록을 늘리지 않고 같은 시트 안에서 내용만 바꿈
    ui.sheet = { error: '', _in: ui.sheet && ui.sheet._in, ...sh };
    rerender();
  }

  /* ============================== 입력 처리 ============================== */
  /**
   * 숫자판을 누를 때: 시트·배경막을 다시 만들지 않고, 숫자 표시부터 숫자판 바로 앞까지(숫자·미리보기·안내·오류)와
   * 위쪽의 한 줄 안내(지난 기록·잔액)만 바꿉니다. 그래서 깜빡이지 않고 스크롤·포커스가 그대로입니다.
   */
  function patchSheet() {
    const sh = ui.sheet;
    const body = root.querySelector('.sheet-body');
    if (!sh || !body) return rerender();
    const tmp = document.createElement('div');
    tmp.innerHTML = sheetInner(sh).inner;
    const cur = body.querySelector('.display'); const np = body.querySelector('.numpad');
    const nu = tmp.querySelector('.display'); const tnp = tmp.querySelector('.numpad');
    if (!cur || !np || !nu || !tnp) return rerender();
    const rm = []; for (let n = cur; n && n !== np; n = n.nextElementSibling) rm.push(n);
    const add = []; for (let m = nu; m && m !== tnp; m = m.nextElementSibling) add.push(m);
    rm.forEach((x) => x.remove());
    add.forEach((x) => np.before(x));
    const a = body.querySelector('.row-between .prev-line'); const b = tmp.querySelector('.row-between .prev-line');
    if (a && b && a.innerHTML !== b.innerHTML) a.innerHTML = b.innerHTML;
    fitDisplays();
  }

  // 아래 줄이 화면의 3분의 1을 넘게 커지면(시스템 글씨를 아주 크게 해 둔 경우 등) 붙박이를 풀어 내용 끝에 놓습니다. 내용 볼 자리를 지키기 위해서입니다.
  function fitDock() {
    const d = root.querySelector('.dock'); if (!d) return;
    d.classList.remove('flow');
    if (d.offsetHeight > window.innerHeight * 0.34) d.classList.add('flow');
  }
  window.addEventListener('resize', () => fitDock());

  // 숫자 표시줄: 글자 수에 맞춰 글자 크기 상한을 CSS 변수(--n)로 알려 줍니다. 아주 큰 글씨에서도 숫자가 한 줄에 다 보이게.
  function fitDisplays() {
    root.querySelectorAll('.display').forEach((d) => {
      const n = d.querySelector('.ph') ? 5 : Math.max(5, d.textContent.replace(/\s/g, '').length);
      d.style.setProperty('--n', String(n));
    });
  }

  function pressKey(k) {
    const sh = ui.sheet;
    if (!sh || sh.digits === undefined) return;
    buzz();
    if (sh.fresh) { sh.digits = ''; sh.fresh = false; }
    let d = sh.digits;
    if (k === 'bs') d = d.slice(0, -1);
    else if (d === '' && (k === '0' || k === '00')) d = '';
    else d = (d + k).slice(0, 9);
    if (d.length > 1) d = d.replace(/^0+/, '');
    sh.digits = d;
    sh.error = '';
    patchSheet();
  }

  async function guarded(fn) {
    if (ui.busy) return;
    ui.busy = true; rerender();
    try { await fn(); } finally { ui.busy = false; rerender(); }
  }

  function saveErrorText(e) {
    if (e instanceof SaveError || e instanceof ApiError) return e.message;
    if (e instanceof NetworkError) return '인터넷에 연결되어 있지 않습니다.';
    return '저장하지 못했습니다. 입력한 숫자는 그대로 두었으니 다시 눌러 주세요.';
  }

  function linesForSaved(row, appId, extra = []) {
    const { diff, prev } = C.logDiff(S.logs, S.spends, row);
    const bal = C.balanceOf(S.logs, S.spends, appId);
    const l = [`<b>${esc(appName(appId))}</b> ${C.fmtMD(row.log_date)} · <b class="big">${num(row.total)}</b>`, `${diff === null ? '첫 기록입니다' : diffHtml(diff, prev)}`];
    if (bal !== null && bal !== row.total) l.push(`잔액 <b>${num(bal)}</b>`);
    return l.concat(extra);
  }

  async function doSaveLog() {
    const sh = ui.sheet;
    const total = parseDigits(sh.digits);
    if (Number.isNaN(total)) { sh.error = '숫자를 입력해 주세요.'; return rerender(); }
    const t = todayStr();
    const chk = C.checkLogEntry({ logs: S.logs, spends: S.spends, appId: sh.appId, dateStr: sh.date, total, today: t, nowIso: store.nowIso() });
    if (chk.error) { sh.error = chk.error; return rerender(); }
    if (chk.nochange) { sh.error = '변화 없음 · 이미 같은 값으로 기록되어 있습니다.'; return rerender(); }
    const body = []; let neg = false;
    if (chk.up10) body.push(`지난 기록(${num(chk.prev.total)})보다 <b>10배 이상</b> 늘었습니다.`);
    if (chk.down10) body.push(`지난 기록(${num(chk.prev.total)})의 <b>10분의 1 이하</b>로 줄었습니다.`);
    if (chk.negative) { neg = true; body.push(`지난 기록(${C.fmtMD(chk.prev.log_date)})보다 <b>${num(Math.abs(chk.diff))}</b> 줄었습니다.`, '현금 전환이나 사용이었다면 「사용으로 기록」을 눌러 주세요.'); }
    if (body.length) {
      const buttons = [];
      if (neg) buttons.push({ label: '사용으로 기록', kind: 'primary', value: 'spend' });
      buttons.push({ label: neg ? '그대로 저장' : '맞습니다, 저장', kind: neg ? '' : 'primary', value: 'go' });
      buttons.push({ label: '다시 입력', kind: 'ghost', value: 'no' });
      const a = await ask({ title: neg ? '숫자가 줄었습니다' : '숫자를 다시 확인해 주세요', body: [...body, ...(neg ? [] : ['입력한 숫자가 맞습니까?'])], buttons });
      if (a === 'no') return;
      if (a === 'spend') {
        const drop = Math.abs(chk.diff);
        return switchSheet({ kind: 'spend', appId: sh.appId, date: sh.date, digits: String(drop), memo: '현금 전환', fresh: false });
      }
    }
    await guarded(async () => {
      try {
        const r = await store.saveLog({ appId: sh.appId, date: sh.date, total });
        const extra = [];
        const later = C.laterLogCount(S.logs, sh.appId, sh.date);
        if (later) extra.push(`<span class="muted">이후 ${later}일의 차이도 다시 계산했습니다.</span>`);
        if (r.overwritten) extra.push('<span class="muted">같은 날 기록이라 이전 값을 바꾸었습니다.</span>');
        switchSheet({ kind: 'saved', kind2: 'log', appId: sh.appId, status: r.status, headline: '저장됨', lines: linesForSaved(r.row, sh.appId, extra) });
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function doSaveSpend() {
    const sh = ui.sheet;
    const amount = parseDigits(sh.digits);
    if (Number.isNaN(amount)) { sh.error = '금액을 입력해 주세요.'; return rerender(); }
    const spentIso = sh.date === todayStr() ? store.nowIso() : C.endOfDayIso(sh.date);
    const chk = C.checkSpend({ logs: S.logs, spends: S.spends, appId: sh.appId, amount, spentIso });
    if (chk.error) { sh.error = chk.error; return rerender(); }
    if (chk.overBalance) {
      const a = await ask({ title: '잔액보다 큽니다', body: [`잔액은 <b>${num(chk.balance)}</b>인데 <b>${num(amount)}</b>을 사용하는 것으로 적으셨습니다.`], buttons: [{ label: '그대로 기록', value: 'go' }, { label: '다시 입력', kind: 'primary', value: 'no' }] });
      if (a === 'no') return;
    }
    await guarded(async () => {
      try {
        const r = await store.addSpend({ appId: sh.appId, amount, memo: sh.memo, date: sh.date });
        const bal = C.balanceOf(S.logs, S.spends, sh.appId);
        switchSheet({ kind: 'saved', kind2: 'spend', appId: sh.appId, status: r.status, headline: '사용을 기록했습니다', lines: [`<b>${esc(appName(sh.appId))}</b> · ${esc(sh.memo)} <b class="big spend-val">-${num(amount)}</b>`, `남은 잔액 <b>${num(bal)}</b>`] });
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function doSaveApp() {
    const sh = ui.sheet;
    const inp = root.querySelector('[data-keep="appname"]');
    const name = (inp ? inp.value : sh.name) || '';
    sh.name = name;
    const bad = store.checkName(name);
    if (bad) { sh.error = bad; return rerender(); }
    const total = parseDigits(sh.digits);
    if (Number.isNaN(total)) { sh.error = '지금 앱에 보이는 총 포인트를 적어 주세요.'; return rerender(); }
    await guarded(async () => {
      try {
        const r = await store.addApp({ name, total });
        switchSheet({ kind: 'saved', kind2: 'app', appId: r.app.id, status: S.undo && S.undo.status, headline: '앱을 추가했습니다', lines: [`<b>${esc(r.app.name)}</b> · <b class="big">${num(total)}</b>`, '<span class="muted">오늘의 첫 기록으로 저장했습니다.</span>'] });
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function openEditLog(id) {
    const l = S.logs.find((x) => x.id === id);
    if (!l) return;
    openSheet({ kind: 'edit-log', id, digits: String(l.total), fresh: true, date: l.log_date, history: [], historyLoaded: false });
    const h = await store.historyOf('log', id);
    if (ui.sheet && ui.sheet.id === id) { ui.sheet.history = h; ui.sheet.historyLoaded = true; rerender(); }
  }
  async function openEditSpend(id) {
    const s = S.spends.find((x) => x.id === id);
    if (!s) return;
    openSheet({ kind: 'edit-spend', id, digits: String(s.amount), fresh: true, date: C.kstDate(s.spent_at), memo: s.memo || '기타', history: [], historyLoaded: false });
    const h = await store.historyOf('spend', id);
    if (ui.sheet && ui.sheet.id === id) { ui.sheet.history = h; ui.sheet.historyLoaded = true; rerender(); }
  }

  function afterEditSaved(headline, status, lines) {
    switchSheet({ kind: 'saved', kind2: 'edit', status, headline, lines });
  }

  async function doSaveEditLog() {
    const sh = ui.sheet;
    const log = S.logs.find((l) => l.id === sh.id);
    const total = parseDigits(sh.digits);
    if (Number.isNaN(total)) { sh.error = '숫자를 입력해 주세요.'; return rerender(); }
    const chk = C.checkLogEntry({ logs: S.logs, spends: S.spends, appId: log.app_id, dateStr: sh.date, total, today: todayStr(), existingId: log.id, nowIso: store.nowIso(), recordedAt: sh.date === log.log_date ? log.recorded_at : undefined });
    if (chk.error) { sh.error = chk.error; return rerender(); }
    if (chk.existing && chk.existing.id !== log.id) { sh.error = `${C.fmtMD(sh.date)}에는 이미 다른 기록이 있습니다. 날짜를 바꾸거나 그 기록을 먼저 고쳐 주세요.`; return rerender(); }
    if (chk.nochange) { sh.error = '변화 없음 · 같은 값입니다.'; return rerender(); }
    const body = [];
    if (chk.up10) body.push(`지난 기록(${num(chk.prev.total)})보다 <b>10배 이상</b> 늘었습니다.`);
    if (chk.down10) body.push(`지난 기록(${num(chk.prev.total)})의 <b>10분의 1 이하</b>입니다.`);
    if (chk.negative) body.push(`지난 기록보다 <b>${num(Math.abs(chk.diff))}</b> 줄었습니다. 현금 전환이나 사용이었다면 이 기록은 그대로 두고 「포인트 사용」으로 적어 주세요.`);
    if (body.length) {
      const a = await ask({ title: '숫자를 다시 확인해 주세요', body: [...body, '그대로 저장할까요?'], buttons: [{ label: '그대로 저장', kind: 'primary', value: 'go' }, { label: '다시 입력', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
    }
    await guarded(async () => {
      try {
        const r = await store.editLog(log.id, { total, date: sh.date });
        const row = S.logs.find((l) => l.id === log.id);
        const later = C.laterLogCount(S.logs, row.app_id, row.log_date);
        afterEditSaved('고쳤습니다', r.status, linesForSaved(row, row.app_id, later ? [`<span class="muted">이후 ${later}일의 차이도 다시 계산했습니다.</span>`] : []));
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function doSaveEditSpend() {
    const sh = ui.sheet;
    const amount = parseDigits(sh.digits);
    const sp = S.spends.find((x) => x.id === sh.id);
    if (Number.isNaN(amount) || amount <= 0) { sh.error = '금액을 입력해 주세요.'; return rerender(); }
    await guarded(async () => {
      try {
        const r = await store.editSpend(sp.id, { amount, memo: sh.memo, date: sh.date });
        afterEditSaved('고쳤습니다', r.status, [`<b>${esc(appName(sp.app_id))}</b> · ${esc(sh.memo)} <b class="big spend-val">-${num(amount)}</b>`, `남은 잔액 <b>${num(C.balanceOf(S.logs, S.spends, sp.app_id))}</b>`]);
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function doDelete(kind) {
    const sh = ui.sheet;
    const row = (kind === 'log' ? S.logs : S.spends).find((x) => x.id === sh.id);
    const what = kind === 'log' ? `${appName(row.app_id)} ${C.fmtMD(row.log_date)} 기록(${num(row.total)})` : `${appName(row.app_id)} 사용 -${num(row.amount)}`;
    const a = await ask({ title: '지울까요?', body: [`<b>${esc(what)}</b>`, '지워도 휴지통에 30일 동안 있어서 되살릴 수 있습니다.'], buttons: [{ label: '지우기', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
    if (a !== 'go') return;
    await guarded(async () => {
      try {
        const r = await (kind === 'log' ? store.removeLog(sh.id) : store.removeSpend(sh.id));
        afterEditSaved('지웠습니다', r.status, ['<span class="muted">휴지통에서 30일 안에 되살릴 수 있습니다.</span>']);
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function doHistRestore(hid) {
    const sh = ui.sheet;
    const kind = sh.kind === 'edit-log' ? 'log' : 'spend';
    const h = (sh.history || []).find((x) => x.id === hid);
    if (!h) return;
    await guarded(async () => {
      try {
        const r = await store.restoreValue(kind, sh.id, h);
        const row = (kind === 'log' ? S.logs : S.spends).find((x) => x.id === sh.id);
        afterEditSaved('이전 값으로 돌렸습니다', r.status, kind === 'log' ? linesForSaved(row, row.app_id) : [`<b>${esc(appName(row.app_id))}</b> <b class="big spend-val">-${num(row.amount)}</b>`]);
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function doUndo(fromSheet) {
    await guarded(async () => {
      try {
        await store.undo();
        if (fromSheet) closeSheet();
        ui.notice = '되돌렸습니다.';
        setTimeout(() => { ui.notice = ''; rerender(); }, 2200);
      } catch (e) {
        if (ui.sheet) ui.sheet.error = saveErrorText(e); else ui.notice = saveErrorText(e);
      }
    });
  }

  /* ---------------------------- 로그인 동작 ---------------------------- */
  function loginErrorText(e) {
    if (e instanceof NetworkError) return '인터넷에 연결되어 있지 않습니다. 연결을 확인해 주세요.';
    if (e instanceof ApiError) {
      if (e.code === 'wrong') { const n = e.data && e.data.remaining; return n !== undefined ? `비밀번호가 달라요. ${n}번 더 해 볼 수 있어요.` : '비밀번호가 달라요.'; }
      if (e.code === 'locked') {
        const mins = e.data && e.data.until ? Math.max(1, Math.ceil((Date.parse(e.data.until) - store.now()) / 60000)) : 15;
        return `비밀번호를 여러 번 틀려서 잠겼습니다. ${mins >= 120 ? '하루 뒤' : mins >= 60 ? '1시간 뒤' : `${mins}분 뒤`}에 다시 해 주세요.`;
      }
      if (e.code === 'weak') return e.message;
      if (e.code === 'already_set') return '이미 비밀번호가 정해져 있습니다. 처음 화면에서 다시 골라 주세요.';
      if (e.code === 'disabled') return '지금은 사용할 수 없는 사용자입니다.';
      if (e.code === 'unset') return '처음 사용 설정이 필요합니다.';
    }
    return '열지 못했습니다. 잠시 뒤에 다시 해 주세요.';
  }

  async function doLogin() {
    const L = ui.login;
    const pw1 = (root.querySelector('[data-keep="pw1"]') || {}).value || '';
    const first = L.step === 'setup';
    if (first) {
      const pw2 = (root.querySelector('[data-keep="pw2"]') || {}).value || '';
      const bad = validatePassword(pw1);
      if (bad) { L.error = bad; return rerender(); }
      if (pw1 !== pw2) { L.error = '두 번 입력한 비밀번호가 다릅니다.'; return rerender(); }
    } else if (!pw1) { L.error = '비밀번호를 입력해 주세요.'; return rerender(); }
    L.busy = true; L.error = ''; rerender();
    try {
      if (first) await store.setup(L.slot, pw1); else await store.login(L.slot, pw1);
      L.step = 'pick'; L.busy = false; ui.screen = 'home';
      if (!S.settings.fontChosen) openSheet({ kind: 'font' });
      rerender();
    } catch (e) {
      L.busy = false; L.error = loginErrorText(e);
      if (e instanceof ApiError && (e.code === 'locked' || e.code === 'disabled' || e.code === 'already_set')) { await store.loadSlots(); }
      rerender();
    }
  }

  /** 기록 보기 아래 줄의 [기록 추가]/[사용 추가]: 앱 필터가 있으면 그 앱, 앱이 하나뿐이면 그 앱, 아니면 앱을 고르는 시트 */
  function recAdd(mode) {
    store.clearUndo();
    const apps = store.activeApps();
    if (!apps.length) return openSheet({ kind: 'addapp', name: '', digits: '' });
    const pick = ui.filterApp !== 'all' && apps.find((a) => a.id === ui.filterApp) ? ui.filterApp : (apps.length === 1 ? apps[0].id : null);
    if (!pick) return openSheet({ kind: 'pickapp', mode });
    if (mode === 'spend') return openSheet({ kind: 'spend', appId: pick, date: todayStr(), digits: '', memo: '현금 전환' });
    return openLog(pick);
  }

  /* ============================== 클릭 분배 ============================== */
  const actions = {
    noop() {},
    'pick-user': async (el) => {
      const slot = Number(el.dataset.slot);
      const s = S.slots.find((x) => x.slot === slot);
      ui.login = { step: s && s.state === 'unset' ? 'setup' : 'pw', slot, error: '', busy: false, show: false };
      rerender();
    },
    'login-back': () => { ui.login = { step: 'pick', slot: null, error: '', busy: false, show: false }; store.loadSlots(); rerender(); },
    'toggle-show': () => { ui.login.show = !ui.login.show; rerender(); },
    'login-go': () => doLogin(),
    reauth: () => { const slot = S.slot; store.logout().then(() => { ui.login = { step: 'pw', slot, error: '', busy: false, show: false }; rerender(); }); },
    'go-home': () => { ui.screen = 'home'; rerender(); },
    'go-records': () => { ui.screen = 'records'; rerender(); },
    'go-trash': () => { ui.screen = 'trash'; rerender(); },
    'go-settings': () => { ui.screen = 'settings'; rerender(); },
    filter: (el) => { ui.filterApp = el.dataset.id; rerender(); },
    'open-app': (el) => { store.clearUndo(); openLog(el.dataset.id); },
    'add-app': () => { store.clearUndo(); openSheet({ kind: 'addapp', name: '', digits: '' }); },
    'close-sheet': () => closeSheet(),
    'rec-add-log': () => recAdd('log'),
    'rec-add-spend': () => recAdd('spend'),
    'pick-app-go': (el) => { const sh = ui.sheet; switchSheet(sh.mode === 'spend' ? { kind: 'spend', appId: el.dataset.id, date: todayStr(), digits: '', memo: '현금 전환' } : { kind: 'log', appId: el.dataset.id, date: todayStr(), digits: '' }); },
    tab: (el) => {
      const sh = ui.sheet; const v = el.dataset.v;
      if (v === 'history') { ui.filterApp = sh.appId; ui.screen = 'records'; closeSheet(); return; }
      if (v === sh.kind) return;
      switchSheet({ kind: v, appId: sh.appId, date: sh.date, digits: '', memo: '현금 전환' });
    },
    key: (el) => pressKey(el.dataset.k),
    memo: (el) => { ui.sheet.memo = el.dataset.v; rerender(); },
    'pick-name': (el) => { ui.sheet.name = el.dataset.v; const i = root.querySelector('[data-keep="appname"]'); if (i) i.value = el.dataset.v; ui.sheet.error = ''; rerender(); },
    'save-log': () => doSaveLog(),
    'save-spend': () => doSaveSpend(),
    'save-app': () => doSaveApp(),
    'edit-log': (el) => openEditLog(el.dataset.id),
    'edit-spend': (el) => openEditSpend(el.dataset.id),
    'save-edit-log': () => doSaveEditLog(),
    'save-edit-spend': () => doSaveEditSpend(),
    'delete-log': () => doDelete('log'),
    'delete-spend': () => doDelete('spend'),
    'hist-restore': (el) => doHistRestore(el.dataset.id),
    'rename-app': (el) => { const a = S.apps.find((x) => x.id === el.dataset.id); openSheet({ kind: 'rename', id: a.id, name: a.name }); },
    'save-rename': async () => {
      const sh = ui.sheet; const v = (root.querySelector('[data-keep="newname"]') || {}).value || '';
      await guarded(async () => {
        try { const r = await store.renameApp(sh.id, v); closeSheet(); ui.notice = r.status === 'queued' ? '임시로 저장했습니다.' : '이름을 바꾸었습니다.'; setTimeout(() => { ui.notice = ''; rerender(); }, 2200); } catch (e) { sh.error = saveErrorText(e); }
      });
    },
    'remove-app': async (el) => {
      const a = S.apps.find((x) => x.id === el.dataset.id);
      const cnt = S.logs.filter((l) => l.app_id === a.id && !l.deleted_at).length;
      const ans = await ask({ title: '이 앱을 없앨까요?', body: [`<b>${esc(a.name)}</b> · 기록 ${cnt}건`, '휴지통으로 옮겨지고 30일 안에는 기록과 함께 되살릴 수 있습니다.'], buttons: [{ label: '없애기', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
      if (ans !== 'go') return;
      await guarded(async () => { try { await store.removeApp(a.id); ui.filterApp = 'all'; } catch (e) { ui.notice = saveErrorText(e); } });
    },
    restore: async (el) => {
      const { kind, id } = el.dataset;
      await guarded(async () => {
        try { await (kind === 'app' ? store.restoreApp(id) : kind === 'log' ? store.restoreLog(id) : store.restoreSpend(id)); ui.notice = '되살렸습니다.'; setTimeout(() => { ui.notice = ''; rerender(); }, 2200); } catch (e) { ui.notice = saveErrorText(e); setTimeout(() => { ui.notice = ''; rerender(); }, 4000); }
      });
    },
    undo: () => doUndo(false),
    'undo-sheet': () => doUndo(true),
    'next-app': (el) => { const id = el.dataset.id; ui.sheet = null; ui.sheet = { kind: 'log', appId: id, date: todayStr(), digits: '', error: '' }; rerender(); },
    'retry-failed': () => store.retryFailed(),
    'discard-failed': async () => {
      const a = await ask({ title: '올리지 못한 기록을 버릴까요?', body: ['버리면 이 기록은 사라집니다.'], buttons: [{ label: '버리기', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
      if (a === 'go') store.discardFailed();
    },
    'set-font': (el) => store.setFont(el.dataset.v),
    'set-font-first': (el) => { store.setFont(el.dataset.v); closeSheet(); },
    'toggle-motion': () => store.setReduceMotion(!S.settings.reduceMotion),
    'pw-change': () => openSheet({ kind: 'pwchange' }),
    'save-pw': async () => {
      const sh = ui.sheet; const g = (k) => (root.querySelector(`[data-keep="${k}"]`) || {}).value || '';
      const cur = g('pwcur'); const n1 = g('pwnew'); const n2 = g('pwnew2');
      if (!cur) { sh.error = '지금 비밀번호를 입력해 주세요.'; return rerender(); }
      const bad = validatePassword(n1);
      if (bad) { sh.error = bad; return rerender(); }
      if (n1 !== n2) { sh.error = '새 비밀번호를 두 번 다르게 입력하셨습니다.'; return rerender(); }
      await guarded(async () => {
        try { await store.changePassword(cur, n1); closeSheet(); ui.notice = '비밀번호를 바꾸었습니다.'; setTimeout(() => { ui.notice = ''; rerender(); }, 2500); } catch (e) { sh.error = loginErrorText(e); }
      });
    },
    'logout-all': async () => {
      const a = await ask({ title: '모든 기기에서 로그아웃할까요?', body: ['이 사용자로 열려 있는 모든 폰에서 로그아웃됩니다.', '다시 쓰려면 비밀번호를 입력해야 합니다.'], buttons: [{ label: '로그아웃', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
      await guarded(async () => { try { await store.logoutAllDevices(); ui.screen = 'home'; } catch (e) { ui.notice = saveErrorText(e); } });
    },
    logout: async () => {
      const a = await ask({ title: '로그아웃할까요?', body: ['이 폰에서만 로그아웃합니다. 기록은 그대로 있습니다.'], buttons: [{ label: '로그아웃', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
      await store.logout(); ui.screen = 'home'; ui.login = { step: 'pick', slot: null, error: '', busy: false, show: false }; rerender();
    },
    dlg: (el) => answer(Number(el.dataset.i)),
  };

  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    if (ui.dialog && el.dataset.act !== 'dlg') return;
    const fn = actions[el.dataset.act];
    if (fn) { Promise.resolve(fn(el)).catch((e) => { console.error(e); ui.busy = false; rerender(); }); }
  });
  root.addEventListener('focusin', (ev) => { // 키보드가 올라오면 입력 칸이 키보드 위에 보이도록
    const t = ev.target;
    if (t.matches && t.matches('.sheet input[type="text"], .sheet input[type="password"]')) setTimeout(() => { try { t.scrollIntoView({ block: 'center' }); } catch { /* 무시 */ } }, 320);
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-keep="pw1"], [data-keep="pw2"]')) { ev.preventDefault(); doLogin(); }
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-keep="appname"]')) { ev.preventDefault(); ev.target.blur(); }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches && ev.target.matches('.card')) { ev.preventDefault(); ev.target.click(); }
    if (ev.key === 'Escape') { if (ui.dialog) answer(ui.dialog.buttons.length - 1); else closeSheet(); }
  });
  root.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.matches('[data-keep="appname"]') && ui.sheet) { ui.sheet.name = t.value; ui.sheet.error = ''; }
    if (t.matches('[data-keep="pw1"], [data-keep="pw2"]')) { ui.login.error = ''; }
  });
  root.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('[data-keep="date"]') && ui.sheet && t.value) {
      ui.sheet.date = t.value > todayStr() ? todayStr() : t.value;
      ui.sheet.error = '';
      rerender();
    }
  });
  window.addEventListener('popstate', () => {
    if (ui._ignorePop) { ui._ignorePop = false; return; }
    if (ui.dialog) return;
    if (ui.sheet) { ui._pushed = Math.max(0, (ui._pushed || 1) - 1); closeSheet({ fromPop: true }); return; }
    if (ui.screen !== 'home') { ui.screen = 'home'; rerender(); }
  });

  store.on(() => rerender());

  // 되돌리기의 남은 초: 화면을 다시 그리지 않고 숫자만 바꾼다(0이 되면 그때만 다시 그림)
  setInterval(() => {
    const un = S.undo;
    if (!un) return;
    const left = Math.ceil((un.expires - store.now()) / 1000);
    if (left <= 0) { store.expireUndo(); rerender(); return; }
    root.querySelectorAll('.undo-btn .count, [data-act="undo-sheet"] .count').forEach((el) => {
      if (el.textContent !== String(left)) el.textContent = String(left);
    });
  }, 1000);

  function showLoginFor(slot) { ui.login = { step: 'pw', slot, error: '', busy: false, show: false }; rerender(); }
  return { ui, render, openLog, ask, actions, showLoginFor };
}
