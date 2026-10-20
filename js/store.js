// store.js - 앱의 상태와 모든 조작(추가·기록·수정·지우기·되돌리기·오프라인 재전송)
import * as C from './calc.js';
import { ApiError, NetworkError, uuid } from './data.js';

export class SaveError extends Error {
  constructor(msg, code = 'save') { super(msg); this.name = 'SaveError'; this.code = code; }
}

const UNDO_MS = 15000;
const TABLE_OF = { app: 'pt_apps', log: 'pt_logs', spend: 'pt_spends' };

function friendly(e) {
  if (e instanceof SaveError) return e;
  if (e instanceof ApiError) {
    const m = {
      '23505': '그 날짜의 기록이 이미 있습니다.',
      '22008': '앞으로 올 날짜는 기록할 수 없습니다.',
      '23503': '이 앱을 찾을 수 없습니다.',
      '42501': '권한이 없습니다. 비밀번호를 다시 입력해 주세요.',
      duplicate: '그 날짜의 기록이 이미 있습니다.',
      future: '앞으로 올 날짜는 기록할 수 없습니다.',
      fk: '이 앱을 찾을 수 없습니다.',
      too_old: '시간이 지나 취소할 수 없습니다.',
      invalid_session: '로그인이 풀렸습니다. 비밀번호를 다시 입력해 주세요.',
      no_auth: '로그인이 풀렸습니다. 비밀번호를 다시 입력해 주세요.',
    }[e.code];
    return new SaveError(m || e.message || '서버가 저장을 거부했습니다.', e.code);
  }
  return new SaveError(e && e.message ? e.message : '저장하지 못했습니다.');
}
const isRetryable = (e) => e instanceof NetworkError || (e instanceof ApiError && e.code === 'invalid_session');

