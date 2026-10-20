// 서버 없이 도는 자동 시험: 계산 · 수정 · 휴지통 · 되돌리기 · 오프라인 · 로그인 · 사용자 분리
// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/calc.js';
import { MemoryServer, createMemoryAdapter, ApiError, NetworkError } from '../js/data.js';
import { createStore, SaveError } from '../js/store.js';

const at = (s) => Date.parse(s); // '2026-10-20T09:00:00+09:00'
const DAY = 86400000;

/** 시험용 세계: 시계를 손으로 움직입니다. */
function world(startIso = '2026-10-20T09:00:00+09:00', { skew = 0 } = {}) {
  const w = { T: at(startIso) };
  w.server = new MemoryServer({ now: () => w.T + 0 });
  w.clock = () => w.T + skew; // 폰 시계(어긋날 수 있음)
  w.adapter = createMemoryAdapter(w.server, { phoneClockSkewMs: skew });
  w.store = createStore({ adapter: w.adapter, clock: w.clock });
  w.set = (iso) => { w.T = at(iso); };
  w.advance = (ms) => { w.T += ms; };
  return w;
}
async function loggedIn(w, slot = 1, pw = 'abc1234') {
  await w.store.setup(slot, pw);
  return w.store;
}
const live = (st, k) => st.state[k].filter((r) => !r.deleted_at);

test('날짜: 한국 시간 경계 23:59 / 00:00', () => {
  assert.equal(C.kstDate(at('2026-10-20T23:59:59+09:00')), '2026-10-20');
  assert.equal(C.kstDate(at('2026-10-21T00:00:00+09:00')), '2026-10-21');
  // 세계표준시로는 아직 전날이지만 한국은 이미 다음 날
  assert.equal(C.kstDate(Date.parse('2026-10-20T15:30:00Z')), '2026-10-21');
  assert.equal(C.kstDate(Date.parse('2026-10-20T00:30:00Z')), '2026-10-20'); // 한국 09:30
  assert.equal(C.endOfDayIso('2026-10-20'), new Date('2026-10-20T23:59:59.999+09:00').toISOString());
  assert.equal(C.addDays('2026-10-31', 1), '2026-11-01');
});

test('계산: 직전 대비 차이·잔액 (기본)', async () => {
  const w = world();
  const st = await loggedIn(w);
  w.set('2026-10-17T08:00:00+09:00');
  const { app } = await st.addApp({ name: '캐시워크', total: 10000 });
  w.set('2026-10-20T08:00:00+09:00');
  await st.saveLog({ appId: app.id, total: 10312 });
  const s = st.summaries()[0];
  assert.equal(s.todayLog.total, 10312);
  assert.equal(s.diff, 312);
  assert.equal(s.prev.log_date, '2026-10-17'); // 「지난 기록(10/17) 대비」
  assert.equal(s.balance, 10312);
});

test('계산: 같은 날 아침 지출 -> 저녁 기록은 지출을 다시 빼지 않는다', async () => {
  const w = world('2026-10-20T07:00:00+09:00');
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.set('2026-10-20T08:00:00+09:00');
  await st.addSpend({ appId: app.id, amount: 300, memo: '기프티콘' });
  assert.equal(st.summaries()[0].balance, 700); // 1000 - 300
  w.set('2026-10-20T20:00:00+09:00');
  await st.saveLog({ appId: app.id, total: 1200 }); // 저녁에 앱 화면에 보이는 값(지출 반영됨)
  const s = st.summaries()[0];
  assert.equal(s.balance, 1200); // 다시 빼지 않음
  // 같은 날이라 직전 기록은 없음(첫 날)
});

test('계산: 지출이 낀 다음 날 차이는 지출을 더해서 계산', async () => {
  const w = world('2026-10-19T07:00:00+09:00');
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.set('2026-10-19T21:00:00+09:00');
  await st.addSpend({ appId: app.id, amount: 300, memo: '기프티콘' }); // 잔액 700
  w.set('2026-10-20T08:00:00+09:00');
  await st.saveLog({ appId: app.id, total: 900 }); // 앱 화면: 700 + 200 걸음 = 900
  const s = st.summaries()[0];
  assert.equal(s.diff, 900 - 1000 + 300); // = 200
});

