/* Mindrise 心晴 service worker：快取優先＋背景回填。

   開啟時直接吃快取，幾乎零等待；同時在背景向伺服器問一次「有沒有新版」，
   有就寫回快取，下一次開啟就是新版。
   刻意「不」做「抓到新版就重新整理」：這是一支會打字的練習 app，
   半路把頁面換掉等於把使用者正在寫的東西弄不見。晚一次開啟才換版是划算的。

   背景那一次用 cache:"no-cache"：強制跟伺服器對一次 ETag，沒變就是 304
   （幾百 bytes），變了才真的把 161 KB 抓回來。用預設的 fetch 有機會被
   瀏覽器的 HTTP 快取擋下來、根本沒問到伺服器，那就永遠不會更新了。 */
const C = "mindrise-v1";
const ASSETS = ["index.html", "manifest.webmanifest",
                "logo-114.webp", "icon-180.png", "icon-512.jpg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(C).then((c) => Promise.all(ASSETS.map((a) =>
    // 預快取一律走網路（cache:"reload"），免得把瀏覽器 HTTP 快取裡的舊檔
    // 原封不動存進新版快取——版本換了、內容還是舊的，而且之後不會再試。
    fetch(a, { cache: "reload" })
      .then((r) => (r && r.ok ? c.put(a, r) : null))
      .catch(() => {}))))
    .catch(() => {})
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()).catch(() => {}));
});

// 導頁的快取鍵去掉 query/hash：?native=1（原生殼）指的是同一份 HTML，
// 不去掉就每次落空、還會在快取裡多存一份。結尾是 / 的補上 index.html。
function pageKey(req) {
  const u = new URL(req.url);
  u.search = ""; u.hash = "";
  if (u.pathname.slice(-1) === "/") u.pathname += "index.html";
  return u.href;
}

function save(key, r) {
  if (r && r.ok) {
    const cp = r.clone();
    caches.open(C).then((c) => c.put(key, cp)).catch(() => {});
  }
  return r;
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // 外站的東西不插手
  const nav = e.request.mode === "navigate";
  const key = nav ? pageKey(e.request) : e.request;
  e.respondWith(caches.match(key).then((hit) => {
    if (hit) {
      fetch(nav ? new Request(key, { cache: "no-cache" })
                : new Request(e.request, { cache: "no-cache" }))
        .then((r) => save(key, r)).catch(() => {});
      return hit;
    }
    return fetch(e.request).then((r) => save(key, r))
      .catch(() => (nav ? caches.match("index.html") : Response.error()));
  }));
});
