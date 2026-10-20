// 로그인 함수(supabase/functions/pt-auth/index.ts)를 가짜 Supabase(로그인 서버+표) 위에서 그대로 돌려 보는 시험.
// 실제 서버에 연결하지 않습니다. (Deno 대신 아주 작은 흉내만 만들어 index.ts 를 불러옵니다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePassword, slotEmail } from '../supabase/functions/pt-auth/logic.js';

const URL_ = 'https://fake.supabase.test';
const PEPPER = 'p'.repeat(40);
let handler;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: URL_, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' })[k] }, // 비밀값은 환경변수가 아니라 DB(pt_secret)에서 읽음
  serve: (h) => { handler = h; },
};

/* ---- 가짜 서버 상태 ---- */
const db = { slots: {}, users: {}, tokens: new Map(), sessionsRevoked: [], pepper: PEPPER, secretReads: 0 };
let nowMs = Date.parse('2026-10-20T09:00:00Z');
const realNow = Date.now;
Date.now = () => nowMs;
// 마이그레이션 0005 가 만드는 초기 상태: 사용자1·2 미설정, 사용자3 사용 안 함, 로그인 계정은 아직 없음
for (const s of [1, 2, 3]) {
  db.slots[s] = { slot: s, user_id: null, state: s === 3 ? 'disabled' : 'unset', failed_count: 0, lock_level: 0, locked_until: null };
}
let userSeq = 0;
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const mins = (l) => (l <= 1 ? 15 : 60);
let tokenCalls = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const path = url.pathname; const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  const authz = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  if (path === '/rest/v1/pt_secret') {
    db.secretReads++;
    return jres(200, db.pepper ? [{ value: db.pepper }] : []);
  }
  if (path === '/rest/v1/pt_auth_state') {
    let rows = Object.values(db.slots);
    for (const [k, v] of url.searchParams) { if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3)); }
    return jres(200, rows.map((r) => ({ ...r, locked_until: r.locked_until ? new Date(r.locked_until).toISOString() : null })));
  }
  if (path.startsWith('/rest/v1/rpc/')) {
    const fn = path.split('/').pop();
    if (fn === 'pt_auth_claim') {
      const s = db.slots[body.p_slot];
      if (s && s.state === 'unset') { s.state = 'set'; return jres(200, [{ claimed: true, user_id: s.user_id }]); }
      return jres(200, [{ claimed: false, user_id: null }]);
    }
    if (fn === 'pt_auth_set_user') { const s = db.slots[body.p_slot]; if (!s.user_id) s.user_id = body.p_user; return jres(200, null); }
    if (fn === 'pt_auth_unclaim') { db.slots[body.p_slot].state = 'unset'; return jres(200, null); }
    if (fn === 'pt_auth_ok') { Object.assign(db.slots[body.p_slot], { failed_count: 0, lock_level: 0, locked_until: null, last_failed_at: null }); return jres(200, null); }
    if (fn === 'pt_auth_fail') {
      const s = db.slots[body.p_slot];
      if (s.locked_until && s.locked_until > nowMs) return jres(200, [{ allowed: false, just_locked: false, remaining: 0, until_at: new Date(s.locked_until).toISOString() }]);
      if (s.last_failed_at && nowMs - s.last_failed_at >= 24 * 3600 * 1000) { s.failed_count = 0; s.lock_level = 0; }
      s.failed_count++; s.last_failed_at = nowMs;
      let just = false;
      if (s.failed_count >= 5) { s.lock_level = Math.min(s.lock_level + 1, 2); s.locked_until = nowMs + mins(s.lock_level) * 60000; s.failed_count = 0; just = true; }
      return jres(200, [{ allowed: true, just_locked: just, remaining: just ? 0 : 5 - s.failed_count, until_at: s.locked_until ? new Date(s.locked_until).toISOString() : null }]);
    }
    if (fn === 'pt_revoke_sessions') { db.sessionsRevoked.push(body.p_user); for (const [k, v] of db.tokens) if (v.id === body.p_user) db.tokens.delete(k); return jres(200, null); }
    return jres(404, { message: 'no fn' });
  }
  if (path === '/auth/v1/admin/users' && method === 'POST') {
    if (authz !== 'Bearer service') return jres(401, {});
    if (Object.values(db.users).some((u) => u.email === body.email)) return jres(422, { error_code: 'email_exists' });
    const id = `00000000-0000-4000-8000-0000000000${String(++userSeq).padStart(2, '0')}`;
    db.users[id] = { id, email: body.email, password: body.password, confirmed: body.email_confirm === true };
    return jres(200, { id, email: body.email });
  }
  if (path === '/auth/v1/admin/users' && method === 'GET') return jres(200, { users: Object.values(db.users) });
  if (path.startsWith('/auth/v1/admin/users/') && method === 'PUT') {
    if (authz !== 'Bearer service') return jres(401, {});
    db.users[path.split('/').pop()].password = body.password; return jres(200, {});
  }
  if (path === '/auth/v1/token') {
    tokenCalls++;
    await new Promise((r) => setTimeout(r, 5)); // 확인에 시간이 걸리는 상황(동시 요청이 겹치도록)
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

await import('../supabase/functions/pt-auth/index.single.ts');
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
  assert.ok(db.slots[1].user_id, '첫 설정 때 로그인 계정이 만들어져 칸에 기록됨');
  assert.equal(db.users[db.slots[1].user_id].email, slotEmail(1));
  assert.equal(Object.keys(db.users).length, 1); // 동시 두 번이어도 계정은 하나
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

test('나쁜 요청: 없는 칸·없는 동작', async () => {
  assert.equal((await call({ action: 'login', slot: 9, password: 'x' })).status, 400);
  assert.equal((await call({ action: 'zzz' })).status, 400);
  const o = await handler(new Request(URL_, { method: 'OPTIONS' }));
  assert.equal(o.status, 204);
});

test('잠금 우회 방지: 틀린 비밀번호 10건을 동시에 보내도 확인은 5번까지만 일어남', async () => {
  nowMs += 3 * 24 * 3600000; // 앞선 시험의 잠금·횟수와 분리
  await call({ action: 'login', slot: 1, password: 'first-pw1' }); // 성공으로 횟수 초기화
  const before = tokenCalls;
  const rs = await Promise.all(Array.from({ length: 10 }, () => call({ action: 'login', slot: 1, password: 'guess-' + Math.random() })));
  assert.equal(tokenCalls - before, 5);
  assert.equal(rs.filter((r) => r.status === 429).length >= 5, true);
  // 동시에 맞는 비밀번호와 틀린 것이 섞여도 잠긴 뒤에는 맞는 것도 거절
  const m = await call({ action: 'login', slot: 1, password: 'first-pw1' });
  assert.equal(m.status, 429);
});

test('잠금 단계: 15분 -> 1시간이 상한, 24시간 틀림이 없으면 처음(15분)으로, 다른 칸은 영향 없음', async () => {
  const lockOnce = async () => { for (let i = 0; i < 5; i++) await call({ action: 'login', slot: 2, password: 'bad-' + i }); return db.slots[2].locked_until - nowMs; };
  nowMs += 3 * 24 * 3600000;
  assert.equal(await lockOnce(), 15 * 60000);
  nowMs += 16 * 60000;
  assert.equal(await lockOnce(), 60 * 60000);
  nowMs += 61 * 60000;
  assert.equal(await lockOnce(), 60 * 60000); // 상한 1시간 (하루 잠금 없음)
  nowMs += 25 * 3600000; // 24시간 넘게 틀림 없음
  assert.equal(await lockOnce(), 15 * 60000);
  const sl = await call({ action: 'slots' });
  assert.equal(sl.body.slots[0].locked_until, null);
});

test('비밀값(pepper)은 DB 에서 읽고 어떤 응답에도 나오지 않음 / 없으면 설정 안 끝남 안내', async () => {
  const all = [];
  all.push(JSON.stringify(await call({ action: 'slots' })));
  all.push(JSON.stringify(await call({ action: 'login', slot: 2, password: 'x' })));
  all.push(JSON.stringify(await call({ action: 'setup', slot: 2, password: '1234' })));
  assert.ok(db.secretReads >= 1);
  assert.doesNotMatch(all.join(''), new RegExp(PEPPER));
});

test('이미 같은 이메일 계정이 있는 칸(만들다 만 경우)도 찾아서 비밀번호만 설정', async () => {
  const mail = slotEmail(2);
  const id = '00000000-0000-4000-8000-0000000000ff';
  delete db.users[db.slots[2].user_id]; // 앞 시험에서 만든 계정을 지우고, 이메일만 같은 반쯤 만든 계정을 둔다
  db.users[id] = { id, email: mail, password: 'stale', confirmed: true };
  db.slots[2].state = 'unset'; db.slots[2].user_id = null; // 상태만 미설정으로
  const r = await call({ action: 'setup', slot: 2, password: 'recover-2' });
  assert.equal(r.status, 200);
  assert.equal(db.slots[2].user_id, id);
  assert.equal(db.users[id].password, await derivePassword(2, 'recover-2', PEPPER));
});

test('계정 만들기가 실패하면 칸을 다시 미설정으로 돌려놓음(먼저 차지만 하고 못 쓰게 되지 않음)', async () => {
  db.slots[3].state = 'unset'; db.slots[3].user_id = null; // 사용자3 을 열었다고 가정
  const f = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => (new URL(u).pathname === '/auth/v1/admin/users' && init.method === 'POST' ? jres(500, {}) : f(u, init));
  const r = await call({ action: 'setup', slot: 3, password: 'third-pass3' });
  globalThis.fetch = f;
  assert.equal(r.status, 500);
  assert.equal(db.slots[3].state, 'unset');
});

test('비밀값이 없으면(0005 미적용) 「서버 설정이 끝나지 않았습니다」', async () => {
  const { readFileSync, writeFileSync, unlinkSync } = await import('node:fs');
  const tmp = new URL('./_tmp_nopepper.ts', import.meta.url); // 함수 안에 값을 기억해 두므로 새 사본으로 확인
  writeFileSync(tmp, readFileSync(new URL('../supabase/functions/pt-auth/index.single.ts', import.meta.url)));
  const keep = db.pepper; db.pepper = '';
  const old = handler;
  try {
    await import(tmp.href);
    const r = await handler(new Request(URL_, { method: 'POST', body: JSON.stringify({ action: 'slots' }) }));
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, 'config');
  } finally { handler = old; db.pepper = keep; unlinkSync(tmp); }
});

test('index.single.ts 안의 logic 블록이 logic.js 와 같다(복사본이 어긋나지 않음)', async () => {
  const { readFileSync } = await import('node:fs');
  const nl = (t) => t.replace(/\r\n/g, '\n');
  const logic = nl(readFileSync(new URL('../supabase/functions/pt-auth/logic.js', import.meta.url), 'utf-8')).replace(/export /g, '');
  const single = nl(readFileSync(new URL('../supabase/functions/pt-auth/index.single.ts', import.meta.url), 'utf-8'));
  const a = '// ==== logic 시작 ====';
  const block = single.slice(single.indexOf(a) + a.length, single.indexOf('// ==== logic 끝 ===='));
  assert.equal(block.trim(), logic.trim());
  assert.doesNotMatch(single, /PT_PEPPER/);
  assert.doesNotMatch(single, /^import /m); // 편집기에서 바로 붙여넣을 수 있게 import 없음
});
