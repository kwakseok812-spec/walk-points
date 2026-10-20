// data.js - 서버와 이야기하는 계층을 한곳에 모았습니다.
//   createSupabaseAdapter : 실제 서버(Supabase)와 이야기합니다.
//   MemoryServer + createMemoryAdapter : 서버 없이 시험하는 메모리 가짜 서버입니다.
// 화면과 계산은 어댑터가 어느 쪽인지 모릅니다. (두 어댑터는 같은 메서드를 가집니다)
//
// 어댑터 메서드
//   auth.slots()                 -> [{slot, state:'unset'|'set'|'disabled', locked_until}]
//   auth.setup(slot, pw)         -> session   (미설정 칸에 한해 한 번만)
//   auth.login(slot, pw)         -> session
//   auth.refresh(refreshToken)   -> session
//   auth.changePassword(cur,new) -> session
//   auth.logoutAll()
//   data.loadAll()               -> {apps, logs, spends}
//   data.upsert(table, rows)     -> 저장된 행들
//   data.undoCreate(table, id)
//   data.history(entity, id)     -> 이력 목록
//   data.purgeMine()
//   serverOffsetMs()             -> 서버 시계 - 폰 시계

import {
  validatePassword, derivePassword, registerFail, lockMinutes, SLOT_LABEL,
} from '../supabase/functions/pt-auth/logic.js';
import { kstDate, TRASH_DAYS } from './calc.js';

export class NetworkError extends Error {
  constructor(msg = '인터넷에 연결되어 있지 않습니다.') { super(msg); this.name = 'NetworkError'; this.network = true; }
}
export class ApiError extends Error {
  constructor(status, code, msg, data = {}) { super(msg || code); this.name = 'ApiError'; this.status = status; this.code = code; this.data = data; }
}

const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
export { uuid };

const TRACK = {
  pt_logs: ['total', 'log_date', 'recorded_at', 'deleted_at'],
  pt_spends: ['amount', 'memo', 'spent_at', 'deleted_at'],
  pt_apps: ['name', 'deleted_at'],
};
const ENTITY = { pt_logs: 'log', pt_spends: 'spend', pt_apps: 'app' };
const TABLES = Object.keys(TRACK);

/* ------------------------------------------------------------------ */
/* 메모리 가짜 서버 (시험용). 서버의 표 규칙·행 단위 보안·함수를 흉내냅니다. */
/* ------------------------------------------------------------------ */
export class MemoryServer {
  constructor({ now = () => Date.now(), pepper = 'test-pepper' } = {}) {
    this.now = now;
    this.pepper = pepper;
    this.online = true;
    this.failNext = null; // 다음 쓰기를 거부시키는 시험용 장치 {status, code, msg}
    this.slotsState = {};
    for (const s of [1, 2, 3]) {
      this.slotsState[s] = { slot: s, user_id: uuid(), state: s === 3 ? 'disabled' : 'unset', failed_count: 0, lock_level: 0, locked_until: null, pwhash: null };
    }
    this.tables = { pt_apps: [], pt_logs: [], pt_spends: [], pt_history: [] };
    this.access = new Map(); // access -> {user_id, slot, exp}
    this.refreshTok = new Map(); // refresh -> {user_id, slot, revoked}
    this.log = []; // 호출 기록(시험용)
  }

  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  _net() { if (!this.online) throw new NetworkError(); }