test('계산: 빠진 날 소급 입력 -> 뒤 날짜 차이 자동 재계산', async () => {
  const w = world('2026-10-15T08:00:00+09:00');
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.set('2026-10-17T08:00:00+09:00');
  await st.saveLog({ appId: app.id, total: 1500 });
  w.set('2026-10-20T08:00:00+09:00');
  const diffOf = (d) => { const l = C.liveLogs(st.state.logs, app.id).find((x) => x.log_date === d); return C.logDiff(st.state.logs, st.state.spends, l).diff; };
  assert.equal(diffOf('2026-10-17'), 500);
  await st.saveLog({ appId: app.id, date: '2026-10-16', total: 1200 }); // 빠진 날 채움
  assert.equal(diffOf('2026-10-16'), 200);
  assert.equal(diffOf('2026-10-17'), 300);
  const l16 = C.liveLogs(st.state.logs, app.id).find((x) => x.log_date === '2026-10-16');
  assert.equal(l16.recorded_at, C.endOfDayIso('2026-10-16')); // 소급 입력 시각 = 그 날짜의 마지막 시각
});

test('계산: 지난 날짜 수정 -> 이후 차이 재계산 + 영향받는 이후 날짜 수', async () => {
  const w = world('2026-10-15T08:00:00+09:00');
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  for (const [d, v] of [['2026-10-16', 1100], ['2026-10-17', 1300], ['2026-10-18', 1350]]) {
    w.set(`${d}T08:00:00+09:00`); await st.saveLog({ appId: app.id, total: v });
  }
  w.set('2026-10-20T08:00:00+09:00');
  assert.equal(C.laterLogCount(st.state.logs, app.id, '2026-10-16'), 2);
  const l16 = C.liveLogs(st.state.logs, app.id).find((x) => x.log_date === '2026-10-16');
  await st.editLog(l16.id, { total: 1250 });
  const d = (date) => { const l = C.liveLogs(st.state.logs, app.id).find((x) => x.log_date === date); return C.logDiff(st.state.logs, st.state.spends, l).diff; };
  assert.equal(d('2026-10-16'), 250);
  assert.equal(d('2026-10-17'), 50);
  assert.equal(d('2026-10-18'), 50);
});

test('같은 날 다시 저장 = 덮어씀(줄이 늘지 않음), 이전 값은 이력에 남음', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.advance(3600000);
  const r = await st.saveLog({ appId: app.id, total: 1100 });
  assert.equal(r.overwritten, true);
  assert.equal(live(st, 'logs').length, 1);
  const hist = C.valueHistory('log', await st.historyOf('log', r.row.id));
  assert.equal(hist.length, 1);
  assert.equal(hist[0].old.total, 1000);
  assert.equal(hist[0].new.total, 1100);
  // 이전 값 복원
  await st.restoreValue('log', r.row.id, hist[0]);
  assert.equal(live(st, 'logs')[0].total, 1000);
  const hist2 = C.valueHistory('log', await st.historyOf('log', r.row.id));
  assert.equal(hist2.length, 2); // 복원도 이력으로 남음
});

test('수정 창의 값 고치기는 입력 시각을 유지 (사이에 낀 지출이 뒤집히지 않음)', async () => {
  const w = world('2026-10-20T07:00:00+09:00');
  const st = await loggedIn(w);
  const { app, log } = await st.addApp({ name: 'A', total: 1000 });
  w.set('2026-10-20T08:00:00+09:00');
  await st.addSpend({ appId: app.id, amount: 300, memo: '기프티콘' });
  w.set('2026-10-20T09:00:00+09:00');
  await st.editLog(log.id, { total: 1100 }); // 아침 기록 값을 잘못 적었던 것을 고침
  assert.equal(st.summaries()[0].balance, 800); // 1100 - 300 (지출은 여전히 기록 뒤)
});

test('휴지통: 지우기 -> 되살리기, 30일 뒤 사라짐, 앱 보관', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app, log } = await st.addApp({ name: 'A', total: 1000 });
  w.advance(DAY);
  await st.saveLog({ appId: app.id, total: 1200 });
  const l2 = live(st, 'logs').find((l) => l.total === 1200);
  await st.removeLog(l2.id);
  assert.equal(live(st, 'logs').length, 1);
  let tr = st.trashItems();
  assert.equal(tr.length, 1);
  assert.equal(tr[0].left, 30);
  await st.restoreLog(l2.id);
  assert.equal(live(st, 'logs').length, 2);
  // 앱 보관 -> 휴지통, 기록은 연쇄 삭제 없이 남음
  await st.removeApp(app.id);
  assert.equal(st.activeApps().length, 0);
  assert.equal(st.state.logs.length, 2);
  tr = st.trashItems();
  assert.equal(tr.length, 1);
  assert.equal(tr[0].kind, 'app');
  assert.equal(tr[0].count, 2);
  w.advance(29 * DAY);
  assert.equal(st.trashItems().length, 1);
  assert.equal(st.trashItems()[0].left, 1);
  await st.restoreApp(app.id);
  assert.equal(st.activeApps().length, 1);
  // 다시 지우고 30일 지나면 서버에서 영구 삭제
  await st.removeApp(app.id);
  w.advance(31 * DAY);
  assert.equal(st.trashItems().length, 0);
  await st.sync();
  assert.equal(w.server.tables.pt_apps.length, 0);
  assert.equal(w.server.tables.pt_logs.length, 0);
});

