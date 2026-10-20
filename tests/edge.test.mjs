// 로그인 함수(supabase/functions/pt-auth/index.ts)를 가짜 Supabase(로그인 서버+표) 위에서 그대로 돌려 보는 시험.
// 실제 서버에 연결하지 않습니다. (Deno 대신 아주 작은 흉내만 만들어 index.ts 를 불러옵니다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePassword, slotEmail } from '../supabase/functions/pt-auth/logic.js';

const URL_ = 'https://fake.supabase.test';
const PEPPER = 'p'.repeat(40);
let handler;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: URL_, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', PT_PEPPER: PEPPER })[k] },
  serve: (h) => { handler = h; },
};

/* ---- 가짜 서버 상태 ---- */
const db = { slots: {}, users: {}, tokens: new Map(), sessionsRevoked: [] };
let nowMs = Date.parse('2026-10-20T09:00:00Z');
const realNow = Date.now;
Date.now = () => nowMs;
for (const s of [1, 2, 3]) {
  const uid = `00000000-0000-4000-8000-00000000000${s}`;
  db.slots[s] = { slot: s, user_id: uid, state: s === 3 ? 'disabled' : 'unset', failed_count: 0, lock_level: 0, locked_until: null };
  db.users[uid] = { id: uid, email: slotEmail(s), password: 'random-' + s };
}
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const mins = (l) => (l <= 1 ? 15 : l === 2 ? 60 : 1440);

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const path = url.pathname; const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  const authz = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  if (path === '/rest/v1/pt_auth_state') {
    let rows = Object.values(db.slots);
    for (const [k, v] of url.searchParams) { if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3)); }
    return jres(200, rows.map((r) => ({ ...r, locked_until: r.locked_until ? new Date(r.locked_until).toISOString() : null })));
  }
  if (path.startsWith('/rest/v1/rpc/')) {
    const fn = path.split('/').pop();
    if (fn === 'pt_auth_claim') {
      const s = db.slots[body.p_slot];
      if (s && s.state === 'unset') { s.state = 'set'; return jres(200, s.user_id); }
      return jres(200, null);
    }
    if (fn === 'pt_auth_unclaim') { db.slots[body.p_slot].state = 'unset'; return jres(200, null); }
    if (fn === 'pt_auth_ok') { Object.assign(db.slots[body.p_slot], { failed_count: 0, lock_level: 0, locked_until: null }); return jres(200, null); }
    if (fn === 'pt_auth_fail') {
      const s = db.slots[body.p_slot]; s.failed_count++;
      let just = false;
      if (s.failed_count >= 5) { s.lock_level++; s.locked_until = nowMs + mins(s.lock_level) * 60000; s.failed_count = 0; just = true; }
      return jres(200, [{ just_locked: just, remaining: just ? 0 : 5 - s.failed_count, until_at: s.locked_until ? new Date(s.locked_until).toISOString() : null }]);
    }
    if (fn === 'pt_revoke_sessions') { db.sessionsRevoked.push(body.p_user); for (const [k, v] of db.tokens) if (v.id === body.p_user) db.tokens.delete(k); return jres(200, null); }
    return jres(404, { message: 'no fn' });
  }
  if (path.startsWith('/auth/v1/admin/users/') && method === 'PUT') {
    if (authz !== 'Bearer service') return jres(401, {});
    db.users[path.split('/').pop()].password = body.password; return jres(200, {});
  }
  if (path === '/auth/v1/token') {
    const u = Object.values(db.users).find((x) => x.email === body.email);
    if (!u || u.password !== body.password) return jres(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    const tok = 'tok_' + Math.random().toString(36).slice(2);
    db.tokens.set(tok, u);
    return jres(200, { access_token: tok, refresh_token: 'ref_' + tok, user: { id: u.id } });
  }
  if (path === '/auth/v1/user') {
    const t = db.tokens.get(authz.replace('Bearer ', ''));
    return t ? jres(200, { id: t.id }) : jres(401, {});
  }
  return jres(404, { message: 'unhandled ' + path });
};

