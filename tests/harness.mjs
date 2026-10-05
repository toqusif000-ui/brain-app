// Запускает настоящие app.js и sw.js в Node: вместо страницы, часов, памяти устройства и GitHub — подделки.
// Нужен только там, где поведение не проверить чистой функцией из logic.js. Сам тестов не содержит.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import L from "../logic.js";

const run = (name, context) =>
  vm.runInContext(readFileSync(new URL("../" + name, import.meta.url), "utf8"), context, { filename: name });

// Даёт отработать всем уже готовым продолжениям (цепочкам await) приложения.
export async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

// localStorage или sessionStorage. full = true — место кончилось, запись бросает ошибку.
export class FakeStorage {
  constructor(items = {}) {
    this.items = new Map(Object.entries(items));
    this.full = false;
  }
  getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
  setItem(key, value) {
    if (this.full) throw new Error("QuotaExceededError");
    this.items.set(key, String(value));
  }
  removeItem(key) { this.items.delete(key); }
  keys() { return [...this.items.keys()]; }
  read(key) {
    const raw = this.getItem("brain:" + key);
    return raw == null ? null : JSON.parse(raw);
  }
}

// GitHub: сводка, папка inbox/pending и события для разбора.
// PUT ведёт себя как настоящий Contents API: файла нет — 201, файл с таким именем уже лежит — 422.
export function fakeGitHub(clock, state) {
  const reply = (status, body = "{}") => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null, has: () => false },
    text: async () => body,
  });
  const down = () => { throw new TypeError("Failed to fetch"); };
  const gh = {
    state,               // сводка (объект); null — файла data/state.json нет
    stateStatus: 0,      // не 0 — сводка отвечает этим кодом
    online: true,
    files: new Map(),    // что сейчас лежит в inbox/pending: id → файл сообщения
    accepted: [],        // id каждого принятого PUT, по порядку
    dispatches: 0,
    log: [],
    // Что сделать с ближайшими PUT, по одному на запрос:
    //   "lost" — файл лёг, ответ потерялся; "hang" — файл лёг, ответа нет вовсе;
    //   { status, lands } — ответить этим кодом (lands — файл при этом лёг);
    //   { hold } — дождаться обещания и поступить так, как оно скажет.
    plan: [],

    // Разбор на стороне GitHub: файл убран, в сводке появился ответ.
    process(id, extra = {}) {
      const file = gh.files.get(id);
      gh.files.delete(id);
      clock.now += 1000;
      const at = L.isoAt(clock.now, 180);
      const entry = { id, at, text: file.text || "", reply: "Записал.", ok: true, applied: 1, errors: [], ...extra };
      gh.state = {
        ...gh.state, generated_at: at, inbox_pending: gh.files.size,
        replies: [entry, ...gh.state.replies].slice(0, 10),
      };
    },

    async fetch(url, init = {}) {
      const method = init.method || "GET";
      if (!gh.online) down();
      if (method === "GET" && url.endsWith("/contents/data/state.json")) {
        gh.log.push("GET state");
        if (gh.stateStatus) return reply(gh.stateStatus);
        return gh.state ? reply(200, JSON.stringify(gh.state)) : reply(404);
      }
      if (method === "PUT" && url.includes("/contents/inbox/pending/")) {
        const file = JSON.parse(Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8"));
        gh.log.push("PUT " + file.id);
        let step = gh.plan.shift() || "ok";
        if (step.hold) step = (await step.hold) || "ok";
        if (step.status && !step.lands) return reply(step.status);
        const created = !gh.files.has(file.id);
        if (created) {
          gh.files.set(file.id, file);
          gh.accepted.push(file.id);
        }
        if (step === "lost") down();
        if (step === "hang") return new Promise(() => {});
        if (step.status) return reply(step.status);
        if (!created) return reply(422);
        return reply(201, JSON.stringify({ commit: { committer: { date: new Date(clock.now).toISOString() } } }));
      }
      if (method === "POST" && url.endsWith("/dispatches")) {
        gh.log.push("POST dispatches");
        gh.dispatches++;
        return reply(204, "");
      }
      gh.log.push(method + " repo");
      return reply(200);
    },
  };
  return gh;
}