test('휴지통에서 되살릴 때 그 날짜에 다른 기록이 있으면 거부(덮어쓰지 않음)', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app, log } = await st.addApp({ name: 'A', total: 1000 });
  await st.removeLog(log.id);
  await st.saveLog({ appId: app.id, total: 2000 }); // 같은 날 새 기록
  await assert.rejects(() => st.restoreLog(log.id), (e) => e instanceof SaveError && /이미 있습니다/.test(e.message));
  assert.equal(live(st, 'logs').length, 1);
  assert.equal(live(st, 'logs')[0].total, 2000);
});

test('되돌리기: 저장 직후 한 번에 직전 상태로, 15초가 지나면 사라짐', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.advance(DAY);
  await st.saveLog({ appId: app.id, total: 1500 });
  assert.equal(live(st, 'logs').length, 2);
  assert.ok(st.state.undo);
  await st.undo();
  assert.equal(live(st, 'logs').length, 1);
  assert.equal(w.server.tables.pt_logs.length, 1); // 서버에서도 사라짐
  // 덮어쓰기 되돌리기 (오늘 첫 기록 -> 다시 저장 = 덮어씀 -> 되돌리기)
  const l = live(st, 'logs').find((x) => x.total === 1000);
  await st.saveLog({ appId: app.id, total: 7777 });
  await st.saveLog({ appId: app.id, total: 7778 });
  assert.equal(live(st, 'logs').find((x) => x.log_date === '2026-10-21').total, 7778);
  await st.undo();
  assert.equal(live(st, 'logs').find((x) => x.log_date === '2026-10-21').total, 7777);
  await st.undo().catch(() => {}); // 두 번째 되돌리기는 없음(한 번만)
  await st.removeLog(live(st, 'logs').find((x) => x.log_date === '2026-10-21').id);
  await st.undo();
  assert.equal(live(st, 'logs').length, 2);
  await st.removeLog(l.id);
  assert.equal(live(st, 'logs').length, 1);
  await st.undo();
  assert.equal(live(st, 'logs').length, 2);
  // 15초 뒤
  await st.saveLog({ appId: app.id, total: 8888 });
  w.advance(14000); st.expireUndo(); assert.ok(st.state.undo);
  w.advance(2000); st.expireUndo(); assert.equal(st.state.undo, null);
  // 다음 조작이 오면 이전 되돌리기는 사라지고 새것으로 교체
  await st.addSpend({ appId: app.id, amount: 10, memo: '기타' });
  assert.equal(st.state.undo.label, '포인트 사용');
});

test('되돌리기: 앱 추가 취소 -> 앱과 첫 기록 모두 사라짐', async () => {
  const w = world();
  const st = await loggedIn(w);
  await st.addApp({ name: 'B', total: 500 });
  await st.undo();
  assert.equal(st.state.apps.length, 0);
  assert.equal(st.state.logs.length, 0);
  assert.equal(w.server.tables.pt_apps.length, 0);
  assert.equal(w.server.tables.pt_logs.length, 0);
});

test('실수 방지: 10배·10분의 1·음수 차이·변화 없음·미래 날짜', async () => {
  const w = world('2026-10-19T08:00:00+09:00');
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.set('2026-10-20T08:00:00+09:00');
  const chk = (total, extra = {}) => C.checkLogEntry({ logs: st.state.logs, spends: st.state.spends, appId: app.id, dateStr: '2026-10-20', total, today: '2026-10-20', nowIso: st.nowIso(), ...extra });
  assert.equal(chk(10000).up10, true);
  assert.equal(chk(9999).up10, false);
  assert.equal(chk(100).down10, true);
  assert.equal(chk(101).down10, false);
  assert.equal(chk(0).down10, true);
  assert.equal(chk(900).negative, true);
  assert.equal(chk(900).diff, -100);
  assert.equal(chk(1100).negative, false);
  assert.equal(chk(1000).negative, false); // 0 은 음수가 아님
  assert.equal(C.checkLogEntry({ logs: st.state.logs, spends: [], appId: app.id, dateStr: '2026-10-21', total: 5, today: '2026-10-20' }).error != null, true);
  // 같은 값 연속 저장 = 변화 없음
  await st.saveLog({ appId: app.id, total: 1200 });
  assert.equal(chk(1200).nochange, true);
  assert.equal(chk(1201).nochange, false);
  // 음수 차이인데 지출이 사이에 있으면 음수가 아님 (사용으로 이미 기록한 경우)
  await st.addSpend({ appId: app.id, amount: 300, memo: '현금 전환' });
  const l = live(st, 'logs').find((x) => x.log_date === '2026-10-20');
  const c2 = C.checkLogEntry({ logs: st.state.logs, spends: st.state.spends, appId: app.id, dateStr: '2026-10-20', total: 900, today: '2026-10-20', nowIso: st.nowIso(), existingId: l.id });
  assert.equal(c2.negative, false); // 900 - 1000 + 300 = 200
  assert.equal(c2.diff, 200);
});

