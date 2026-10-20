// @ts-nocheck  (편집기의 형식 검사를 끔: 아래 logic 블록이 형식 표기 없는 JS 라서)
// pt-auth: 걷기 포인트 앱의 로그인 함수 (Supabase Edge Function, Deno) - 단일 파일
// Supabase 대시보드 > Edge Functions > 새 함수 이름 「pt-auth」 편집기에 이 파일 전체를 붙여넣어 배포합니다.
//   * 반드시 함수 설정에서 「Verify JWT」를 끕니다(로그인 전에 부르는 함수이고, 필요한 확인은 함수 안에서 합니다).
//   * 이름·키·비밀값을 사람이 입력할 필요가 없습니다: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 는
//     Supabase 가 함수에 자동으로 넣어 주고, 비밀번호를 섞는 값(pepper)은 SQL 마이그레이션 0005 가 DB(pt_secret 표)에 만들어 둡니다.
//
// 하는 일: 사용자 칸 목록 · 첫 설정(한 번만, 로그인 계정이 없으면 이때 만듦) · 로그인(5번 틀리면 잠금)
//          · 비밀번호 바꾸기 · 전체 로그아웃
// 앱(브라우저)은 서비스 키를 모릅니다. 이 함수만 서비스 권한으로 표와 로그인 계정을 다룹니다.
//
// 아래 「logic 시작~끝」 블록은 supabase/functions/pt-auth/logic.js 의 내용을 그대로 복사한 것입니다(export 만 뺌)
// (tests/edge.test.mjs 가 두 파일이 같은지 검사합니다. logic.js 를 고치면 이 블록도 같이 고칠 것).

// ==== logic 시작 ====
// logic.js - 로그인 함수(pt-auth)와 시험용 가짜 서버가 함께 쓰는 순수 함수.
// 서버 SQL 함수 pt_auth_fail 의 잠금 시간(pt_lock_minutes)과 같은 값을 써야 합니다.

const MAX_FAILS = 5;
const MIN_PW_LEN = 4;
const MAX_PW_LEN = 64;

const COMMON = new Set([
  '1234', '12345', '123456', '1234567', '12345678', '0000', '00000', '000000', '1111', '11111', '111111',
  '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '4321', '654321', '123123', '112233',
  '121212', '147258', '159753', '1q2w3e4r', 'password', 'qwer1234', 'abcd', 'abcd1234', 'aaaa', 'qwerty',
]);

/** 비밀번호 규칙: 4자 이상, 글자 종류 제한 없음, 흔한 값 거절. 문제 없으면 null */
function validatePassword(pw) {
  if (typeof pw !== 'string') return '비밀번호를 입력해 주세요.';
  if (pw.length < MIN_PW_LEN) return `비밀번호는 ${MIN_PW_LEN}자 이상이어야 합니다.`;
  if (pw.length > MAX_PW_LEN) return '비밀번호가 너무 깁니다.';
  if (COMMON.has(pw.toLowerCase())) return '너무 흔한 비밀번호입니다. 다른 것으로 정해 주세요.';
  if (/^(.)\1+$/.test(pw)) return '같은 글자만 반복한 비밀번호는 쓸 수 없습니다.';
  return null;
}

/** 잠금 시간(분): 15분 -> 1시간. 1시간이 상한입니다(하루 잠금 없음). */
function lockMinutes(level) {
  return level <= 1 ? 15 : 60;
}
const MAX_LOCK_LEVEL = 2;
const LEVEL_RESET_MS = 24 * 3600 * 1000; // 24시간 동안 틀림이 없으면 단계를 처음(15분)으로

/**
 * 시도를 하기 「전에」 먼저 틀린 횟수를 올립니다(성공하면 pt_auth_ok 가 되돌림).
 * 이렇게 해야 동시에 여러 번 보내도 5번까지만 비밀번호 확인이 일어납니다.
 * state = {failed_count, lock_level, last_failed_at(ms)}
 * 반환: {failed_count, lock_level, locked_minutes|null, remaining, last_failed_at}
 */
function registerFail(state, nowMs = Date.now()) {
  let failed = state.failed_count || 0;
  let level = state.lock_level || 0;
  if (state.last_failed_at && nowMs - state.last_failed_at >= LEVEL_RESET_MS) { failed = 0; level = 0; }
  failed += 1;
  if (failed >= MAX_FAILS) {
    level = Math.min(level + 1, MAX_LOCK_LEVEL);
    return { failed_count: 0, lock_level: level, locked_minutes: lockMinutes(level), remaining: 0, last_failed_at: nowMs };
  }
  return { failed_count: failed, lock_level: level, locked_minutes: null, remaining: MAX_FAILS - failed, last_failed_at: nowMs };
}

/**
 * 서버 로그인 기능에는 최소 길이 제한(6자)이 있고, 사용자가 정한 짧은 값을 그대로 쓸 수 없어서
 * 사용자 비밀번호를 서버 비밀값(pepper)과 섞어 64자 해시 문자열로 바꿔 보냅니다.
 * (같은 칸 + 같은 비밀번호 + 같은 pepper 이면 항상 같은 값)
 */