  /* ---- 로그인 함수(pt-auth 흉내) ---- */
  _session(slot) {
    const st = this.slotsState[slot];
    const access = 'acc_' + uuid();
    const refresh = 'ref_' + uuid();
    this.access.set(access, { user_id: st.user_id, slot, exp: this.now() + 3600 * 1000 });
    this.refreshTok.set(refresh, { user_id: st.user_id, slot, revoked: false });
    return { slot, user_id: st.user_id, access_token: access, refresh_token: refresh };
  }
  fnSlots() {
    this._net();
    return [1, 2, 3].map((s) => {
      const st = this.slotsState[s];
      const lu = st.locked_until && st.locked_until > this.now() ? this.iso(st.locked_until) : null;
      return { slot: s, state: st.state, locked_until: lu };
    });
  }
  async fnSetup(slot, pw) {
    this._net();
    const st = this.slotsState[slot];
    if (!st) throw new ApiError(400, 'bad_slot', '없는 사용자입니다.');
    const bad = validatePassword(pw);
    if (bad) throw new ApiError(400, 'weak', bad);
    if (st.state !== 'unset') throw new ApiError(409, st.state === 'disabled' ? 'disabled' : 'already_set', '지금은 처음 사용 설정을 할 수 없습니다.');
    st.state = 'set'; // 원자적으로 한 번만 (JS 단일 스레드)
    st.pwhash = await derivePassword(slot, pw, this.pepper);
    return this._session(slot);
  }
  async fnLogin(slot, pw) {
    this._net();
    const st = this.slotsState[slot];
    if (!st) throw new ApiError(400, 'bad_slot', '없는 사용자입니다.');
    if (st.state === 'disabled') throw new ApiError(403, 'disabled', '지금은 사용할 수 없는 사용자입니다.');
    if (st.state === 'unset') throw new ApiError(409, 'unset', '처음 사용 설정이 필요합니다.');
    if (st.locked_until && st.locked_until > this.now()) {
      throw new ApiError(429, 'locked', '잠시 잠겨 있습니다.', { until: this.iso(st.locked_until) });
    }
    const h = await derivePassword(slot, pw || '', this.pepper);
    if (h !== st.pwhash) {
      const r = registerFail(st);
      st.failed_count = r.failed_count;
      st.lock_level = r.lock_level;
      if (r.locked_minutes) {
        st.locked_until = this.now() + r.locked_minutes * 60000;
        throw new ApiError(429, 'locked', '잠시 잠겨 있습니다.', { until: this.iso(st.locked_until) });
      }
      throw new ApiError(401, 'wrong', '비밀번호가 다릅니다.', { remaining: r.remaining });
    }
    st.failed_count = 0; st.lock_level = 0; st.locked_until = null;
    return this._session(slot);
  }
  async fnChange(access, cur, next) {
    const a = this._auth(access);
    const bad = validatePassword(next);
    if (bad) throw new ApiError(400, 'weak', bad);
    const st = this.slotsState[a.slot];
    const h = await derivePassword(a.slot, cur || '', this.pepper);
    if (h !== st.pwhash) {
      const r = registerFail(st);
      st.failed_count = r.failed_count; st.lock_level = r.lock_level;
      if (r.locked_minutes) st.locked_until = this.now() + r.locked_minutes * 60000;
      throw new ApiError(401, 'wrong', '현재 비밀번호가 다릅니다.', { remaining: r.remaining });
    }
    st.pwhash = await derivePassword(a.slot, next, this.pepper);
    this._revokeUser(a.user_id);
    return this._session(a.slot);
  }
  fnLogoutAll(access) {
    const a = this._auth(access);
    this._revokeUser(a.user_id);
  }
  _revokeUser(user_id) {
    for (const [k, v] of this.refreshTok) if (v.user_id === user_id) v.revoked = true;
    for (const [k, v] of this.access) if (v.user_id === user_id) this.access.delete(k);
  }
  refreshSession(refresh) {
    this._net();
    const r = this.refreshTok.get(refresh);
    if (!r || r.revoked) throw new ApiError(400, 'invalid_session', '로그인이 풀렸습니다.');
    r.revoked = true; // 사용할 때마다 새 토큰으로 교체
    return this._session(r.slot);
  }

  /* ---- 관리자 도구 흉내 ---- */
  adminReset(slot) { // 비밀번호 미설정으로 초기화 + 모든 기기 세션 끊기, 임시 잠금
    const st = this.slotsState[slot];
    st.state = 'disabled'; st.pwhash = null; st.failed_count = 0; st.lock_level = 0; st.locked_until = null;
    this._revokeUser(st.user_id);
  }
  adminOpen(slot) { this.slotsState[slot].state = 'unset'; }

