// Сервис-воркер: держит в запасе только оболочку приложения, чтобы оно открывалось без сети.
// Сначала сеть (так обновления приходят сами), запас — если сети нет.
// Ответы GitHub API не кэшируются никогда. Уведомлений здесь пока нет (этап 2).
const CACHE = "brain-shell-v1";
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  url.hash = "";
  if (!SHELL_URLS.has(url.href)) return;   // всё остальное, включая api.github.com, идёт мимо воркера
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(url.href, { cache: "no-cache" });
      if (fresh.ok) {
        await cache.put(url.href, fresh.clone());
        return fresh;
      }
      return (await cache.match(url.href)) || fresh;
    } catch (err) {
      return (await cache.match(url.href)) || Response.error();
    }
  })());
});
