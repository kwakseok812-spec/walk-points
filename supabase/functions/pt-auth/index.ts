// pt-auth: 걷기 포인트 앱의 로그인 함수 (Supabase Edge Function, Deno)
// 하는 일: 사용자 칸 목록 · 첫 설정(한 번만) · 로그인(5번 틀리면 잠금) · 비밀번호 바꾸기 · 전체 로그아웃
// 앱(브라우저)은 서비스 키를 모릅니다. 이 함수만 서비스 키로 pt_auth_state 와 로그인 계정을 다룹니다.
//
// 필요한 비밀값(Edge Function secrets)
//   PT_PEPPER  : 32자 이상 아무 글자나(한 번 정하면 바꾸지 말 것 - 바꾸면 모든 비밀번호가 무효가 됩니다)
//   (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 는 Supabase 가 자동으로 넣어 줍니다)
//
// 배포: supabase functions deploy pt-auth --no-verify-jwt   (config.toml 의 verify_jwt=false 와 같은 뜻)
import { derivePassword, slotEmail, validatePassword } from './logic.js';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PEPPER = Deno.env.get('PT_PEPPER') ?? '';

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
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await svc(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
  const text = await r.text();
  if (!r.ok) throw new Error(`rpc ${name} ${r.status}`);
  return text ? JSON.parse(text) : null;
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

/** 틀렸을 때: 횟수를 올리고 남은 횟수 또는 잠금을 알려 줌 */
async function failResponse(slot: number, wrongMsg: string) {
  const rows = await rpc('pt_auth_fail', { p_slot: slot });
  const f = Array.isArray(rows) ? rows[0] : rows;
  if (f.just_locked) return json(429, { error: 'locked', message: '잠시 잠겨 있습니다.', until: f.until_at });
  return json(401, { error: 'wrong', message: wrongMsg, remaining: f.remaining });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method' });
  if (PEPPER.length < 16) return json(500, { error: 'config', message: '서버 설정이 끝나지 않았습니다.' });

  let body: any = {};
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }
  const action = body.action;
  const slot = Number(body.slot);
  const needSlot = () => Number.isInteger(slot) && slot >= 1 && slot <= 3;

  try {
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
      const userId = await rpc('pt_auth_claim', { p_slot: slot });
      if (!userId) {
        const row = await getSlot(slot);
        if (row && row.state === 'disabled') return json(403, { error: 'disabled', message: '지금은 사용할 수 없는 사용자입니다.' });
        return json(409, { error: 'already_set', message: '이미 비밀번호가 정해져 있습니다.' });
      }
      const derived = await derivePassword(slot, body.password, PEPPER);
      if (!(await setPassword(userId, derived))) {
        await rpc('pt_auth_unclaim', { p_slot: slot });
        return json(500, { error: 'server', message: '설정하지 못했습니다. 잠시 뒤에 다시 해 주세요.' });
      }
      const s = await signIn(slot, derived);
      if (!s) return json(500, { error: 'server', message: '설정은 되었지만 열지 못했습니다. 다시 로그인해 주세요.' });
      return json(200, sessionBody(slot, s));
    }

    /* 로그인: 칸별로 5번 틀리면 잠금(15분 -> 1시간 -> 하루). 잠긴 동안은 맞는 비밀번호도 거절 */
    if (action === 'login') {
      if (!needSlot()) return json(400, { error: 'bad_slot' });
      const row = await getSlot(slot);
      if (!row) return json(400, { error: 'bad_slot' });
      if (row.state === 'disabled') return json(403, { error: 'disabled', message: '지금은 사용할 수 없는 사용자입니다.' });
      if (row.state === 'unset') return json(409, { error: 'unset', message: '처음 사용 설정이 필요합니다.' });
      if (isLocked(row)) return json(429, { error: 'locked', message: '잠시 잠겨 있습니다.', until: row.locked_until });
      const derived = await derivePassword(slot, String(body.password ?? ''), PEPPER);
      const s = await signIn(slot, derived);
      if (!s) return await failResponse(slot, '비밀번호가 다릅니다.');
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
      const cur = await signIn(row.slot, await derivePassword(row.slot, String(body.current ?? ''), PEPPER));
      if (!cur) return await failResponse(row.slot, '지금 비밀번호가 다릅니다.');
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