  /* ---- 표 접근 (행 단위 보안 흉내) ---- */
  _auth(access) {
    this._net();
    const a = this.access.get(access);
    if (!a) throw new ApiError(401, 'no_auth', '권한이 없습니다. (로그인이 필요합니다)');
    if (a.exp <= this.now()) { this.access.delete(access); throw new ApiError(401, 'jwt_expired', '접속 시간이 지났습니다.'); }
    return a;
  }
  _table(name) { if (!TABLES.includes(name) && name !== 'pt_history') throw new ApiError(404, 'no_table', '없는 표'); return this.tables[name]; }
  clone(o) { return JSON.parse(JSON.stringify(o)); }

  select(table, access, pred = () => true) {
    const a = this._auth(access);
    return this._table(table).filter((r) => r.user_id === a.user_id && pred(r)).map((r) => this.clone(r));
  }

  upsert(table, access, rows) {
    const a = this._auth(access);
    if (this.failNext) { const f = this.failNext; this.failNext = null; throw new ApiError(f.status || 400, f.code || 'rejected', f.msg || '서버가 저장을 거부했습니다.'); }
    if (!TABLES.includes(table)) throw new ApiError(403, 'rls', '권한이 없습니다.');
    const out = [];
    const tbl = this.tables[table];
    // 한 번의 요청은 전부 되거나 전부 안 되게: 먼저 점검
    const staged = [];
    for (const raw of rows) {
      const row = this.clone(raw);
      if (row.user_id && row.user_id !== a.user_id) throw new ApiError(403, 'rls', 'new row violates row-level security policy');
      row.user_id = a.user_id;
      if (!row.id) row.id = uuid();
      const ex = tbl.find((r) => r.id === row.id);
      if (ex && ex.user_id !== a.user_id) throw new ApiError(403, 'rls', 'new row violates row-level security policy');
      this._validate(table, row, ex, a, staged);
      staged.push({ row, ex, old: ex ? this.clone(ex) : null });
    }
    for (const { row, ex, old } of staged) {
      const now = this.iso();
      if (table === 'pt_logs' || table === 'pt_spends') {
        const fld = table === 'pt_logs' ? 'recorded_at' : 'spent_at';
        if (!row[fld]) row[fld] = now;
        if (Date.parse(row[fld]) > this.now() + 5 * 60000) row[fld] = now; // 미래 시각은 서버 시각으로
      }
      row.created_at = ex ? ex.created_at : now;
      row.updated_at = now;
      row.deleted_at = row.deleted_at || null;
      if (ex) Object.assign(ex, row); else tbl.push(row);
      this._history(table, old, row, !!ex);
      out.push(this.clone(row));
    }
    return out;
  }

  _validate(table, row, ex, a, staged) {
    const bad = (code, msg) => { throw new ApiError(400, code, msg); };
    const apps = this.tables.pt_apps;
    if (table === 'pt_apps') {
      if (!row.name || !String(row.name).trim() || String(row.name).length > 30) bad('check', '앱 이름을 확인해 주세요.');
    } else {
      const app = apps.find((x) => x.id === row.app_id && x.user_id === a.user_id)
        || staged.map((s) => s.row).find((x) => x.id === row.app_id && x.user_id === a.user_id);
      if (!app) throw new ApiError(409, 'fk', '없는 앱입니다.');
    }
    if (table === 'pt_logs') {
      if (!Number.isInteger(row.total) || row.total < 0 || row.total > 999999999) bad('check', '총포인트가 올바르지 않습니다.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.log_date || '')) bad('check', '날짜가 올바르지 않습니다.');
      if (row.log_date > kstDate(this.now())) bad('future', '앞으로 올 날짜는 기록할 수 없습니다.');
      if (!row.deleted_at) {
        const dup = this.tables.pt_logs.find((l) => l.user_id === a.user_id && l.app_id === row.app_id && l.log_date === row.log_date && !l.deleted_at && l.id !== row.id);
        const dup2 = staged.map((s) => s.row).find((l) => l.app_id === row.app_id && l.log_date === row.log_date && !l.deleted_at && l.id !== row.id);
        if (dup || dup2) throw new ApiError(409, 'duplicate', '그 날짜의 기록이 이미 있습니다.');
      }
    }
    if (table === 'pt_spends') {
      if (!Number.isInteger(row.amount) || row.amount <= 0 || row.amount > 999999999) bad('check', '금액이 올바르지 않습니다.');
    }
  }

  _history(table, old, row, isUpdate) {
    const keys = TRACK[table];
    const pick = (o) => (o ? Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) : null);
    const o = pick(old), n = pick(row);
    if (isUpdate && JSON.stringify(o) === JSON.stringify(n)) return;
    this.tables.pt_history.push({
      id: uuid(), user_id: row.user_id, entity: ENTITY[table], entity_id: row.id,
      app_id: table === 'pt_apps' ? row.id : row.app_id,
      action: isUpdate ? 'update' : 'create', old: o, new: n, at: this.iso(),
    });
  }

