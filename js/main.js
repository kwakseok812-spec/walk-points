// main.js - 시작점. 서버 연결 값이 있으면 실제 서버, 주소에 ?mock=1 이 있으면 시험용 가짜 서버.
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './config.js';
import { createSupabaseAdapter } from './data.js';
import { createStore } from './store.js';
import { createUI } from './ui.js';

const params = new URLSearchParams(location.search);
const root = document.getElementById('app');

async function start() {
  let adapter;
  let demo = null;
  if (params.get('mock') === '1') {
    const { makeDemo, DEMO_PASSWORD } = await import('./demo.js');
    demo = await makeDemo({ populate: params.get('empty') !== '1' });
    adapter = demo.adapter;
    window.__pt_demo = { server: demo.server, password: DEMO_PASSWORD };
    const b = document.createElement('div');
    b.className = 'mock-flag';
    b.textContent = `시험용 화면입니다 · 저장되지 않습니다 · 사용자1 비밀번호 ${DEMO_PASSWORD}`;
    document.body.appendChild(b); document.body.classList.add('has-mock');
  } else if (isConfigured()) {
    adapter = createSupabaseAdapter({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  } else {
    root.innerHTML = '<main class="login"><h1>걷기 포인트</h1><p class="notice warn">아직 서버와 연결되지 않았습니다.<br>(서버 설정 전 상태입니다)</p></main>';
    return;
  }

  const store = createStore({ adapter, storage: demo ? undefined : window.localStorage });
  const view = createUI({ root, store });
  window.__pt = { store, ui: view.ui, adapter };

  if (demo && params.get('auto') === '1') {
    await store.login(1, window.__pt_demo.password);
  } else {
    store.state.phase = 'boot'; view.render();
    const resumed = await store.resume();
    if (!resumed && store.state.needReauth && store.state.lastSlot) view.showLoginFor(store.state.lastSlot);
  }
  view.render();

  // 다시 앞으로 나오거나 인터넷이 돌아오면 올리지 못한 것 올리고 최신으로
  const resync = () => { if (store.state.phase === 'app') store.sync(); };
  window.addEventListener('online', resync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resync(); });
  setInterval(() => { if (store.state.outbox.length && document.visibilityState === 'visible') store.sync(); }, 20000);

  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* 지원 안 함 */ }
  if ('serviceWorker' in navigator && !demo && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

start().catch((e) => {
  console.error(e);
  root.innerHTML = '<main class="login"><h1>걷기 포인트</h1><p class="notice err">화면을 열지 못했습니다. 잠시 뒤에 다시 열어 주세요.</p></main>';
});
