// Запускает настоящие app.js и sw.js в Node: вместо страницы, часов, памяти устройства и GitHub — подделки.
// Нужен только там, где поведение не проверить чистой функцией из logic.js. Сам тестов не содержит.
import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import L from "../logic.js";

const run = (name, context) =>
  vm.runInContext(readFileSync(new URL("../" + name, import.meta.url), "utf8"), context, { filename: name });

// Настоящий config.js: репозиторий в тестах свой, а ключ напоминаний берём отсюда — тот, с которым приложение живёт.
const realConfig = run("config.js", vm.createContext({ window: {} })) || {};

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

// Что появилось в logic.js вместе с напоминаниями (в прежнем выпуске этого нет).
export const STAGE2 = ["TABS", "PUSH_WAIT_MS", "startTab", "openToday", "base64urlToBytes", "endpointHash",
  "pushInfo", "pushHeal", "pushNotice", "deviceName", "subscribeOp"];
// Что появилось в logic.js вместе с выбором дня во вкладке «Задачи».
export const DAYS = ["DAYS_BACK", "DAYS_AHEAD", "addDays", "dayStrip", "deriveDay", "tabId"];

// Отпечаток подписки, как его считает ядро: первые 16 шестнадцатеричных знаков SHA-256 от адреса.
export const hashOf = (endpoint) => createHash("sha256").update(endpoint, "utf8").digest("hex").slice(0, 16);

export const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

// Уведомления на устройстве: разрешение, подписка в пуш-сервисе, значок на иконке.
//   permission — что сейчас отвечает Notification.permission;
//   answer     — что владелец ответит на вопрос о разрешении;
//   endpoint   — адрес уже существующей подписки ("" — подписки нет).
export function fakePush({ permission = "default", answer = "granted", endpoint = "" } = {}) {
  let made = 0;
  const subscription = (address) => ({
    endpoint: address,
    toJSON: () => ({ endpoint: address, expirationTime: null, keys: { p256dh: "BP" + "k".repeat(85), auth: "a".repeat(22) } }),
    async unsubscribe() {
      push.log.push("unsubscribe");
      push.subscription = null;
      return true;
    },
  });
  const push = {
    permission,
    answer,
    subscription: endpoint ? subscription(endpoint) : null,
    subscribeFails: false,   // true — пуш-сервис подписку не даёт
    log: [],                 // по порядку: "ask" (вопрос о разрешении), "subscribe", "unsubscribe"
    options: [],             // с чем вызывали subscribe
    badges: [],              // что ставили на значок, по порядку (0 — значок убрали)
    listeners: {},           // кто слушает сообщения воркера
    Notification: {
      get permission() { return push.permission; },
      requestPermission() {
        push.log.push("ask");
        return Promise.resolve().then(() => {
          if (push.permission === "default") push.permission = push.answer;
          return push.permission;
        });
      },
    },
    registration: {
      pushManager: {
        getSubscription: async () => push.subscription,
        async subscribe(options) {
          push.log.push("subscribe");
          push.options.push(options);
          if (push.subscribeFails) throw new Error("NotAllowedError");
          if (!push.subscription) push.subscription = subscription("https://web.push.apple.com/Q" + (++made));
          return push.subscription;
        },
      },
    },
  };
  return push;
}