  undoCreate(table, access, id) {
    const a = this._auth(access);
    const tbl = this.tables[table];
    const i = tbl ? tbl.findIndex((r) => r.id === id) : -1;
    if (i < 0) return;
    const r = tbl[i];
    if (r.user_id !== a.user_id) throw new ApiError(403, 'rls', '권한이 없습니다.');
    if (this.now() - Date.parse(r.created_at) > 60 * 60000) throw new ApiError(403, 'too_old', '너무 오래되어 취소할 수 없습니다.');
    if (table === 'pt_apps') {
      this.tables.pt_logs = this.tables.pt_logs.filter((l) => l.app_id !== id);
      this.tables.pt_spends = this.tables.pt_spends.filter((l) => l.app_id !== id);
    }
    tbl.splice(i, 1);
    this.tables.pt_history = this.tables.pt_history.filter((h) => h.entity_id !== id);
  }

  history(access, entity, id) {
    const a = this._auth(access);
    return this.tables.pt_history.filter((h) => h.user_id === a.user_id && h.entity === entity && h.entity_id === id).map((h) => this.clone(h));
  }

  purge(access) {
    const a = this._auth(access);
    const cutoff = this.now() - TRASH_DAYS * 86400000;
    const old = (r) => r.user_id === a.user_id && r.deleted_at && Date.parse(r.deleted_at) <= cutoff;
    const goneApps = new Set(this.tables.pt_apps.filter(old).map((x) => x.id));
    this.tables.pt_logs = this.tables.pt_logs.filter((r) => !(old(r) || goneApps.has(r.app_id)));
    this.tables.pt_spends = this.tables.pt_spends.filter((r) => !(old(r) || goneApps.has(r.app_id)));
    this.tables.pt_apps = this.tables.pt_apps.filter((r) => !goneApps.has(r.id));
  }
}