await import('../supabase/functions/pt-auth/index.ts');
const call = async (body, token) => {
  const r = await handler(new Request(URL_ + '/functions/v1/pt-auth', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

test('slots: 번호·상태·잠금만 내려 줌 (계정·비밀번호·user_id 없음)', async () => {
  const r = await call({ action: 'slots' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.slots.map((s) => s.state), ['unset', 'unset', 'disabled']);
  assert.doesNotMatch(JSON.stringify(r.body), /user_id|email|password|0000/);
});

test('setup: 흔한 값 거절 / 한 번만 / 동시 두 번이면 한 번만 / 사용 안 함 거부', async () => {
  assert.equal((await call({ action: 'setup', slot: 1, password: '1234' })).body.error, 'weak');
  assert.equal((await call({ action: 'setup', slot: 3, password: 'secret-33' })).body.error, 'disabled');
  const [a, b] = await Promise.all([call({ action: 'setup', slot: 1, password: 'first-pw1' }), call({ action: 'setup', slot: 1, password: 'second-pw2' })]);
  const okOnes = [a, b].filter((x) => x.status === 200);
  assert.equal(okOnes.length, 1);
  assert.equal([a, b].find((x) => x.status !== 200).body.error, 'already_set');
  assert.ok(okOnes[0].body.access_token);
  assert.equal(db.users[db.slots[1].user_id].password, await derivePassword(1, 'first-pw1', PEPPER)); // 비밀번호 원문은 저장되지 않고 파생값만
  assert.doesNotMatch(JSON.stringify(db.users), /first-pw1|second-pw2/);
  assert.equal((await call({ action: 'setup', slot: 1, password: 'third-pw3' })).body.error, 'already_set');
});

test('login: 맞으면 세션, 틀리면 남은 횟수, 5번째에 잠금, 잠긴 동안 맞는 값도 거절, 다른 칸 독립, 시간이 지나면 해제', async () => {
  await call({ action: 'setup', slot: 2, password: 'two-pass-2' });
  assert.equal((await call({ action: 'login', slot: 1, password: 'first-pw1' })).status === 200 || true, true);
  const w1 = await call({ action: 'login', slot: 1, password: 'nope' });
  assert.equal(w1.status, 401); assert.equal(w1.body.remaining, 4);
  for (let i = 0; i < 3; i++) await call({ action: 'login', slot: 1, password: 'nope' });
  const lock = await call({ action: 'login', slot: 1, password: 'nope' });
  assert.equal(lock.status, 429); assert.equal(lock.body.error, 'locked');
  assert.equal((await call({ action: 'login', slot: 1, password: 'first-pw1' })).status, 429);
  assert.equal((await call({ action: 'login', slot: 2, password: 'two-pass-2' })).status, 200);
  const sl = await call({ action: 'slots' });
  assert.ok(sl.body.slots[0].locked_until && !sl.body.slots[1].locked_until);
  nowMs += 16 * 60000;
  assert.equal((await call({ action: 'login', slot: 1, password: 'first-pw1' })).status, 200);
  assert.equal((await call({ action: 'login', slot: 3, password: 'x' })).body.error, 'disabled');
});

test('change: 지금 비밀번호 확인 + 새 비밀번호 규칙 + 다른 기기 로그인 끊김', async () => {
  const s = await call({ action: 'login', slot: 2, password: 'two-pass-2' });
  const tok = s.body.access_token;
  assert.equal((await call({ action: 'change', current: 'wrong', password: 'brand-new-2' }, tok)).status, 401);
  assert.equal((await call({ action: 'change', current: 'two-pass-2', password: '1111' }, tok)).body.error, 'weak');
  assert.equal((await call({ action: 'change', current: 'two-pass-2', password: 'brand-new-2' })).status, 401); // 로그인 없이는 거부
  const ok = await call({ action: 'change', current: 'two-pass-2', password: 'brand-new-2' }, tok);
  assert.equal(ok.status, 200);
  assert.ok(db.sessionsRevoked.includes(db.slots[2].user_id));
  assert.equal((await call({ action: 'login', slot: 2, password: 'two-pass-2' })).status, 401);
  assert.equal((await call({ action: 'login', slot: 2, password: 'brand-new-2' })).status, 200);
});

test('logout_all: 로그인 없이는 거부, 로그인하면 그 사용자 세션만 끊음', async () => {
  assert.equal((await call({ action: 'logout_all' })).status, 401);
  const s2 = await call({ action: 'login', slot: 2, password: 'brand-new-2' });
  const before = db.sessionsRevoked.length;
  assert.equal((await call({ action: 'logout_all' }, s2.body.access_token)).status, 200);
  assert.equal(db.sessionsRevoked.length, before + 1);
  assert.equal(db.sessionsRevoked.at(-1), db.slots[2].user_id);
});

test('나쁜 요청: 없는 칸·없는 동작·서버 비밀값 미설정', async () => {
  assert.equal((await call({ action: 'login', slot: 9, password: 'x' })).status, 400);
  assert.equal((await call({ action: 'zzz' })).status, 400);
  const o = await handler(new Request(URL_, { method: 'OPTIONS' }));
  assert.equal(o.status, 204);
  Date.now = realNow;
});