test('실수 방지: 지출이 잔액보다 크면 경고', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  const c = C.checkSpend({ logs: st.state.logs, spends: st.state.spends, appId: app.id, amount: 1500, spentIso: st.nowIso() });
  assert.equal(c.overBalance, true);
  assert.equal(C.checkSpend({ logs: st.state.logs, spends: st.state.spends, appId: app.id, amount: 1000, spentIso: st.nowIso() }).overBalance, false);
  assert.ok(C.checkSpend({ logs: st.state.logs, spends: st.state.spends, appId: app.id, amount: 0, spentIso: st.nowIso() }).error);
});

test('[다음 앱]: 오늘 기록 전인 앱으로 이동, 모두 끝나면 null', async () => {
  const w = world('2026-10-19T08:00:00+09:00');
  const st = await loggedIn(w);
  const a = (await st.addApp({ name: 'A', total: 100 })).app;
  const b = (await st.addApp({ name: 'B', total: 100 })).app;
  const c = (await st.addApp({ name: 'C', total: 100 })).app;
  w.set('2026-10-20T08:00:00+09:00');
  assert.equal(st.nextApp(a.id).id, b.id); // A 기록 직후 -> 아직 안 한 B
  await st.saveLog({ appId: a.id, total: 110 });
  assert.equal(st.nextApp(a.id).id, b.id);
  await st.saveLog({ appId: b.id, total: 110 });
  assert.equal(st.nextApp(b.id).id, c.id);
  await st.saveLog({ appId: c.id, total: 110 });
  assert.equal(st.nextApp(c.id), null);
  // 순환: C 부터 시작해 A,B 가 비어 있으면 처음 것으로
  w.set('2026-10-21T08:00:00+09:00');
  await st.saveLog({ appId: c.id, total: 120 });
  assert.equal(st.nextApp(c.id).id, a.id);
});

test('저장 실패: 서버가 거부하면 SaveError, 화면 값은 그대로(로컬 변경 없음)', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  const before = JSON.stringify(st.state.logs);
  w.server.failNext = { status: 400, code: 'rejected', msg: '서버가 저장을 거부했습니다.' };
  await assert.rejects(() => st.saveLog({ appId: app.id, total: 2000 }), (e) => e instanceof SaveError && /거부/.test(e.message));
  assert.equal(JSON.stringify(st.state.logs), before);
  assert.equal(st.state.undo.label, '앱 추가'); // 실패가 되돌리기를 지우지 않음
  // 앱 추가 도중 두 번째 쓰기가 거부되면 첫 번째도 서버에 남지 않음
  const apps0 = w.server.tables.pt_apps.length;
  const orig = w.server.upsert.bind(w.server);
  let n = 0;
  w.server.upsert = (t, a, rows) => { if (t === 'pt_logs' && n++ === 0) throw new ApiError(400, 'rejected', '거부'); return orig(t, a, rows); };
  await assert.rejects(() => st.addApp({ name: 'Z', total: 5 }));
  assert.equal(w.server.tables.pt_apps.length, apps0);
  assert.equal(st.state.apps.filter((a) => a.name === 'Z').length, 0);
  w.server.upsert = orig;
});

