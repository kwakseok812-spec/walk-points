// 실제 서버용 어댑터(createSupabaseAdapter)가 보내는 요청 모양을 가짜 fetch 로 확인합니다. (서버 호출 없음)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAdapter, NetworkError, ApiError } from '../js/data.js';

const URL_ = 'https://x.supabase.test';
function mk(handler) {
  const calls = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = new URL(u);
    const rec = { path: url.pathname, search: url.search, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(rec);
    return handler(rec, calls);
  };
  return calls;
}
const res = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('로그인 함수 호출 모양 / 공개 키만 보냄 / 세션 저장', async () => {
  const calls = mk(() => res(200, { slot: 1, access_token: 'A', refresh_token: 'R', user: { id: 'u1' } }));
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' });
  const s = await ad.auth.login(1, 'pw');
  assert.equal(calls[0].path, '/functions/v1/pt-auth');
  assert.deepEqual(calls[0].body, { action: 'login', slot: 1, password: 'pw' });
  assert.equal(calls[0].headers.Authorization, 'Bearer ANON');
  assert.equal(s.access_token, 'A'); assert.equal(ad.session.refresh_token, 'R'); assert.equal(ad.session.user_id, 'u1');
});

test('1000행씩 나눠 받기 + 쓰기는 upsert(on_conflict=id)', async () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  const calls = mk((r) => {
    if (r.method === 'GET' && r.path === '/rest/v1/pt_logs') return res(200, r.headers.Range === '0-999' ? rows(1000) : rows(5));
    if (r.method === 'GET') return res(200, []);
    return res(201, [r.body[0]]);
  });
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' });
  ad.setSession({ slot: 1, user_id: 'u', access_token: 'A', refresh_token: 'R' });
  const d = await ad.data.loadAll();
  assert.equal(d.logs.length, 1005);
  const logCalls = calls.filter((c) => c.path === '/rest/v1/pt_logs');
  assert.deepEqual(logCalls.map((c) => c.headers.Range), ['0-999', '1000-1999']);
  assert.equal(logCalls[0].headers.Authorization, 'Bearer A');
  await ad.data.upsert('pt_logs', [{ id: 'x', total: 1 }]);
  const w = calls.at(-1);
  assert.equal(w.method, 'POST'); assert.equal(w.search, '?on_conflict=id');
  assert.match(w.headers.Prefer, /merge-duplicates/);
  await ad.data.undoCreate('pt_logs', 'x');
  assert.equal(calls.at(-1).path, '/rest/v1/rpc/pt_undo_create');
  assert.deepEqual(calls.at(-1).body, { p_table: 'pt_logs', p_id: 'x' });
});

test('접속 토큰이 만료되면 갱신 토큰으로 바꿔 한 번 다시 시도 / 동시에 여러 번 만료돼도 갱신은 한 번', async () => {
  let refreshed = 0;
  mk((r) => {
    if (r.path === '/auth/v1/token') { refreshed++; return res(200, { access_token: 'NEW', refresh_token: 'R2', user: { id: 'u' } }); }
    if (r.headers.Authorization === 'Bearer OLD') return res(401, { code: 'PGRST301', message: 'JWT expired' });
    return res(200, []);
  });
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' });
  ad.setSession({ slot: 1, user_id: 'u', access_token: 'OLD', refresh_token: 'R' });
  await Promise.all([ad.data.history('log', 'a'), ad.data.history('log', 'b')]);
  assert.equal(refreshed, 1);
  assert.equal(ad.session.access_token, 'NEW'); assert.equal(ad.session.refresh_token, 'R2');
});

test('세션이 취소되었으면 invalid_session, 인터넷이 없으면 NetworkError, 5xx 는 다시 시도할 수 있는 오류로', async () => {
  mk((r) => (r.path === '/auth/v1/token' ? res(400, { error: 'invalid_grant' }) : res(401, { message: 'JWT expired' })));
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' });
  ad.setSession({ slot: 1, access_token: 'OLD', refresh_token: 'R' });
  await assert.rejects(() => ad.data.loadAll(), (e) => e instanceof ApiError && e.code === 'invalid_session');
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => createSupabaseAdapter({ url: URL_, anonKey: 'A' }).auth.slots(), NetworkError);
  mk(() => res(503, { message: 'down' }));
  await assert.rejects(() => createSupabaseAdapter({ url: URL_, anonKey: 'A' }).auth.slots(), NetworkError);
  // 거부(4xx)는 ApiError 로, PostgREST 코드 보존
  mk(() => res(409, { code: '23505', message: 'duplicate key' }));
  const a2 = createSupabaseAdapter({ url: URL_, anonKey: 'A' });
  a2.setSession({ slot: 1, access_token: 'T', refresh_token: 'R' });
  await assert.rejects(() => a2.data.upsert('pt_logs', [{ id: 'x' }]), (e) => e instanceof ApiError && e.code === '23505');
});

test('서버 시계 차이를 응답의 Date 로 배움', async () => {
  mk(() => res(200, { slots: [] }, { Date: new Date(Date.now() + 3 * 3600000).toUTCString() }));
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'A' });
  await ad.auth.slots();
  assert.ok(Math.abs(ad.serverOffsetMs() - 3 * 3600000) < 2500);
});
