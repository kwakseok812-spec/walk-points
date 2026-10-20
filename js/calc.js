// calc.js - 계산 규칙 (DESIGN 6절). 화면·서버와 무관한 순수 함수만 둡니다.
// 날짜는 항상 한국 시간(UTC+9) 기준입니다.

export const TZ_OFFSET_MIN = 540;
export const TRASH_DAYS = 30;
export const MAX_TOTAL = 999999999;

const pad2 = (n) => String(n).padStart(2, '0');

/** 한국 시간 기준 'YYYY-MM-DD' */
export function kstDate(d) {
  const t = new Date(new Date(d).getTime() + TZ_OFFSET_MIN * 60000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** 한국 시간 기준 시:분 */
export function kstTime(d) {
  const t = new Date(new Date(d).getTime() + TZ_OFFSET_MIN * 60000);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}

/** 그 날짜의 마지막 시각(한국 시간 23:59:59.999)을 ISO로 */
export function endOfDayIso(dateStr) {
  return new Date(`${dateStr}T23:59:59.999+09:00`).toISOString();
}

export function addDays(dateStr, n) {
  const t = new Date(`${dateStr}T12:00:00+09:00`);
  t.setUTCDate(t.getUTCDate() + n);
  return kstDate(t);
}

/** '2026-10-17' -> '10/17' */
export function fmtMD(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
/** '2026-10-17' -> '10월 17일 (토)' */
export function fmtLongDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  const w = new Date(`${dateStr}T12:00:00+09:00`).getUTCDay();
  return `${m}월 ${d}일 (${WEEK[w]})`;
}

export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const neg = n < 0;
  const s = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + s;
}

/** 차이를 +312 / -40 / 0 으로 (색만으로 구분하지 않도록 기호 포함) */
export function fmtDiff(n) {
  if (n === null || n === undefined) return '';
  if (n > 0) return `+${fmtNum(n)}`;
  if (n < 0) return `-${fmtNum(Math.abs(n))}`;
  return '0';
}

const live = (r) => !r.deleted_at;
const t = (iso) => Date.parse(iso);

export function liveLogs(logs, appId) {
  return logs.filter((l) => live(l) && l.app_id === appId).sort(cmpLog);
}
export function liveSpends(spends, appId) {
  return spends.filter((s) => live(s) && s.app_id === appId).sort((a, b) => t(a.spent_at) - t(b.spent_at));
}
function cmpLog(a, b) {
  if (a.log_date !== b.log_date) return a.log_date < b.log_date ? -1 : 1;
  return t(a.recorded_at) - t(b.recorded_at);
}

/** 이 기록 바로 앞의 기록(같은 앱, 지워지지 않은 것) */
export function prevLogOf(logs, log) {
  const arr = liveLogs(logs, log.app_id).filter((l) => l.id !== log.id && l.log_date < log.log_date);
  return arr.length ? arr[arr.length - 1] : null;
}

/** 어떤 날짜에 새로 기록한다고 할 때의 직전 기록 */
export function prevLogBefore(logs, appId, dateStr, exceptId = null) {
  const arr = liveLogs(logs, appId).filter((l) => l.id !== exceptId && l.log_date < dateStr);
  return arr.length ? arr[arr.length - 1] : null;
}

/** 두 시각 사이(앞 포함, 뒤 제외)의 지출 합. 같은 시각이면 기록이 먼저, 지출이 나중으로 봅니다 */
export function spendBetween(spends, appId, fromIso, toIso) {
  const a = fromIso ? t(fromIso) : -Infinity;
  const b = toIso ? t(toIso) : Infinity;
  return liveSpends(spends, appId)
    .filter((s) => t(s.spent_at) >= a && t(s.spent_at) < b)
    .reduce((x, s) => x + s.amount, 0);
}

/** 차이 = 이번 총포인트 - 직전 기록 총포인트 + 그 사이 지출 */
export function logDiff(logs, spends, log) {
  const prev = prevLogOf(logs, log);
  if (!prev) return { diff: null, prev: null };
  const between = spendBetween(spends, log.app_id, prev.recorded_at, log.recorded_at);
  return { diff: log.total - prev.total + between, prev };
}

/** 잔액 = 가장 가까운 앞선(가장 최근) 기록의 총포인트 - 그 기록 시각 이후의 지출 */
export function balanceOf(logs, spends, appId) {
  const arr = liveLogs(logs, appId);
  if (!arr.length) return null;
  const last = arr[arr.length - 1];
  const after = liveSpends(spends, appId).filter((s) => t(s.spent_at) >= t(last.recorded_at));
  return last.total - after.reduce((x, s) => x + s.amount, 0);
}

/** 홈 카드에 필요한 값 한 묶음 */
export function appSummary(app, logs, spends, today) {
  const arr = liveLogs(logs, app.id);
  const todayLog = arr.find((l) => l.log_date === today) || null;
  const lastLog = arr.length ? arr[arr.length - 1] : null;
  let diff = null;
  let prev = null;
  if (todayLog) ({ diff, prev } = logDiff(logs, spends, todayLog));
  return {
    app,
    todayLog,
    lastLog,
    diff,
    prev, // 비교 대상(직전 기록)
    balance: balanceOf(logs, spends, app.id),
  };
}

export function totalBalance(apps, logs, spends) {
  return apps
    .filter(live)
    .reduce((x, a) => x + (balanceOf(logs, spends, a.id) || 0), 0);
}

/** 오늘 기록이 아직 없는 앱 중 현재 앱 다음 것(없으면 처음부터). 모두 끝났으면 null */
export function nextPendingApp(apps, logs, today, currentAppId) {
  const act = apps.filter(live).sort(cmpApp);
  const pending = act.filter((a) => !liveLogs(logs, a.id).some((l) => l.log_date === today));
  if (!pending.length) return null;
  const idx = act.findIndex((a) => a.id === currentAppId);
  const after = pending.find((a) => act.indexOf(a) > idx);
  return after || pending[0];
}
export function cmpApp(a, b) {
  return (a.sort ?? 0) - (b.sort ?? 0) || t(a.created_at) - t(b.created_at);
}

/** 이 날짜를 고치면 계산이 바뀌는 이후 기록 수 */
export function laterLogCount(logs, appId, dateStr) {
  return liveLogs(logs, appId).filter((l) => l.log_date > dateStr).length;
}

/**
 * 총포인트를 저장하기 전 점검. (DESIGN 4절 실수 방지)
 * 반환: { nochange, up10, down10, negative, diff, prev, later, existing }
 */
export function checkLogEntry({ logs, spends, appId, dateStr, total, today, existingId = null, nowIso, recordedAt }) {
  const out = { nochange: false, up10: false, down10: false, negative: false, diff: null, prev: null, later: 0, existing: null, error: null };
  if (!Number.isInteger(total) || total < 0 || total > MAX_TOTAL) { out.error = '숫자를 다시 확인해 주세요.'; return out; }
  if (dateStr > today) { out.error = '앞으로 올 날짜는 기록할 수 없습니다.'; return out; }
  const existing = liveLogs(logs, appId).find((l) => l.log_date === dateStr && l.id !== existingId) || null;
  const self = existingId ? logs.find((l) => l.id === existingId) : existing;
  out.existing = existing;
  if (self && self.log_date === dateStr && self.total === total && !self.deleted_at) out.nochange = true;
  const prev = prevLogBefore(logs, appId, dateStr, self ? self.id : null);
  out.prev = prev;
  if (prev) {
    const rec = recordedAt || (dateStr === today ? nowIso : endOfDayIso(dateStr));
    const between = spendBetween(spends, appId, prev.recorded_at, rec);
    out.diff = total - prev.total + between;
    if (prev.total > 0 && total >= prev.total * 10 && total !== prev.total) out.up10 = true;
    if (prev.total > 0 && total <= prev.total / 10) out.down10 = true;
    if (out.diff < 0) out.negative = true;
  }
  out.later = laterLogCount(logs, appId, dateStr);
  return out;
}

/** 지출 점검: 잔액보다 큰가 */
export function checkSpend({ logs, spends, appId, amount, spentIso, excludeId = null }) {
  const out = { error: null, overBalance: false, balance: null };
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_TOTAL) { out.error = '금액을 다시 확인해 주세요.'; return out; }
  const arr = liveLogs(logs, appId);
  if (!arr.length) { out.error = '먼저 포인트를 기록해 주세요.'; return out; }
  const sp = spends.filter((s) => s.id !== excludeId);
  // 그 시각 기준 잔액
  const upto = arr.filter((l) => t(l.recorded_at) <= t(spentIso));
  const base = upto.length ? upto[upto.length - 1] : null;
  if (base) {
    const used = liveSpends(sp, appId).filter((s) => t(s.spent_at) >= t(base.recorded_at) && t(s.spent_at) < t(spentIso));
    out.balance = base.total - used.reduce((x, s) => x + s.amount, 0);
    out.overBalance = amount > out.balance;
  }
  return out;
}

/** 휴지통 남은 일수 (삭제 후 30일) */
export function trashDaysLeft(deletedIso, nowIso) {
  const ms = t(deletedIso) + TRASH_DAYS * 86400000 - t(nowIso);
  return Math.max(0, Math.ceil(ms / 86400000));
}
export function isPurgeDue(deletedIso, nowIso) {
  return t(nowIso) - t(deletedIso) >= TRASH_DAYS * 86400000;
}

/** 이전 값(이력) 목록: 값이 바뀐 것만, 최신순 */
export function valueHistory(entity, entries) {
  const keys = { log: ['total', 'log_date'], spend: ['amount', 'memo', 'spent_at'], app: ['name'] }[entity];
  return entries
    .filter((h) => h.action === 'update' && h.old && h.new && keys.some((k) => h.old[k] !== h.new[k]))
    .sort((a, b) => t(b.at) - t(a.at));
}