export function createMemoryAdapter(server, { phoneClockSkewMs = 0 } = {}) {
  let session = null;
  const ad = {
    mode: 'memory',
    server,
    get session() { return session; },
    setSession(s) { session = s; },
    auth: {
      slots: async () => server.fnSlots(),
      setup: async (slot, pw) => (session = await server.fnSetup(slot, pw)),
      login: async (slot, pw) => (session = await server.fnLogin(slot, pw)),
      refresh: async (rt) => (session = server.refreshSession(rt)),
      changePassword: async (cur, next) => (session = await server.fnChange(session.access_token, cur, next)),
      logoutAll: async () => { await call(() => server.fnLogoutAll(session.access_token)); },
    },
    data: {
      loadAll: async () => call(() => ({
        apps: server.select('pt_apps', session.access_token),
        logs: server.select('pt_logs', session.access_token),
        spends: server.select('pt_spends', session.access_token),
      })),
      upsert: async (table, rows) => call(() => server.upsert(table, session.access_token, rows)),
      undoCreate: async (table, id) => call(() => server.undoCreate(table, session.access_token, id)),
      history: async (entity, id) => call(() => server.history(session.access_token, entity, id)),
      purgeMine: async () => call(() => server.purge(session.access_token)),
    },
    serverOffsetMs: () => phoneClockSkewMs * -1, // 서버 시계 - 폰 시계
  };
  let refreshing = null;
  const renew = () => {
    if (!refreshing) {
      refreshing = Promise.resolve().then(() => { session = server.refreshSession(session.refresh_token); })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  };
  async function call(fn) {
    if (session && !session.access_token) await renew();
    try { return await fn(); } catch (e) {
      if (e instanceof ApiError && (e.code === 'jwt_expired' || e.code === 'no_auth') && session && session.refresh_token) {
        await renew();
        return fn();
      }
      throw e;
    }
  }
  return ad;
}

/* ------------------------------------------------------------------ */
/* 실제 서버(Supabase) 어댑터. 라이브러리 없이 fetch 만 씁니다.           */
/* ------------------------------------------------------------------ */
export function createSupabaseAdapter({ url, anonKey }) {
  let session = null;
  let offset = 0;
  const base = url.replace(/\/$/, '');

  async function raw(path, { method = 'GET', headers = {}, body, token } = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { apikey: anonKey, Authorization: `Bearer ${token || anonKey}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new NetworkError();
    }
    const d = res.headers.get('Date');
    if (d) { const sv = Date.parse(d); if (!Number.isNaN(sv)) offset = sv - Date.now(); }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text }; } }
    if (!res.ok) {
      if (res.status >= 500) throw new NetworkError('서버가 잠시 응답하지 않습니다.');
      const code = (data && (data.error || data.code)) || 'error';
      throw new ApiError(res.status, String(code), (data && (data.message || data.msg || data.error_description)) || '요청이 거절되었습니다.', data || {});
    }
    return data;
  }

  const toSession = (d, slot) => ({
    slot: slot ?? d.slot, user_id: d.user?.id || d.user_id, access_token: d.access_token, refresh_token: d.refresh_token,
  });

  async function fn(body, token) {
    return raw('/functions/v1/pt-auth', { method: 'POST', body, token });
  }

  let refreshing = null;
  const renew = () => {
    if (!refreshing) refreshing = ad.auth.refresh(session.refresh_token).finally(() => { refreshing = null; });
    return refreshing;
  };
  async function authed(path, opts = {}, retry = true) {
    if (!session) throw new ApiError(401, 'no_auth', '로그인이 필요합니다.');
    if (!session.access_token) await renew();
    try {
      return await raw(path, { ...opts, token: session.access_token });
    } catch (e) {
      if (retry && e instanceof ApiError && (e.status === 401 || e.code === 'PGRST301' || /jwt/i.test(e.message))) {
        await renew();
        return authed(path, opts, false);
      }
      throw e;
    }
  }

  async function selectAll(table, query = '') {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await authed(`/rest/v1/${table}?select=*${query}`, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  const ad = {
    mode: 'supabase',
    get session() { return session; },
    setSession(s) { session = s; },
    auth: {
      slots: async () => (await fn({ action: 'slots' })).slots,
      setup: async (slot, pw) => (session = toSession(await fn({ action: 'setup', slot, password: pw }), slot)),
      login: async (slot, pw) => (session = toSession(await fn({ action: 'login', slot, password: pw }), slot)),
      refresh: async (rt) => {
        let d;
        try {
          d = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: rt } });
        } catch (e) {
          if (e instanceof ApiError) throw new ApiError(e.status, 'invalid_session', '로그인이 풀렸습니다.');
          throw e;
        }
        session = { slot: session?.slot, user_id: d.user?.id, access_token: d.access_token, refresh_token: d.refresh_token };
        return session;
      },
      changePassword: async (cur, next) => (session = toSession(await fn({ action: 'change', current: cur, password: next }, session.access_token), session.slot)),
      logoutAll: async () => { await authed('/functions/v1/pt-auth', { method: 'POST', body: { action: 'logout_all' } }); },
    },
    data: {
      loadAll: async () => {
        const [apps, logs, spends] = await Promise.all([selectAll('pt_apps'), selectAll('pt_logs'), selectAll('pt_spends')]);
        return { apps, logs, spends };
      },
      upsert: async (table, rows) => authed(`/rest/v1/${table}?on_conflict=id`, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: rows,
      }),
      undoCreate: async (table, id) => { await authed('/rest/v1/rpc/pt_undo_create', { method: 'POST', body: { p_table: table, p_id: id } }); },
      history: async (entity, id) => authed(`/rest/v1/pt_history?entity=eq.${entity}&entity_id=eq.${id}&order=at.desc`),
      purgeMine: async () => { await authed('/rest/v1/rpc/pt_purge_mine', { method: 'POST', body: {} }); },
    },
    serverOffsetMs: () => offset,
  };
  return ad;
}

export { SLOT_LABEL };
