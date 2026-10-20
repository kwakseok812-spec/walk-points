// sw.js - 화면 파일을 폰에 저장해 두어 접속이 느리거나 끊겨도 화면이 열리게 합니다.
// 화면 파일을 바꿔 올릴 때는 config.js 의 APP_BUILD 와 아래 CACHE 숫자를 함께 올립니다.
const CACHE = 'pt-shell-v5';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/main.js', './js/config.js', './js/data.js', './js/store.js', './js/ui.js', './js/calc.js',
  './supabase/functions/pt-auth/logic.js',
  './icons/icon-192.png', './icons/favicon-32.png', './icons/apple-touch-180.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 서버(Supabase) 요청은 건드리지 않음
  // 화면 파일: 네트워크 먼저(최신), 안 되면 저장해 둔 것
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
