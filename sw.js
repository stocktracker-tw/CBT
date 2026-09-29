/* Mindrise 心晴 service worker：快取優先＋背景回填，有新版就挑安全的時機換上。

   開啟時直接吃快取，幾乎零等待；同時在背景向伺服器對一次版本，有新版就寫回
   快取。背景那一次用 cache:"no-cache"：強制跟伺服器對一次 ETag，沒變是 304
   （幾百 bytes），變了才真的把整份抓回來。用預設的 fetch 有機會被瀏覽器的
   HTTP 快取擋下來、根本沒問到伺服器，那就永遠不會更新了。

   以前到這裡就停了——新版要等「下一次開啟」才看得到，而 iPhone 上的 PWA
   常常一開就是好幾天，等於推上線之後使用者要把 app 滑掉重開兩次才吃得到。
   現在頁面載好之後會來問「我這份是不是舊的？」（見 index.html 的 swreg）：
   這裡比對「這次吐給它的那份」和「回填之後快取裡那份」的內容雜湊，不一樣就
   回 changed。要不要換、什麼時候換交給頁面決定——只有它知道使用者是不是
   正在打字。這支還是一律不主動重載任何頁面。 */
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

// 內容雜湊。比的是位元組而不是 ETag：測試伺服器、CDN 不一定給 ETag，
// 而且 ETag 一樣不代表內容一樣的情況也不是沒有。161 KB 算一次只要幾 ms。
function digest(res) {
  return res.arrayBuffer()
    .then((b) => crypto.subtle.digest("SHA-1", b))
    .then((d) => Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join(""))
    .catch(() => null);
}

// served：每個頁面「最近一次導頁吐出去的是哪一版」。導頁當下只留一份回應的
// 複本，雜湊等頁面真的來問才算（servedHash）——載入期間 SW 什麼都不多做。
// 第一版是導頁時就算，實測 DCL 多了 17–24ms。
// 放在記憶體裡就夠了：頁面載好馬上就會來問，這段期間 SW 被 waitUntil 撐著
// 不會被回收；之後的詢問由頁面自己把雜湊帶回來（見 message 那段），
// 不依賴這裡還記得。
const served = {}, inflight = {}, checked = {};
function servedHash(key) {
  const s = served[key];
  if (!s) return Promise.resolve(null);
  if (!s.h) { s.h = digest(s.res); s.res = null; }
  return s.h;
}

// 跟伺服器對一次版本並寫回快取。同一頁同時只跑一趟；15 秒內剛對過就不再問。
function revalidate(key) {
  if (inflight[key]) return inflight[key];
  if (Date.now() - (checked[key] || 0) < 15000) return Promise.resolve();
  const p = fetch(new Request(key, { cache: "no-cache" }))
    .then((r) => (r && r.ok ? caches.open(C).then((c) => c.put(key, r)) : null))
    .catch(() => {})
    .then(() => { checked[key] = Date.now(); delete inflight[key]; });
  inflight[key] = p;
  return p;
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // 外站的東西不插手
  if (e.request.mode === "navigate") {
    const key = pageKey(e.request);
    let fromCache = false;
    const res = caches.match(key).then((hit) => {
      if (hit) { fromCache = true; served[key] = { res: hit.clone(), h: null }; return hit; }
      return fetch(e.request).then((r) => {
        if (r && r.ok) served[key] = { res: r.clone(), h: null };
        return save(key, r);
      }).catch(() => caches.match("index.html"));
    });
    e.respondWith(res);
    // 回應照樣馬上給；回填在背景跑，waitUntil 撐著 SW 直到它做完
    e.waitUntil(res.then(() => (fromCache ? revalidate(key) : null)).catch(() => {}));
    return;
  }
  const req = e.request;
  e.respondWith(caches.match(req).then((hit) => {
    if (hit) {
      fetch(new Request(req, { cache: "no-cache" })).then((r) => save(req, r)).catch(() => {});
      return hit;
    }
    return fetch(req).then((r) => save(req, r)).catch(() => Response.error());
  }));
});

// 頁面來問「我這份是不是舊的？」。
// 頁面帶得出自己的雜湊（第二次以後問）就用它；第一次問還不知道，用這裡記的
// served。回覆裡把雜湊交給頁面保管，之後 SW 就算被回收重啟也比對得了。
// 兩邊有一邊不知道就一律回「沒變」——寧可晚一點換，也不要誤判把人踢掉。
self.addEventListener("message", (e) => {
  const d = e.data || {};
  const port = e.ports && e.ports[0];
  if (d.mr !== "check" || !port || !d.url) return;
  const key = pageKey({ url: d.url });
  const was = d.served ? Promise.resolve(d.served) : servedHash(key);
  e.waitUntil(Promise.all([was, revalidate(key)])
    .then((z) => caches.match(key).then((now) => (now ? digest(now) : null)).then((cur) => {
      port.postMessage({ served: z[0], changed: !!(z[0] && cur && z[0] !== cur) });
    }))
    .catch(() => { try { port.postMessage({ changed: false }); } catch (err) {} }));
});