export function createStore({ adapter, storage, clock = () => Date.now() }) {
  const mem = new Map();
  const store0 = storage || {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const ls = {
    get(k, d = null) { try { const v = store0.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { store0.setItem(k, JSON.stringify(v)); } catch { /* 저장소가 막혀 있어도 앱은 동작 */ } },
    del(k) { try { store0.removeItem(k); } catch { /* ignore */ } },
  };

  const state = {
    phase: 'boot', // boot | login | app
    slots: [],
    slot: null,
    apps: [], logs: [], spends: [],
    outbox: [], // [{id, steps, at}]
    failed: [], // [{entry, message}]
    undo: null, // {label, steps, expires, status}
    needReauth: false,
    online: true,
    settings: ls.get('pt.settings', { font: 'normal', reduceMotion: false, fontChosen: false }),
    lastError: null,
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(state));
  const key = (k) => `pt.${state.slot}.${k}`;

  /* ---------- 시간 ---------- */
  function nowMs() {
    const off = adapter.serverOffsetMs ? adapter.serverOffsetMs() : 0;
    // 폰 시계와 서버 시계가 10분 이상 다르면 서버 시각을 기준으로 합니다
    return clock() + (Math.abs(off) >= 600000 ? off : 0);
  }
  const nowIso = () => new Date(nowMs()).toISOString();
  const today = () => C.kstDate(nowMs());

  /* ---------- 저장(캐시·세션·설정) ---------- */
  function persistSession() {
    const s = adapter.session;
    if (s && s.refresh_token) ls.set('pt.last', { slot: s.slot, refresh_token: s.refresh_token });
  }
  function persistData() {
    if (!state.slot) return;
    ls.set(key('cache'), { apps: state.apps, logs: state.logs, spends: state.spends });
    ls.set(key('outbox'), state.outbox);
    ls.set(key('failed'), state.failed);
  }
  function loadCache() {
    const c = ls.get(key('cache'), null);
    if (c) { state.apps = c.apps || []; state.logs = c.logs || []; state.spends = c.spends || []; }
    state.outbox = ls.get(key('outbox'), []);
    state.failed = ls.get(key('failed'), []);
  }

  /* ---------- 로컬 반영 ---------- */
  function applyLocal(steps) {
    for (const st of steps) {
      if (st.type === 'upsert') {
        const arr = listOf(st.table);
        for (const r of st.rows) {
          const i = arr.findIndex((x) => x.id === r.id);
          if (i >= 0) arr[i] = { ...arr[i], ...r }; else arr.push({ ...r });
        }
      } else if (st.type === 'undoCreate') {
        const arr = listOf(st.table);
        const i = arr.findIndex((x) => x.id === st.id);
        if (i >= 0) arr.splice(i, 1);
        if (st.table === 'pt_apps') {
          state.logs = state.logs.filter((l) => l.app_id !== st.id);
          state.spends = state.spends.filter((l) => l.app_id !== st.id);
        }
      }
    }
  }
  function listOf(table) { return table === 'pt_apps' ? state.apps : table === 'pt_logs' ? state.logs : state.spends; }

  function applyServerRows(table, rows) {
    const arr = listOf(table);
    for (const r of rows) {
      const i = arr.findIndex((x) => x.id === r.id);
      if (i >= 0) arr[i] = r; else arr.push(r);
    }
  }

  /* ---------- 서버로 보내기 ---------- */
  async function sendStep(st) {
    if (st.type === 'upsert') {
      const rows = await adapter.data.upsert(st.table, st.rows);
      applyServerRows(st.table, rows);
    } else if (st.type === 'undoCreate') {
      await adapter.data.undoCreate(st.table, st.id);
      applyLocal([st]);
    }
  }

  /** steps 를 차례로 보냅니다. 인터넷이 끊기면 남은 steps 를 돌려줍니다. */
  async function sendSteps(steps) {
    const created = [];
    for (let i = 0; i < steps.length; i++) {
      try {
        await sendStep(steps[i]);
        if (steps[i].created) created.push(steps[i]);
        state.online = true;
      } catch (e) {
        persistSession();
        if (isRetryable(e)) {
          if (e instanceof NetworkError) state.online = false;
          else state.needReauth = true;
          return { rest: steps.slice(i) };
        }
        // 거부: 앞서 새로 만든 것은 되돌려 어중간한 상태를 남기지 않습니다
        for (const c of created.reverse()) {
          try { for (const r of c.rows) { await adapter.data.undoCreate(c.table, r.id); applyLocal([{ type: 'undoCreate', table: c.table, id: r.id }]); } } catch { /* 최선 */ }
        }
        throw friendly(e);
      }
    }
    persistSession();
    return { rest: [] };
  }

  async function flush() {
    if (!state.outbox.length) return true;
    while (state.outbox.length) {
      const entry = state.outbox[0];
      let r;
      try { r = await sendSteps(entry.steps); } catch (e) {
        state.outbox.shift();
        state.failed.push({ entry, message: e.message });
        continue;
      }
      if (r.rest.length) { entry.steps = r.rest; persistData(); emit(); return false; }
      state.outbox.shift();
    }
    persistData(); emit();
    return true;
  }

  function enqueue(steps, label) {
    state.outbox.push({ id: uuid(), steps, label, at: nowIso() });
  }

  /** 변경 하나를 서버에 저장합니다. 성공/대기 상태를 돌려주고, 거부되면 SaveError 를 던집니다. */
  async function commit(label, steps, inverse, { noUndo = false } = {}) {
    state.lastError = null;
    let status = 'saved';
    if (state.outbox.length) await flush();
    if (state.outbox.length) {
      applyLocal(steps); enqueue(steps, label); status = 'queued';
    } else {
      const r = await sendSteps(steps); // 거부되면 여기서 던짐 -> 화면은 입력값을 그대로 둠
      if (r.rest.length) { applyLocal(r.rest); enqueue(r.rest, label); status = 'queued'; }
    }
    if (noUndo) state.undo = null;
    else state.undo = { label, steps: inverse, expires: nowMs() + UNDO_MS, status };
    persistData(); emit();
    return { status };
  }

  /* ---------- 로그인 ---------- */
  async function loadSlots() {
    try { state.slots = await adapter.auth.slots(); state.online = true; } catch (e) {
      if (e instanceof NetworkError) { state.online = false; state.slots = []; } else throw e;
    }
    emit();
    return state.slots;
  }

  async function enter(session) {
    state.slot = session.slot;
    state.needReauth = false;
    persistSession();
    loadCache();
    state.phase = 'app';
    emit();
    await sync();
  }
  async function login(slot, pw) { const s = await adapter.auth.login(slot, pw); await enter(s); }
  async function setup(slot, pw) { const s = await adapter.auth.setup(slot, pw); await enter(s); }

  /** 앱을 다시 열 때: 저장된 로그인으로 바로 들어갑니다. 못 들어가면 'login' 화면(마지막 사용자 선택됨) */
  async function resume() {
    const last = ls.get('pt.last', null);
    state.lastSlot = last ? last.slot : null;
    if (!last || !last.refresh_token) { state.phase = 'login'; await loadSlots(); return false; }
    adapter.setSession({ slot: last.slot, refresh_token: last.refresh_token, access_token: null });
    try {
      await adapter.auth.refresh(last.refresh_token);
      await enter(adapter.session);
      return true;
    } catch (e) {
      if (e instanceof NetworkError) { // 인터넷이 없어도 저장된 기록은 보여 줍니다
        state.slot = last.slot; loadCache(); state.online = false; state.phase = 'app'; emit();
        return true;
      }
      adapter.setSession(null);
      state.phase = 'login'; state.needReauth = true;
      await loadSlots();
      return false;
    }
  }

  function logoutLocal() {
    ls.del('pt.last');
    if (state.slot && !state.outbox.length) ls.del(key('cache')); // 올리지 못한 기록이 없으면 이 폰에 남은 사본도 지움
    adapter.setSession(null);
    Object.assign(state, { phase: 'login', slot: null, apps: [], logs: [], spends: [], outbox: [], failed: [], undo: null, needReauth: false });
    emit();
  }
  async function logout() { logoutLocal(); await loadSlots(); }
  async function logoutAllDevices() { await adapter.auth.logoutAll(); await logout(); }
  async function changePassword(cur, next) { const s = await adapter.auth.changePassword(cur, next); persistSession(); return s; }

  /* ---------- 동기화 ---------- */
  async function sync() {
    if (!adapter.session) return;
    const ok = await flush();
    if (!ok) return;
    try {
      const d = await adapter.data.loadAll();
      state.apps = d.apps; state.logs = d.logs; state.spends = d.spends;
      state.online = true;
      try { await adapter.data.purgeMine(); } catch { /* 지워 주는 일은 다음 기회에 */ }
      persistSession();
    } catch (e) {
      if (e instanceof NetworkError) state.online = false;
      else if (e instanceof ApiError && e.code === 'invalid_session') state.needReauth = true;
      else state.lastError = friendly(e).message;
    }
    persistData(); emit();
  }

  /* ---------- 읽기용 계산 ---------- */
  const activeApps = () => state.apps.filter((a) => !a.deleted_at).sort(C.cmpApp);
  const summaries = () => activeApps().map((a) => C.appSummary(a, state.logs, state.spends, today()));
  const pendingIds = () => {
    const s = new Set();
    for (const e of state.outbox) for (const st of e.steps) { if (st.type === 'upsert') st.rows.forEach((r) => s.add(r.id)); }
    return s;
  };
  const nextApp = (currentId) => C.nextPendingApp(state.apps, state.logs, today(), currentId);
  const totalBalance = () => C.totalBalance(activeApps(), state.logs, state.spends);

  function trashItems() {
    const n = nowIso();
    const out = [];
    const liveApp = new Set(state.apps.filter((a) => !a.deleted_at).map((a) => a.id));
    const appName = (id) => (state.apps.find((a) => a.id === id) || {}).name || '';
    for (const a of state.apps) if (a.deleted_at && !C.isPurgeDue(a.deleted_at, n)) out.push({ kind: 'app', row: a, label: a.name, deleted_at: a.deleted_at, left: C.trashDaysLeft(a.deleted_at, n), count: state.logs.filter((l) => l.app_id === a.id && !l.deleted_at).length });
    for (const l of state.logs) if (l.deleted_at && liveApp.has(l.app_id) && !C.isPurgeDue(l.deleted_at, n)) out.push({ kind: 'log', row: l, label: `${appName(l.app_id)} ${C.fmtMD(l.log_date)} 기록 ${C.fmtNum(l.total)}`, deleted_at: l.deleted_at, left: C.trashDaysLeft(l.deleted_at, n) });
    for (const s of state.spends) if (s.deleted_at && liveApp.has(s.app_id) && !C.isPurgeDue(s.deleted_at, n)) out.push({ kind: 'spend', row: s, label: `${appName(s.app_id)} ${C.fmtMD(C.kstDate(s.spent_at))} 사용 ${C.fmtNum(s.amount)} (${s.memo || '기타'})`, deleted_at: s.deleted_at, left: C.trashDaysLeft(s.deleted_at, n) });
    return out.sort((a, b) => Date.parse(b.deleted_at) - Date.parse(a.deleted_at));
  }

  /* ---------- 조작 ---------- */
  const findRow = (kind, id) => listOf(TABLE_OF[kind]).find((r) => r.id === id);
  const cleanName = (n) => String(n || '').trim().replace(/\s+/g, ' ');

  function checkName(name, exceptId = null) {
    const n = cleanName(name);
    if (!n) return '앱 이름을 적어 주세요.';
    if (n.length > 30) return '이름이 너무 깁니다. (30자 이하)';
    if (activeApps().some((a) => a.id !== exceptId && a.name === n)) return '같은 이름의 앱이 이미 있습니다.';
    return null;
  }

  async function addApp({ name, total }) {
    const bad = checkName(name);
    if (bad) throw new SaveError(bad, 'name');
    if (!Number.isInteger(total) || total < 0 || total > C.MAX_TOTAL) throw new SaveError('포인트 숫자를 확인해 주세요.');
    const t = nowIso();
    const sort = state.apps.reduce((m, a) => Math.max(m, a.sort ?? 0), 0) + 1;
    const app = { id: uuid(), name: cleanName(name), sort, created_at: t, updated_at: t, deleted_at: null };
    const log = { id: uuid(), app_id: app.id, log_date: today(), total, recorded_at: t, created_at: t, updated_at: t, deleted_at: null };
    await commit('앱 추가', [
      { type: 'upsert', table: 'pt_apps', rows: [app], created: true },
      { type: 'upsert', table: 'pt_logs', rows: [log], created: true },
    ], [{ type: 'undoCreate', table: 'pt_apps', id: app.id }]);
    return { app, log };
  }

  /** 입력 시트의 [저장]: 그날 기록이 있으면 덮어씀(입력 시각을 지금으로) */
  async function saveLog({ appId, date, total }) {
    const d = date || today();
    const existing = C.liveLogs(state.logs, appId).find((l) => l.log_date === d) || null;
    const t = nowIso();
    const recorded_at = d === today() ? t : (existing ? existing.recorded_at : C.endOfDayIso(d));
    let row; let inverse;
    if (existing) {
      row = { ...existing, total, recorded_at, updated_at: t };
      inverse = [{ type: 'upsert', table: 'pt_logs', rows: [{ ...existing }] }];
    } else {
      row = { id: uuid(), app_id: appId, log_date: d, total, recorded_at, created_at: t, updated_at: t, deleted_at: null };
      inverse = [{ type: 'undoCreate', table: 'pt_logs', id: row.id }];
    }
    const r = await commit(existing ? '기록 덮어쓰기' : '기록 저장', [{ type: 'upsert', table: 'pt_logs', rows: [row], created: !existing }], inverse);
    return { row, overwritten: !!existing, ...r };
  }

  /** 수정 창의 [저장]: 값만 고침(입력 시각 유지, 날짜를 바꾸면 그 날짜 기준) */
  async function editLog(id, { total, date }) {
    const log = findRow('log', id);
    if (!log) throw new SaveError('기록을 찾을 수 없습니다.');
    const d = date || log.log_date;
    const t = nowIso();
    const row = { ...log, total, updated_at: t };
    if (d !== log.log_date) { row.log_date = d; row.recorded_at = d === today() ? t : C.endOfDayIso(d); }
    return commit('기록 수정', [{ type: 'upsert', table: 'pt_logs', rows: [row] }], [{ type: 'upsert', table: 'pt_logs', rows: [{ ...log }] }]);
  }

  async function setDeleted(kind, id, del) {
    const row = findRow(kind, id);
    if (!row) throw new SaveError('찾을 수 없습니다.');
    const t = nowIso();
    const next = { ...row, deleted_at: del ? t : null, updated_at: t };
    const label = { app: '앱', log: '기록', spend: '사용' }[kind] + (del ? ' 지움' : ' 되살림');
    return commit(label, [{ type: 'upsert', table: TABLE_OF[kind], rows: [next] }], [{ type: 'upsert', table: TABLE_OF[kind], rows: [{ ...row }] }]);
  }
  const removeLog = (id) => setDeleted('log', id, true);
  const restoreLog = (id) => setDeleted('log', id, false);
  const removeSpend = (id) => setDeleted('spend', id, true);
  const restoreSpend = (id) => setDeleted('spend', id, false);
  const removeApp = (id) => setDeleted('app', id, true);
  const restoreApp = (id) => setDeleted('app', id, false);

  async function addSpend({ appId, amount, memo, date }) {
    const d = date || today();
    const t = nowIso();
    const row = { id: uuid(), app_id: appId, amount, memo: memo || '기타', spent_at: d === today() ? t : C.endOfDayIso(d), created_at: t, updated_at: t, deleted_at: null };
    const r = await commit('포인트 사용', [{ type: 'upsert', table: 'pt_spends', rows: [row], created: true }], [{ type: 'undoCreate', table: 'pt_spends', id: row.id }]);
    return { row, ...r };
  }
  async function editSpend(id, { amount, memo, date }) {
    const sp = findRow('spend', id);
    if (!sp) throw new SaveError('기록을 찾을 수 없습니다.');
    const t = nowIso();
    const row = { ...sp, amount, memo: memo || '기타', updated_at: t };
    if (date && date !== C.kstDate(sp.spent_at)) row.spent_at = date === today() ? t : C.endOfDayIso(date);
    return commit('사용 수정', [{ type: 'upsert', table: 'pt_spends', rows: [row] }], [{ type: 'upsert', table: 'pt_spends', rows: [{ ...sp }] }]);
  }

  async function renameApp(id, name) {
    const bad = checkName(name, id);
    if (bad) throw new SaveError(bad, 'name');
    const app = findRow('app', id);
    const row = { ...app, name: cleanName(name), updated_at: nowIso() };
    return commit('이름 바꿈', [{ type: 'upsert', table: 'pt_apps', rows: [row] }], [{ type: 'upsert', table: 'pt_apps', rows: [{ ...app }] }]);
  }

  /** 수정 창의 「이전 값」 눌러 복원 */
  async function restoreValue(kind, id, hist) {
    const row = findRow(kind, id);
    if (!row || !hist || !hist.old) throw new SaveError('복원할 수 없습니다.');
    const o = hist.old;
    const pick = { log: ['total', 'log_date', 'recorded_at'], spend: ['amount', 'memo', 'spent_at'], app: ['name'] }[kind];
    const next = { ...row, updated_at: nowIso() };
    for (const k of pick) if (o[k] !== undefined && o[k] !== null) next[k] = o[k];
    return commit('이전 값 복원', [{ type: 'upsert', table: TABLE_OF[kind], rows: [next] }], [{ type: 'upsert', table: TABLE_OF[kind], rows: [{ ...row }] }]);
  }

  async function historyOf(kind, id) {
    try { return await adapter.data.history(kind, id); } catch (e) {
      if (e instanceof NetworkError) state.online = false;
      return [];
    }
  }

  async function undo() {
    const u = state.undo;
    if (!u) return false;
    state.undo = null;
    await commit('되돌리기', u.steps, [], { noUndo: true });
    return true;
  }
  function expireUndo() {
    if (state.undo && nowMs() >= state.undo.expires) { state.undo = null; emit(); }
  }
  function clearUndo() { if (state.undo) { state.undo = null; emit(); } }

  async function retryFailed() {
    const items = state.failed.splice(0);
    for (const f of items) state.outbox.push(f.entry);
    persistData();
    await flush();
    emit();
  }
  async function discardFailed() {
    state.failed = [];
    state.outbox = state.outbox.filter(() => true);
    persistData();
    await sync();
  }

  function setFont(f) { state.settings.font = f; state.settings.fontChosen = true; ls.set('pt.settings', state.settings); emit(); }
  function setReduceMotion(v) { state.settings.reduceMotion = !!v; ls.set('pt.settings', state.settings); emit(); }

  return {
    adapter, state, on(fn) { listeners.add(fn); return () => listeners.delete(fn); }, emit,
    now: nowMs, nowIso, today,
    loadSlots, login, setup, resume, logout, logoutAllDevices, changePassword, sync, flush,
    activeApps, summaries, pendingIds, nextApp, totalBalance, trashItems, checkName,
    addApp, saveLog, editLog, removeLog, restoreLog, addSpend, editSpend, removeSpend, restoreSpend,
    renameApp, removeApp, restoreApp, restoreValue, historyOf, undo, expireUndo, clearUndo,
    retryFailed, discardFailed, setFont, setReduceMotion,
    findRow,
  };
}