test('오프라인: 임시 저장 -> 연결되면 재전송, 입력 시각 보존, 그 전엔 「올라가지 않음」', async () => {
  const w = world('2026-10-20T07:00:00+09:00');
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.server.online = false;
  w.set('2026-10-20T08:00:00+09:00');
  const r = await st.saveLog({ appId: app.id, total: 1111 });
  assert.equal(r.status, 'queued');
  assert.equal(st.state.undo.status, 'queued');
  assert.ok(st.pendingIds().has(r.row.id));
  assert.equal(st.state.outbox.length, 1);
  assert.equal(w.server.tables.pt_logs[0].total, 1000); // 서버는 아직 모름
  assert.equal(st.state.online, false);
  w.set('2026-10-20T08:05:00+09:00');
  const r2 = await st.addSpend({ appId: app.id, amount: 100, memo: '기타' });
  assert.equal(r2.status, 'queued');
  assert.equal(st.summaries()[0].balance, 1111 - 100);
  w.set('2026-10-20T11:00:00+09:00'); // 세 시간 뒤 연결
  w.server.online = true;
  await st.sync();
  assert.equal(st.state.outbox.length, 0);
  assert.equal(st.pendingIds().size, 0);
  const row = w.server.tables.pt_logs[0];
  assert.equal(row.total, 1111);
  assert.equal(row.recorded_at, new Date('2026-10-20T08:00:00+09:00').toISOString()); // 폰에서 입력한 시각 그대로
  assert.equal(w.server.tables.pt_spends[0].spent_at, new Date('2026-10-20T08:05:00+09:00').toISOString());
});

test('오프라인에서 거부될 기록은 「못 올림」 목록에 남고 다시 시도할 수 있다', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 1000 });
  w.server.online = false;
  w.advance(DAY);
  await st.saveLog({ appId: app.id, total: 1300 });
  w.server.online = true;
  w.server.failNext = { status: 400, code: 'rejected', msg: '서버가 저장을 거부했습니다.' };
  await st.sync();
  assert.equal(st.state.failed.length, 1);
  assert.equal(st.state.outbox.length, 0);
  await st.retryFailed();
  assert.equal(st.state.failed.length, 0);
  assert.equal(w.server.tables.pt_logs.length, 2);
});

