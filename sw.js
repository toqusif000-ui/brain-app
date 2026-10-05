// Сервис-воркер: держит в запасе только оболочку приложения, чтобы оно открывалось без сети.
// Сначала сеть (так обновления приходят сами); запас — если сети нет или она молчит дольше трёх секунд.
// Ответы GitHub API не кэшируются никогда. Уведомлений здесь пока нет (этап 2).
const CACHE = "brain-shell-v2";
const WAIT_MS = 3000;   // дольше сеть не ждём: с зависшей связью иначе вместо приложения пустой экран
const SLOW_MS = 10000;  // сеть не уложилась в срок — столько времени остальные файлы отдаём из запаса сразу
const SHELL = [
  "./", "index.html", "style.css", "config.js", "logic.js", "app.js", "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.location).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()));
});

// Что лежит в запасе по этому адресу (ничего, если запас недоступен).
const stored = (href) => caches.open(CACHE).then((cache) => cache.match(href)).catch(() => undefined);

// Свежий ответ из сети. Удачный кладём в запас; не легло — ответ всё равно свежий, его и отдаём.
async function refresh(href) {
  const fresh = await fetch(href, { cache: "no-cache" });
  if (fresh.ok) {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(href, fresh.clone());
    } catch (err) { /* запас остался прежним */ }
  }
  return fresh;
}

// Страница просит файлы оболочки один за другим. Если ждать сеть по три секунды на каждый, пустой экран
// растянется секунд на двенадцать, поэтому после первого опоздания остальные сразу идут из запаса.
let slowUntil = 0;

// Что отдать странице: свежее, если сеть успела за WAIT_MS; иначе запас; запаса нет — ждём сеть до конца.
async function answer(fresh, href) {
  let timer;
  const wait = Date.now() < slowUntil ? 0 : WAIT_MS;
  const slow = new Promise((resolve) => { timer = setTimeout(resolve, wait); });
  try {
    const first = await Promise.race([fresh, slow]);
    if (first && first.ok) return first;
    if (!first && wait) slowUntil = Date.now() + SLOW_MS;
    return (await stored(href)) || first || (await fresh);
  } catch (err) {
    return (await stored(href)) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  url.hash = "";
  if (!SHELL_URLS.has(url.href)) return;   // всё остальное, включая api.github.com, идёт мимо воркера
  const fresh = refresh(url.href);
  event.waitUntil(fresh.catch(() => {}));  // опоздавший ответ всё равно обновит запас
  event.respondWith(answer(fresh, url.href));
});
