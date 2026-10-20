// logic.js - 로그인 함수(pt-auth)와 시험용 가짜 서버가 함께 쓰는 순수 함수.
// 서버 SQL 함수 pt_auth_fail 의 잠금 시간(pt_lock_minutes)과 같은 값을 써야 합니다.

export const MAX_FAILS = 5;
export const MIN_PW_LEN = 4;
export const MAX_PW_LEN = 64;

const COMMON = new Set([
  '1234', '12345', '123456', '1234567', '12345678', '0000', '00000', '000000', '1111', '11111', '111111',
  '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '4321', '654321', '123123', '112233',
  '121212', '147258', '159753', '1q2w3e4r', 'password', 'qwer1234', 'abcd', 'abcd1234', 'aaaa', 'qwerty',
]);

/** 비밀번호 규칙: 4자 이상, 글자 종류 제한 없음, 흔한 값 거절. 문제 없으면 null */
export function validatePassword(pw) {
  if (typeof pw !== 'string') return '비밀번호를 입력해 주세요.';
  if (pw.length < MIN_PW_LEN) return `비밀번호는 ${MIN_PW_LEN}자 이상이어야 합니다.`;
  if (pw.length > MAX_PW_LEN) return '비밀번호가 너무 깁니다.';
  if (COMMON.has(pw.toLowerCase())) return '너무 흔한 비밀번호입니다. 다른 것으로 정해 주세요.';
  if (/^(.)\1+$/.test(pw)) return '같은 글자만 반복한 비밀번호는 쓸 수 없습니다.';
  return null;
}

/** 잠금 시간(분): 15분 -> 1시간. 1시간이 상한입니다(하루 잠금 없음). */
export function lockMinutes(level) {
  return level <= 1 ? 15 : 60;
}
export const MAX_LOCK_LEVEL = 2;
export const LEVEL_RESET_MS = 24 * 3600 * 1000; // 24시간 동안 틀림이 없으면 단계를 처음(15분)으로

/**
 * 시도를 하기 「전에」 먼저 틀린 횟수를 올립니다(성공하면 pt_auth_ok 가 되돌림).
 * 이렇게 해야 동시에 여러 번 보내도 5번까지만 비밀번호 확인이 일어납니다.
 * state = {failed_count, lock_level, last_failed_at(ms)}
 * 반환: {failed_count, lock_level, locked_minutes|null, remaining, last_failed_at}
 */
export function registerFail(state, nowMs = Date.now()) {
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
export async function derivePassword(slot, password, pepper) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`pt:${slot}:${password}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function slotEmail(slot) {
  return `slot${slot}@pt.example.com`;
}

export const SLOT_LABEL = { 1: '사용자1', 2: '사용자2', 3: '사용자3' };