// Открывает приложение. home — установлено на экран «Домой» (display-mode: standalone),
// ios — то же, но признаком служит navigator.standalone; иначе это обычная вкладка браузера.
// push — fakePush(): устройство умеет уведомления (без него их на устройстве нет вовсе).
// search и hash — хвост адреса, с которым приложение открыли (?tab=say, #review).
// oldLogic — запас отдал logic.js прежнего выпуска: "days" — в нём нет выбора дня (выпуск с напоминаниями);
// true — нет и ничего из того, что пришло вместе с напоминаниями (выпуск до них).
// Таймеры сами не срабатывают: опрос и набор отметок тест запускает событиями (wake, pagehide).
export function startApp({
  clock, gh, local, session, home = false, ios = false, push = null, search = "", hash = "", userAgent = IPHONE, oldLogic = false,
}) {
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
  let reloads = 0;
  const win = {
    document, console, URLSearchParams, TextEncoder, AbortController,
    Date: FakeDate,
    BRAIN_CONFIG: { repo: "owner/brain", utcOffsetMinutes: 180, vapidPublicKey: realConfig.vapidPublicKey },
    location: { search, hash, reload() { reloads++; } },
    navigator: ios ? { onLine: true, standalone: true, userAgent } : { onLine: true, userAgent },
    localStorage: local,
    sessionStorage: session,
    matchMedia: (query) => ({ matches: home && /display-mode:\s*standalone/.test(query) }),
    crypto: {
      getRandomValues(bytes) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = (salt = (salt + 89) % 256);
        return bytes;
      },
      // настоящий SHA-256, но без потоков: ответ готов сразу, и settle() его дожидается
      subtle: {
        async digest(name, data) {
          if (name !== "SHA-256") throw new Error("только SHA-256");
          return new Uint8Array(createHash("sha256").update(data).digest()).buffer;
        },
      },
    },
    fetch: (url, init) => gh.fetch(url, init),
    setTimeout: () => ++timerId,
    clearTimeout() {},
    scrollTo() {},
    listeners: {},
    addEventListener(type, fn) { (win.listeners[type] ||= []).push(fn); },
  };
  if (push) {
    win.Notification = push.Notification;
    win.PushManager = function PushManager() {};
    Object.assign(win.navigator, {
      serviceWorker: {
        ready: Promise.resolve(push.registration),
        register: async () => push.registration,
        addEventListener(type, fn) { (push.listeners[type] ||= []).push(fn); },
      },
      async setAppBadge(count) { push.badges.push(count); },
      async clearAppBadge() { push.badges.push(0); },
    });
  }
  win.window = win;
  win.self = win;
  vm.createContext(win);
  run("logic.js", win);
  if (oldLogic) {
    for (const name of oldLogic === "days" ? DAYS : [...STAGE2, ...DAYS]) delete win.BrainLogic[name];
    // прежний выпуск отдавал «Сегодня» без полей isToday и moved
    const derive = win.BrainLogic.deriveToday;
    win.BrainLogic.deriveToday = (...args) => {
      const { isToday, moved, ...vm } = derive(...args);
      return vm;
    };
    win.BrainLogic.VERSION = oldLogic === "days" ? "2026-10-05.3" : "2026-10-05.2";
  }
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
    reloads: () => reloads,   // сколько раз приложение перезагрузило страницу
    // нажатие на элемент с такими data-атрибутами: { act: "task", id } или { act: "tab", tab }
    click: (dataset) => emit(document, "click", { target: { closest: () => ({ dataset }) } }),
    // то же нажатие, но без ожидания: видно, что приложение успело сделать прямо в обработчике
    press(dataset) {
      for (const fn of document.listeners.click || []) fn({ target: { closest: () => ({ dataset }) } });
    },
    // кнопки внутри блока: [{ act, text, disabled }]
    buttons(id) {
      const found = [];
      const walk = (node) => {
        if (typeof node === "string") return;
        if (node.dataset.act) found.push({ act: node.dataset.act, text: node.textContent, disabled: "disabled" in node.attrs });
        node.kids.forEach(walk);
      };
      walk(el(id));
      return found;
    },
    // сами узлы внутри блока с таким data-act (dataset, attrs, textContent, className)
    nodes(id, act) {
      const found = [];
      const walk = (node) => {
        if (typeof node === "string") return;
        if (node.dataset.act === act) found.push(node);
        node.kids.forEach(walk);
      };
      walk(el(id));
      return found;
    },
    // вложенный блок с таким id: его приложение создало само, в разметке страницы его нет
    inner(id, innerId) {
      let found = null;
      const walk = (node) => {
        if (typeof node === "string" || found) return;
        if (node.attrs.id === innerId) found = node;
        else node.kids.forEach(walk);
      };
      walk(el(id));
      return found;
    },
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
    // приложение свернули и снова открыли
    async back() {
      document.hidden = true;
      await emit(document, "visibilitychange");
      document.hidden = false;
      await emit(document, "visibilitychange");
    },
    // сообщение от воркера (нажали на уведомление при открытом приложении)
    swMessage: (data) => emit(push, "message", { data }),
  };
}

// Окно, которое видит воркер. focusFails — вывести его вперёд система не даёт.
export function fakeWindow(url, { focusFails = false } = {}) {
  const win = {
    url,
    focused: 0,
    messages: [],
    async focus() {
      if (focusFails) throw new Error("InvalidAccessError");
      win.focused++;
      return win;
    },
    postMessage(message) { win.messages.push(JSON.parse(JSON.stringify(message))); },
  };
  return win;
}

// Запускает sw.js. cached — что уже лежит в запасе: { адрес: ответ }; fetch — подделка сети.
// Таймеры срабатывают только по fire(), часы идут только через worker.clock.now.
// windows — открытые окна этого же сайта (fakeWindow); badge: false — значков на устройстве нет;
// base — адрес, по которому лежит приложение.
export function startWorker({
  fetch = async () => { throw new TypeError("Failed to fetch"); },
  cached = {}, oldCaches = [], windows = [], badge = true, base = "https://example.test/brain-app/",
}) {
  const handlers = {};
  const timers = [];
  const stores = new Map(oldCaches.map((name) => [name, new Map()]));
  // shown — показанные уведомления: { title, body, icon, data }; badges — что ставили на значок (0 — убрали);
  // opened — адреса, по которым воркер открывал приложение
  const worker = { putFails: false, timers, base, clock: { now: 1e12 }, shown: [], badges: [], opened: [], badgeFails: false };
  const context = {
    URL,
    Date: { now: () => worker.clock.now },
    self: {
      location: new URL("sw.js", base),
      addEventListener(type, fn) { handlers[type] = fn; },
      skipWaiting: async () => {},
      clients: {
        claim: async () => {},
        matchAll: async () => windows,
        async openWindow(url) { worker.opened.push(String(url)); },
      },
      registration: {
        async showNotification(title, options) { worker.shown.push(JSON.parse(JSON.stringify({ title, ...options }))); },
      },
      navigator: badge ? {
        async setAppBadge(count) {
          if (worker.badgeFails) throw new Error("NotAllowedError");
          worker.badges.push(count);
        },
        async clearAppBadge() { worker.badges.push(0); },
      } : {},
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
  // Пуш от сервера. payload: объект (придёт как JSON), строка (как есть), undefined — пуш без данных.
  worker.push = async (payload) => {
    const waits = [];
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    handlers.push({
      data: payload === undefined ? null : { text: () => raw, json: () => JSON.parse(raw) },
      waitUntil: (promise) => waits.push(promise),
    });
    await Promise.all(waits);
  };
  // Нажатие на уведомление с такими данными. Возвращает уведомление: closed — закрыто ли оно.
  worker.click = async (data) => {
    const waits = [];
    const notification = { data, closed: false, close() { notification.closed = true; } };
    handlers.notificationclick({ notification, waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    return notification;
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