class FakeNode {
  constructor(name) {
    this.name = name;
    this.kids = [];
    this.own = "";
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.classList = { toggle() {} };
    this.hidden = false;
    this.value = "";
    this.className = "";
  }
  get textContent() {
    return [this.own, ...this.kids.map((kid) => (typeof kid === "string" ? kid : kid.textContent))].filter(Boolean).join(" ");
  }
  set textContent(text) {
    this.own = String(text);
    this.kids = [];
  }
  get children() { return this.kids.filter((kid) => typeof kid !== "string"); }
  append(...kids) { this.kids.push(...kids); }
  replaceChildren(...kids) {
    this.own = "";
    this.kids = kids;
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() {}
}

// Открывает приложение. home — установлено на экран «Домой» (display-mode: standalone),
// ios — то же, но признаком служит navigator.standalone; иначе это обычная вкладка браузера.
// Таймеры сами не срабатывают: опрос и набор отметок тест запускает событиями (wake, pagehide).
export function startApp({ clock, gh, local, session, home = false, ios = false }) {
  const nodes = new Map();
  const document = {
    hidden: false,
    listeners: {},
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new FakeNode(id));
      return nodes.get(id);
    },
    createElement: (tag) => new FakeNode(tag),
    addEventListener(type, fn) { (document.listeners[type] ||= []).push(fn); },
  };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() { return clock.now; }
  }
  let timerId = 0;
  let salt = 0;
  const win = {
    document, console, URLSearchParams, TextEncoder, AbortController,
    Date: FakeDate,
    BRAIN_CONFIG: { repo: "owner/brain", utcOffsetMinutes: 180 },
    location: { search: "", hash: "" },
    navigator: ios ? { onLine: true, standalone: true } : { onLine: true },
    localStorage: local,
    sessionStorage: session,
    matchMedia: (query) => ({ matches: home && /display-mode:\s*standalone/.test(query) }),
    crypto: {
      getRandomValues(bytes) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = (salt = (salt + 89) % 256);
        return bytes;
      },
    },
    fetch: (url, init) => gh.fetch(url, init),
    setTimeout: () => ++timerId,
    clearTimeout() {},
    scrollTo() {},
    listeners: {},
    addEventListener(type, fn) { (win.listeners[type] ||= []).push(fn); },
  };
  win.window = win;
  win.self = win;
  vm.createContext(win);
  run("logic.js", win);
  run("app.js", win);

  const el = (id) => document.getElementById(id);
  async function emit(target, type, event = {}) {
    for (const fn of target.listeners[type] || []) fn({ preventDefault() {}, ...event });
    await settle();
  }
  return {
    el,
    text: (id) => el(id).textContent,
    screen: () => (el("setup").hidden ? "app" : "setup"),
    // нажатие на элемент с такими data-атрибутами: { act: "task", id } или { act: "tab", tab }
    click: (dataset) => emit(document, "click", { target: { closest: () => ({ dataset }) } }),
    // «Отправить» во вкладке «Сказать»; без текста — отправить то, что уже в поле
    say(text) {
      if (text !== undefined) el("say").value = text;
      return emit(el("sayForm"), "submit");
    },
    // «Подключить» на экране настройки
    connect(key) {
      el("token").value = key;
      return emit(el("setupForm"), "submit");
    },
    wake: () => emit(win, "online"),        // связь вернулась: читаем сводку и досылаем исходящие
    flushTaps: () => emit(win, "pagehide"), // накопленные отметки уходят одним файлом
  };
}

// Запускает sw.js. cached — что уже лежит в запасе: { адрес: ответ }; fetch — подделка сети.
// Таймеры срабатывают только по fire(), часы идут только через worker.clock.now.
export function startWorker({ fetch, cached = {}, oldCaches = [] }) {
  const base = "https://example.test/brain-app/";
  const handlers = {};
  const timers = [];
  const stores = new Map(oldCaches.map((name) => [name, new Map()]));
  const worker = { putFails: false, timers, base, clock: { now: 1e12 } };
  const context = {
    URL,
    Date: { now: () => worker.clock.now },
    self: {
      location: new URL("sw.js", base),
      addEventListener(type, fn) { handlers[type] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      async open(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
          match: async (key) => store.get(String(key)),
          async put(key, response) {
            if (worker.putFails) throw new Error("QuotaExceededError");
            store.set(String(key), response);
          },
          addAll: async () => {},
        };
      },
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
    },
    fetch: (url, init) => fetch(String(url), init),
    Request: class { constructor(url) { this.url = url; } },
    Response: { error: () => ({ ok: false, status: 0, body: "network error" }) },
    setTimeout(fn, ms, ...args) {
      timers.push({ fn, ms, args, on: true });
      return timers.length;
    },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].on = false; },
  };
  vm.createContext(context);
  run("sw.js", context);

  worker.cacheName = vm.runInContext("CACHE", context);
  stores.set(worker.cacheName, new Map(Object.entries(cached).map(([path, res]) => [new URL(path, base).href, res])));
  worker.cacheNames = () => [...stores.keys()];
  worker.stored = (path) => stores.get(worker.cacheName).get(new URL(path, base).href);
  // Запрос страницы к воркеру. event.response — что воркер пообещал ответить, event.waits — что он доделывает в фоне.
  worker.request = (path) => {
    const event = {
      request: { method: "GET", url: new URL(path, base).href },
      response: null,
      waits: [],
      respondWith(promise) { event.response = Promise.resolve(promise); },
      waitUntil(promise) { event.waits.push(Promise.resolve(promise)); },
    };
    handlers.fetch(event);
    return event;
  };
  worker.activate = async () => {
    const waits = [];
    handlers.activate({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  };
  // Срабатывают все взведённые таймеры (прошло сколько угодно времени).
  worker.fire = async () => {
    for (const timer of timers.filter((t) => t.on)) {
      timer.on = false;
      timer.fn(...timer.args);
    }
    await settle();
  };
  return worker;
}