test('폰 시계가 서버와 10분 이상 어긋나면 서버 시각을 기준으로', async () => {
  const w = world('2026-10-20T09:00:00+09:00', { skew: 3 * 3600 * 1000 }); // 폰이 3시간 빠름
  const st = await loggedIn(w);
  assert.equal(st.nowIso(), new Date(w.T).toISOString());
  const w2 = world('2026-10-20T09:00:00+09:00', { skew: 5 * 60 * 1000 }); // 5분 어긋남은 폰 시계 유지
  const st2 = await loggedIn(w2);
  assert.equal(st2.now(), w2.T + 5 * 60 * 1000);
  // 서버는 미래 시각을 지금으로 고쳐 저장
  const { app } = await st.addApp({ name: 'A', total: 1 });
  const rows = await w.adapter.data.upsert('pt_logs', [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', app_id: app.id, log_date: '2026-10-20', total: 5, recorded_at: new Date(w.T + 3 * 3600000).toISOString(), deleted_at: null }]).catch((e) => e);
  assert.ok(rows instanceof ApiError); // 같은 날짜 중복이므로 거부
});

test('날짜 경계: 한국 새벽(세계표준시 전날)에 기록해도 한국 날짜로 저장', async () => {
  const w = world('2026-10-21T00:10:00+09:00'); // 세계표준시 10/20 15:10
  const st = await loggedIn(w);
  const { log } = await st.addApp({ name: 'A', total: 10 });
  assert.equal(log.log_date, '2026-10-21');
  w.set('2026-10-20T23:59:30+09:00');
  const st2 = createStore({ adapter: w.adapter, clock: w.clock });
  assert.equal(st2.today(), '2026-10-20');
});

test('이름: 같은 이름 거절, 이름 바꾸기, 앱 목록 순서', async () => {
  const w = world();
  const st = await loggedIn(w);
  const a = (await st.addApp({ name: ' 캐시워크 ', total: 1 })).app;
  assert.equal(a.name, '캐시워크');
  await assert.rejects(() => st.addApp({ name: '캐시워크', total: 2 }), SaveError);
  await assert.rejects(() => st.addApp({ name: '  ', total: 2 }), SaveError);
  await st.renameApp(a.id, '손목닥터');
  assert.equal(st.activeApps()[0].name, '손목닥터');
});

/* ------------------------- 로그인 · 계정 ------------------------- */

test('첫 입력이 곧 설정: 미설정 칸은 한 번만, 동시에 두 번 눌러도 먼저 온 것만 인정', async () => {
  const w = world();
  const s = w.server;
  const res = await Promise.allSettled([s.fnSetup(1, 'first-pw'), s.fnSetup(1, 'second-pw')]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(res.find((r) => r.status === 'rejected').reason.code, 'already_set');
  await assert.rejects(() => s.fnSetup(1, 'third-pw'), (e) => e.code === 'already_set');
  assert.equal((await s.fnLogin(1, 'first-pw')).slot, 1);
  await assert.rejects(() => s.fnLogin(1, 'second-pw'), (e) => e.code === 'wrong');
});

test('비밀번호 규칙: 4자 이상 아무 글자, 흔한 값 거절', async () => {
  const w = world();
  for (const bad of ['123', '1234', '111111', 'aaaa', '0000']) await assert.rejects(() => w.server.fnSetup(1, bad), (e) => e.code === 'weak');
  assert.ok((await w.server.fnSetup(1, '한글비번!')).access_token);
});

test('사용자3 「사용 안 함」: 로그인·첫 설정 거부, 열면 설정 가능', async () => {
  const w = world();
  await assert.rejects(() => w.server.fnSetup(3, 'secret33'), (e) => e.code === 'disabled');
  await assert.rejects(() => w.server.fnLogin(3, 'secret33'), (e) => e.code === 'disabled');
  w.server.adminOpen(3);
  assert.equal((await w.server.fnSetup(3, 'secret33')).slot, 3);
});

test('5번 틀리면 15분 잠금 / 잠금 중엔 맞는 비밀번호도 거절 / 칸별로 독립 / 15분 뒤 해제', async () => {
  const w = world();
  const s = w.server;
  await s.fnSetup(1, 'pw-one-1'); await s.fnSetup(2, 'pw-two-2');
  for (let i = 1; i <= 4; i++) {
    await assert.rejects(() => s.fnLogin(1, 'nope'), (e) => e.code === 'wrong' && e.data.remaining === 5 - i);
  }
  await assert.rejects(() => s.fnLogin(1, 'nope'), (e) => e.code === 'locked');
  await assert.rejects(() => s.fnLogin(1, 'pw-one-1'), (e) => e.code === 'locked'); // 맞아도 거절
  assert.equal((await s.fnLogin(2, 'pw-two-2')).slot, 2); // 다른 칸은 정상
  assert.equal(s.fnSlots()[0].locked_until != null, true);
  assert.equal(s.fnSlots()[1].locked_until, null);
  w.advance(14 * 60000);
  await assert.rejects(() => s.fnLogin(1, 'pw-one-1'), (e) => e.code === 'locked');
  w.advance(2 * 60000);
  assert.equal((await s.fnLogin(1, 'pw-one-1')).slot, 1);
  // 반복하면 1시간
  for (let i = 0; i < 5; i++) await s.fnLogin(1, 'x').catch(() => {});
  assert.equal(s.slotsState[1].locked_until - w.T, 15 * 60000); // 성공했으니 단계 초기화 -> 다시 15분
  w.advance(16 * 60000); // 해제된 뒤 또 5번 틀림(그 사이 성공 없음) -> 1시간
  for (let i = 0; i < 5; i++) await s.fnLogin(1, 'x').catch(() => {});
  assert.equal(s.slotsState[1].locked_until - w.T, 60 * 60000);
  w.advance(61 * 60000);
  for (let i = 0; i < 5; i++) await s.fnLogin(1, 'x').catch(() => {});
  assert.equal(s.slotsState[1].locked_until - w.T, 1440 * 60000); // 세 번째부터 하루
});

test('로그인 유지: 앱을 닫았다 열어도 비밀번호 없이 바로, 며칠 뒤에도', async () => {
  const w = world();
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const st = createStore({ adapter: w.adapter, clock: w.clock, storage });
  await st.setup(1, 'pw-one-1');
  const { app } = await st.addApp({ name: 'A', total: 100 });
  // 앱을 닫음 = 새 어댑터·새 store (같은 저장소)
  for (const days of [1, 5, 40]) {
    w.advance(days * DAY);
    const ad2 = createMemoryAdapter(w.server);
    const st2 = createStore({ adapter: ad2, clock: w.clock, storage });
    const ok = await st2.resume();
    assert.equal(ok, true);
    assert.equal(st2.state.phase, 'app');
    assert.equal(st2.state.apps[0].id, app.id);
  }
});

test('유지가 끊겼을 때(서버가 세션을 취소): 마지막 사용자가 미리 선택된 로그인 화면', async () => {
  const w = world();
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const st = createStore({ adapter: w.adapter, clock: w.clock, storage });
  await st.setup(2, 'pw-two-2');
  await st.addApp({ name: 'A', total: 100 });
  w.server.adminReset(2);          // 관리자가 초기화 -> 모든 세션 끊김
  const st2 = createStore({ adapter: createMemoryAdapter(w.server), clock: w.clock, storage });
  assert.equal(await st2.resume(), false);
  assert.equal(st2.state.phase, 'login');
  assert.equal(st2.state.lastSlot, 2);
  assert.equal(st2.state.needReauth, true);
  // 초기화한 칸은 관리자가 열어 줄 때까지 잠겨 있음, 기록은 보존
  assert.equal(w.server.fnSlots()[1].state, 'disabled');
  assert.equal(w.server.tables.pt_apps.length, 1);
  w.server.adminOpen(2);
  await st2.setup(2, 'new-pw-22');
  assert.equal(st2.state.apps.length, 1); // 기록 그대로
});

test('전체 로그아웃: 다른 기기 세션도 끊김 / 비밀번호 바꾸기', async () => {
  const w = world();
  const phoneA = createStore({ adapter: createMemoryAdapter(w.server), clock: w.clock });
  await phoneA.setup(1, 'pw-one-1');
  const phoneB = createStore({ adapter: createMemoryAdapter(w.server), clock: w.clock });
  await phoneB.login(1, 'pw-one-1');
  await phoneA.logoutAllDevices();
  await assert.rejects(() => phoneB.adapter.data.loadAll(), () => true).catch(() => {});
  assert.throws(() => w.server.refreshSession(phoneB.adapter.session.refresh_token), (e) => e.code === 'invalid_session');
  // 비밀번호 바꾸기
  await phoneB.login(1, 'pw-one-1');
  await phoneB.changePassword('pw-one-1', 'pw-one-NEW');
  await assert.rejects(() => w.server.fnLogin(1, 'pw-one-1'), (e) => e.code === 'wrong');
  assert.equal((await w.server.fnLogin(1, 'pw-one-NEW')).slot, 1);
  await assert.rejects(() => phoneB.changePassword('틀린것', 'zzzzzz1'), (e) => e.code === 'wrong');
});

test('접속 시간(1시간)이 지나도 알아서 갱신해서 계속 저장됨', async () => {
  const w = world();
  const st = await loggedIn(w);
  const { app } = await st.addApp({ name: 'A', total: 100 });
  w.advance(3 * 3600000);
  w.advance(DAY);
  await st.saveLog({ appId: app.id, total: 150 });
  assert.equal(w.server.tables.pt_logs.length, 2);
});

/* ------------------------- 사용자 분리 (DESIGN 8절) ------------------------- */

test('분리: 세 사용자가 각자 만든 것은 본인에게만 보임 (모든 조합) + 이력·휴지통·앱 목록', async () => {
  const w = world();
  const stores = [];
  for (const slot of [1, 2, 3]) {
    if (slot === 3) w.server.adminOpen(3);
    const st = createStore({ adapter: createMemoryAdapter(w.server), clock: w.clock });
    await st.setup(slot, `pw-user-${slot}-x`);
    const { app, log } = await st.addApp({ name: `앱${slot}`, total: slot * 1000 });
    await st.addSpend({ appId: app.id, amount: slot, memo: '기타' });
    w.advance(DAY);
    const r = await st.saveLog({ appId: app.id, total: slot * 1000 + 50 });
    await st.removeLog(r.row.id);
    await st.editLog(log.id, { total: slot * 1000 + 1 });
    stores.push({ slot, st, app });
  }
  for (const me of stores) {
    const fresh = createStore({ adapter: createMemoryAdapter(w.server), clock: w.clock });
    await fresh.login(me.slot, `pw-user-${me.slot}-x`);
    assert.deepEqual(fresh.state.apps.map((a) => a.name), [`앱${me.slot}`]);
    assert.equal(fresh.state.logs.every((l) => l.app_id === me.app.id), true);
    assert.equal(fresh.state.spends.every((x) => x.app_id === me.app.id), true);
    // 이력도 본인 것만
    for (const other of stores.filter((o) => o.slot !== me.slot)) {
      const h = await fresh.adapter.data.history('app', other.app.id);
      assert.equal(h.length, 0);
      const h2 = await fresh.adapter.data.history('log', other.st.state.logs[0].id);
      assert.equal(h2.length, 0);
    }
    assert.equal(fresh.trashItems().every((t) => t.row.app_id === me.app.id || t.row.id === me.app.id), true);
  }
});

test('분리: 서버 직접 호출 — 읽기 0행 / 남의 user_id로 쓰기 거부 / 남의 행 수정·삭제·복원 거부 / 로그인 없이 거부', async () => {
  const w = world();
  const sv = w.server;
  const ses = {};
  for (const slot of [1, 2]) {
    const st = createStore({ adapter: createMemoryAdapter(sv), clock: w.clock });
    await st.setup(slot, `pw-user-${slot}-x`);
    await st.addApp({ name: `앱${slot}`, total: 100 });
    ses[slot] = { access: st.adapter.session.access_token, uid: st.adapter.session.user_id, app: st.state.apps[0], log: st.state.logs[0] };
  }
  const A = ses[1], B = ses[2];
  // 2: 다른 사용자의 user_id 행 읽기 -> 0행
  for (const t of ['pt_apps', 'pt_logs', 'pt_spends', 'pt_history']) {
    assert.equal(sv.select(t, A.access, (r) => r.user_id === B.uid).length, 0);
  }
  // 3: 남의 user_id 를 달아 쓰기 -> 거부
  const mine = { id: 'bbbbbbbb-0000-4000-8000-000000000001', app_id: A.app.id, log_date: '2026-10-19', total: 5, user_id: B.uid };
  assert.throws(() => sv.upsert('pt_logs', A.access, [mine]), (e) => e.code === 'rls');
  assert.throws(() => sv.upsert('pt_apps', A.access, [{ id: 'cccccccc-0000-4000-8000-000000000001', name: 'X', user_id: B.uid }]), (e) => e.code === 'rls');
  // 남의 앱에 내 기록을 붙이기 -> 거부
  assert.throws(() => sv.upsert('pt_logs', A.access, [{ id: 'bbbbbbbb-0000-4000-8000-000000000002', app_id: B.app.id, log_date: '2026-10-19', total: 5 }]), (e) => e.code === 'fk');
  // 4: 남의 행 수정(같은 id 로 upsert) / 되살리기 / 이전 값 복원 -> 거부
  assert.throws(() => sv.upsert('pt_logs', A.access, [{ ...B.log, total: 999999 }]), (e) => e.code === 'rls');
  assert.throws(() => sv.upsert('pt_logs', A.access, [{ ...B.log, deleted_at: null }]), (e) => e.code === 'rls');
  assert.throws(() => sv.undoCreate('pt_logs', A.access, B.log.id), (e) => e.code === 'rls');
  assert.equal(sv.tables.pt_logs.find((l) => l.id === B.log.id).total, 100); // 그대로
  // 5: 로그인 안 한(공개 키만) 상태
  for (const t of ['pt_apps', 'pt_logs', 'pt_spends', 'pt_history']) assert.throws(() => sv.select(t, 'anon-key'), (e) => e.code === 'no_auth');
  assert.throws(() => sv.upsert('pt_apps', 'anon-key', [{ name: 'x' }]), (e) => e.code === 'no_auth');
  assert.throws(() => sv.history('anon-key', 'log', B.log.id), (e) => e.code === 'no_auth');
  assert.throws(() => sv.purge('anon-key'), (e) => e.code === 'no_auth');
  // 로그인 칸 목록(slots)은 공개지만 상태만 알려 줌
  assert.deepEqual(Object.keys(sv.fnSlots()[0]).sort(), ['locked_until', 'slot', 'state']);
});

test('분리: 초기화는 해당 칸만 — 다른 칸의 비밀번호·기록·세션에 영향 0', async () => {
  const w = world();
  const sv = w.server;
  const s1 = createStore({ adapter: createMemoryAdapter(sv), clock: w.clock });
  const s2 = createStore({ adapter: createMemoryAdapter(sv), clock: w.clock });
  await s1.setup(1, 'pw-user-1-x'); await s1.addApp({ name: 'a1', total: 1 });
  await s2.setup(2, 'pw-user-2-x'); await s2.addApp({ name: 'a2', total: 2 });
  sv.adminReset(1);
  // 2는 그대로
  assert.equal((await sv.fnLogin(2, 'pw-user-2-x')).slot, 2);
  await s2.sync();
  assert.equal(s2.state.apps.length, 1);
  await s2.saveLog({ appId: s2.state.apps[0].id, total: 3 }).catch(() => {});
  assert.equal(sv.tables.pt_apps.length, 2);
  // 1은 기록 보존, 로그인 불가
  assert.equal(sv.tables.pt_apps.filter((a) => a.user_id === sv.slotsState[1].user_id).length, 1);
  await assert.rejects(() => sv.fnLogin(1, 'pw-user-1-x'), (e) => e.code === 'disabled');
});

test('분리: 사용자 선택 화면에는 이름·기록이 새지 않는다 (슬롯 번호와 상태뿐)', () => {
  const w = world();
  const dump = JSON.stringify(w.server.fnSlots());
  assert.doesNotMatch(dump, /pw|user_id|email|@/);
});