async function derivePassword(slot, password, pepper) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`pt:${slot}:${password}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function slotEmail(slot) {
  return `slot${slot}@pt.example.com`;
}

const SLOT_LABEL = { 1: '사용자1', 2: '사용자2', 3: '사용자3' };
// ==== logic 끝 ====

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function svc(path: string, init: RequestInit = {}) {
  return fetch(URL_ + path, {
    ...init,
    headers: {
      apikey: SERVICE,
      // 새 형식 키(sb_secret_)는 JWT가 아니라서 Authorization 머리말에 넣지 않음
      ...(SERVICE.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SERVICE}` }),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await svc(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
  const text = await r.text();
  if (!r.ok) throw new Error(`rpc ${name} ${r.status}`);
  return text ? JSON.parse(text) : null;
}

/** 비밀번호를 섞는 값: DB(pt_secret)에서 읽음. 값은 어디에도 출력하지 않는다. */
let pepperCache = '';
async function getPepper() {
  if (pepperCache) return pepperCache;
  const r = await svc('/rest/v1/pt_secret?name=eq.pepper&select=value');
  if (!r.ok) return '';
  const rows = await r.json();
  pepperCache = rows[0]?.value ?? '';
  return pepperCache;
}

async function getSlot(slot: number) {
  const r = await svc(`/rest/v1/pt_auth_state?slot=eq.${slot}&select=slot,user_id,state,locked_until`);
  const rows = await r.json();
  return rows[0] ?? null;
}
async function setPassword(userId: string, derived: string) {
  const r = await svc(`/auth/v1/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify({ password: derived }) });
  return r.ok;
}
async function findUserId(mail: string) {
  for (let page = 1; page <= 20; page++) {
    const r = await svc(`/auth/v1/admin/users?page=${page}&per_page=100`);
    if (!r.ok) return null;
    const d = await r.json();
    const users = d.users ?? d;
    if (!users || !users.length) return null;
    const u = users.find((x: any) => x.email === mail);
    if (u) return u.id as string;
  }
  return null;
}
/** 그 칸의 로그인 계정을 만들고(이미 있으면 찾아서) 비밀번호를 설정. 성공하면 user id */
async function createOrSetUser(slot: number, existingId: string | null, derived: string) {
  if (existingId) return (await setPassword(existingId, derived)) ? existingId : null;
  const r = await svc('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: slotEmail(slot), password: derived, email_confirm: true }),
  });
  if (r.ok) return (await r.json()).id as string;
  // 같은 이메일 계정이 이미 있으면(이전에 만들다 만 경우) 찾아서 비밀번호만 설정
  const id = await findUserId(slotEmail(slot));
  if (id && (await setPassword(id, derived))) return id;
  return null;
}
async function signIn(slot: number, derived: string) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: slotEmail(slot), password: derived }),
  });
  if (!r.ok) return null;
  return await r.json();
}
const sessionBody = (slot: number, s: any) => ({ slot, access_token: s.access_token, refresh_token: s.refresh_token, user: { id: s.user?.id } });
const isLocked = (row: any) => row.locked_until && Date.parse(row.locked_until) > Date.now();

async function userFromBearer(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const r = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!r.ok) return null;
  return await r.json();
}

/**
 * 비밀번호를 확인하기 「전에」 먼저 틀린 횟수를 올립니다(pt_auth_fail). 맞으면 pt_auth_ok 로 되돌립니다.
 * 동시에 여러 요청이 와도 칸당 5번까지만 확인이 일어납니다. 반환: {locked: Response} 또는 {f: 결과}
 */
async function countAttempt(slot: number) {
  const rows = await rpc('pt_auth_fail', { p_slot: slot });
  const f = Array.isArray(rows) ? rows[0] : rows;
  if (!f.allowed) return { locked: json(429, { error: 'locked', message: '잠시 잠겨 있습니다.', until: f.until_at }) };
  return { f };
}
/** 확인에 실패했을 때 응답: 이번 시도로 잠겼으면 잠금, 아니면 남은 횟수 */
function failResponse(f: any, wrongMsg: string) {
  if (f.just_locked) return json(429, { error: 'locked', message: '잠시 잠겨 있습니다.', until: f.until_at });
  return json(401, { error: 'wrong', message: wrongMsg, remaining: f.remaining });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method' });

  let body: any = {};
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }
  const action = body.action;
  const slot = Number(body.slot);
  const needSlot = () => Number.isInteger(slot) && slot >= 1 && slot <= 3;

  try {
    const PEPPER = await getPepper();
    if (PEPPER.length < 32) return json(500, { error: 'config', message: '서버 설정이 끝나지 않았습니다.' });

    /* 사용자 칸 목록: 번호와 상태뿐 (이름·계정·기록은 내보내지 않음) */
    if (action === 'slots') {
      const r = await svc('/rest/v1/pt_auth_state?select=slot,state,locked_until&order=slot');
      const rows = await r.json();
      const slots = rows.map((x: any) => ({ slot: x.slot, state: x.state, locked_until: isLocked(x) ? x.locked_until : null }));
      return json(200, { slots });
    }

    /* 첫 설정: 미설정 칸에 한해 한 번만. 동시에 두 번 와도 먼저 도착한 것만 인정(pt_auth_claim 이 한 줄씩 처리) */
    if (action === 'setup') {
      if (!needSlot()) return json(400, { error: 'bad_slot' });
      const bad = validatePassword(body.password);
      if (bad) return json(400, { error: 'weak', message: bad });
      const rows = await rpc('pt_auth_claim', { p_slot: slot });
      const claim = Array.isArray(rows) ? rows[0] : rows;
      if (!claim || !claim.claimed) {
        const row = await getSlot(slot);
        if (row && row.state === 'disabled') return json(403, { error: 'disabled', message: '지금은 사용할 수 없는 사용자입니다.' });
        return json(409, { error: 'already_set', message: '이미 비밀번호가 정해져 있습니다.' });
      }
      const derived = await derivePassword(slot, body.password, PEPPER);
      const userId = await createOrSetUser(slot, claim.user_id ?? null, derived);
      if (!userId) {
        await rpc('pt_auth_unclaim', { p_slot: slot });
        return json(500, { error: 'server', message: '설정하지 못했습니다. 잠시 뒤에 다시 해 주세요.' });
      }
      if (!claim.user_id) await rpc('pt_auth_set_user', { p_slot: slot, p_user: userId });
      const s = await signIn(slot, derived);
      if (!s) return json(500, { error: 'server', message: '설정은 되었지만 열지 못했습니다. 다시 로그인해 주세요.' });
      return json(200, sessionBody(slot, s));
    }

    /* 로그인: 칸별로 5번 틀리면 잠금(15분 -> 1시간). 잠긴 동안은 맞는 비밀번호도 거절 */
    if (action === 'login') {
      if (!needSlot()) return json(400, { error: 'bad_slot' });
      const row = await getSlot(slot);
      if (!row) return json(400, { error: 'bad_slot' });
      if (row.state === 'disabled') return json(403, { error: 'disabled', message: '지금은 사용할 수 없는 사용자입니다.' });
      if (row.state === 'unset') return json(409, { error: 'unset', message: '처음 사용 설정이 필요합니다.' });
      if (isLocked(row)) return json(429, { error: 'locked', message: '잠시 잠겨 있습니다.', until: row.locked_until });
      const att = await countAttempt(slot);
      if (att.locked) return att.locked;
      const derived = await derivePassword(slot, String(body.password ?? ''), PEPPER);
      const s = await signIn(slot, derived);
      if (!s) return failResponse(att.f, '비밀번호가 다릅니다.');
      await rpc('pt_auth_ok', { p_slot: slot });
      return json(200, sessionBody(slot, s));
    }

    /* 비밀번호 바꾸기: 로그인한 상태 + 지금 비밀번호 확인. 끝나면 다른 기기 로그인은 끊김 */
    if (action === 'change') {
      const me = await userFromBearer(req);
      if (!me || !me.id) return json(401, { error: 'no_auth', message: '로그인이 필요합니다.' });
      const r = await svc(`/rest/v1/pt_auth_state?user_id=eq.${me.id}&select=slot,user_id,state,locked_until`);
      const row = (await r.json())[0];
      if (!row || row.state !== 'set') return json(403, { error: 'forbidden' });
      if (isLocked(row)) return json(429, { error: 'locked', message: '잠시 잠겨 있습니다.', until: row.locked_until });
      const bad = validatePassword(body.password);
      if (bad) return json(400, { error: 'weak', message: bad });
      const att = await countAttempt(row.slot);
      if (att.locked) return att.locked;
      const cur = await signIn(row.slot, await derivePassword(row.slot, String(body.current ?? ''), PEPPER));
      if (!cur) return failResponse(att.f, '지금 비밀번호가 다릅니다.');
      await rpc('pt_auth_ok', { p_slot: row.slot });
      const derived = await derivePassword(row.slot, body.password, PEPPER);
      if (!(await setPassword(row.user_id, derived))) return json(500, { error: 'server', message: '바꾸지 못했습니다.' });
      await rpc('pt_revoke_sessions', { p_user: row.user_id });
      const s = await signIn(row.slot, derived);
      if (!s) return json(500, { error: 'server', message: '바꾸었지만 열지 못했습니다. 다시 로그인해 주세요.' });
      return json(200, sessionBody(row.slot, s));
    }

    /* 모든 기기에서 로그아웃 */
    if (action === 'logout_all') {
      const me = await userFromBearer(req);
      if (!me || !me.id) return json(401, { error: 'no_auth', message: '로그인이 필요합니다.' });
      const r = await svc(`/rest/v1/pt_auth_state?user_id=eq.${me.id}&select=slot`);
      if (!(await r.json())[0]) return json(403, { error: 'forbidden' });
      await rpc('pt_revoke_sessions', { p_user: me.id });
      return json(200, { ok: true });
    }

    return json(400, { error: 'bad_action' });
  } catch (_e) {
    return json(500, { error: 'server', message: '서버가 잠시 응답하지 않습니다.' });
  }
});
