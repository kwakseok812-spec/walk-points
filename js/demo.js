// demo.js - 서버가 없을 때 화면을 눌러 볼 수 있는 시험용 가짜 서버 (주소 끝에 ?mock=1)
// 여기에 있는 이름·숫자는 모두 가짜이며 어디에도 저장되지 않습니다.
import { MemoryServer, createMemoryAdapter, uuid } from './data.js';
import * as C from './calc.js';

export const DEMO_PASSWORD = 'demo1234';

/** 사용자1은 이미 비밀번호가 있고(demo1234) 앱 5개가 있음, 사용자2는 처음 사용, 사용자3은 사용 안 함 */
export async function makeDemo({ now = () => Date.now(), populate = true } = {}) {
  const server = new MemoryServer({ now });
  const adapter = createMemoryAdapter(server);
  if (populate) {
    const s = await server.fnSetup(1, DEMO_PASSWORD);
    const uid = s.user_id;
    const today = C.kstDate(now());
    const iso = (d, hh = 8) => new Date(`${d}T${String(hh).padStart(2, '0')}:00:00+09:00`).toISOString();
    const apps = [
      ['캐시워크', 18420, [-6, -5, -4, -3, -2, -1], [210, 180, 320, 90, 260, 312]],
      ['손목닥터', 5230, [-6, -4, -2, -1], [120, 150, 100, 80]],
      ['에이헬스', 9980, [-5, -3, -1], [300, 250, 410]],
      ['토스 만보기', 2410, [-3, -1], [140, 90]],
      ['신한 쏠 야보', 760, [-1], [50]],
    ];
    let order = 1;
    for (const [name, start, offs, steps] of apps) {
      const app = { id: uuid(), user_id: uid, name, sort: order++, created_at: iso(C.addDays(today, -7)), updated_at: iso(C.addDays(today, -7)), deleted_at: null };
      server.tables.pt_apps.push(app);
      let total = start;
      offs.forEach((o, i) => {
        total += steps[i];
        const d = C.addDays(today, o);
        server.tables.pt_logs.push({ id: uuid(), user_id: uid, app_id: app.id, log_date: d, total, recorded_at: iso(d, 21), created_at: iso(d, 21), updated_at: iso(d, 21), deleted_at: null });
      });
      // 오늘 기록은 앞의 세 앱만 넣어 둠(나머지는 「오늘 아직」)
      if (['캐시워크', '손목닥터'].includes(name)) {
        total += name === '캐시워크' ? 312 : 140;
        const rec = new Date(now() - 3600000).toISOString();
        server.tables.pt_logs.push({ id: uuid(), user_id: uid, app_id: app.id, log_date: today, total, recorded_at: rec, created_at: rec, updated_at: rec, deleted_at: null });
      }
      if (name === '캐시워크') {
        const d = C.addDays(today, -3);
        server.tables.pt_spends.push({ id: uuid(), user_id: uid, app_id: app.id, amount: 5000, memo: '현금 전환', spent_at: iso(d, 22), created_at: iso(d, 22), updated_at: iso(d, 22), deleted_at: null });
        // 지출이 낀 구간의 기록은 지출이 반영된 값이어야 하므로 이후 기록에서 5000 을 뺌
        for (const l of server.tables.pt_logs) if (l.app_id === app.id && l.log_date > d) l.total -= 5000;
      }
    }
    // 휴지통에 지운 기록 하나
    const first = server.tables.pt_apps[2];
    const del = new Date(now() - 5 * 86400000).toISOString();
    server.tables.pt_logs.push({ id: uuid(), user_id: uid, app_id: first.id, log_date: C.addDays(today, -2), total: 123, recorded_at: iso(C.addDays(today, -2), 20), created_at: del, updated_at: del, deleted_at: del });
  }
  return { server, adapter };
}
