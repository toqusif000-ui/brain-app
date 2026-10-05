// Экраны, память устройства и связь с GitHub. Все расчёты — в logic.js.
(function () {
  "use strict";

  const L = window.BrainLogic;
  const VERSION = "2026-10-05.2";   // та же строка в logic.js
  try {
    // При медленной сети запас может отдать app.js и logic.js разных версий. Один раз перезагружаемся:
    // к этому времени запас уже обновился целиком.
    if (L.VERSION !== VERSION && !sessionStorage.getItem("brain:reloaded")) {
      sessionStorage.setItem("brain:reloaded", "1");
      location.reload();
      return;
    }
    if (L.VERSION === VERSION) sessionStorage.removeItem("brain:reloaded");
  } catch (e) { /* хранилище недоступно — работаем как есть */ }
  const CFG = window.BRAIN_CONFIG || {};
  const REPO = String(CFG.repo || "");
  const OFFSET = Number.isFinite(CFG.utcOffsetMinutes) ? CFG.utcOffsetMinutes : 180;
  const MOCK = new URLSearchParams(location.search).get("mock") === "1";  // пробный режим: без ключа и без GitHub

  const TAP_MS = 3000;       // отметки копятся и уходят одним файлом
  const FAST_MS = 5000;      // опрос, пока ждём ответа
  const SLOW_MS = 60000;     // опрос в остальное время
  const TIMEOUT_MS = 15000;  // дольше GitHub не ждём, иначе очередь встанет молча
  const TABS = ["today", "goals", "review", "say"];

  const $ = (id) => document.getElementById(id);

  // ---------- память устройства ----------

  // Приложение, установленное на экран «Домой», хранит своё отдельно от браузера — там всё лежит в localStorage.
  // В обычной вкладке localStorage общий со всеми сайтами того же адреса (соседние страницы GitHub Pages),
  // поэтому ключ, исходящие и сводка живут в sessionStorage: только в этой вкладке и до её закрытия.
  const HOME = (() => {
    try {
      return navigator.standalone === true ||
        (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
    } catch (e) {
      return false;
    }
  })();

  // В пробном режиме на устройство ничего не пишется.
  const store = (() => {
    const mem = new Map();
    const disk = () => (HOME ? localStorage : sessionStorage);
    return {
      get(key) {
        if (mem.has(key)) return mem.get(key);
        let value = null;
        if (!MOCK) {
          try { value = JSON.parse(disk().getItem("brain:" + key)); } catch (e) { value = null; }
        }
        mem.set(key, value);
        return value;
      },
      // true — значение легло на устройство; false — оно только в памяти и пропадёт, когда приложение закроют
      set(key, value) {
        mem.set(key, value);
        if (MOCK) return true;
        try {
          disk().setItem("brain:" + key, JSON.stringify(value));
          return true;
        } catch (e) {
          return false;
        }
      },
    };
  })();

  const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

  let token = MOCK ? "mock" : String(store.get("token") || "");
  let confirmed = L.parseState(store.get("state"));   // последняя сводка из GitHub (или с прошлого запуска)
  let outbox = (Array.isArray(store.get("outbox")) ? store.get("outbox") : []).filter((e) => e && e.id && e.file);
  let pending = L.repairPending(plain(store.get("pending")), outbox);   // свои отметки, ещё не подтверждённые сводкой
  let screen = "";            // "setup" | "app"
  let tab = "today";
  let loaded = false;         // пришёл ли в этом запуске хоть один ответ о сводке
  let refreshing = false;
  let flushing = false;
  let checking = false;
  let batchTimer = 0;
  let pollTimer = 0;
  let saved = true;           // легла ли последняя запись исходящих на устройство
  let held = null;            // сообщение, которое не удалось сохранить: его текст пока остаётся в поле
  const keep = new Set();     // задачи, отмеченные на открытом экране: не исчезают из-под пальца
  const fold = { hanging: false, backlog: false };
  const painted = new Map();

  const offset = () => L.offsetOf(confirmed && confirmed.generated_at, OFFSET);
  const todayIso = () => (MOCK && confirmed ? confirmed.today : L.dateAt(Date.now(), offset()));
  const shown = () => (confirmed ? L.overlayState(confirmed, pending, Date.now()).state : null);

  function saveLocal() {
    store.set("pending", pending);
    saved = store.set("outbox", outbox);
    // Текст остаётся в поле, пока сообщение не окажется в надёжном месте: на устройстве или уже в GitHub.
    if (held && (saved || held.state === "sent")) {
      const field = $("say");
      if (L.cleanText(field.value) === held.file.text) {   // если там уже печатают следующее — не трогаем
        field.value = "";
        store.set("draft", "");
      }
      held = null;
    }
  }

  function newId(now) {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    return L.inboxId(now, Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  }

  // ---------- GitHub ----------

  function fail(kind, status) {
    const err = new Error(kind);
    err.kind = kind;
    err.status = status || 0;
    return err;
  }

  // Все запросы идут через одну очередь, строго по одному.
  const queue = L.serialQueue();
  function call(kind, tok, arg) {
    return queue(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const req = L.request(kind, REPO, tok, arg);
        const res = await fetch(req.url, { ...req.init, signal: ctrl.signal });
        const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
        const verdict = L.classify(res.status, limited);
        if (verdict !== "ok") throw fail(verdict, res.status);
        return await res.text();
      } catch (err) {
        if (err.kind) throw err;
        throw fail(ctrl.signal.aborted ? "timeout" : "offline");
      } finally {
        clearTimeout(timer);
      }
    });
  }

  const github = {
    async getState(tok) {
      const state = L.parseState(await call("state", tok));
      if (!state) throw fail("badstate");
      return state;
    },
    getRepo: (tok) => call("repo", tok),
    // возвращает время коммита по часам GitHub (0 — не узнали)
    async put(tok, file) {
      const text = await call("put", tok, file);
      try { return Date.parse(JSON.parse(text).commit.committer.date) || 0; } catch (e) { return 0; }
    },
    dispatch: (tok) => call("dispatch", tok),
  };

  // Пробный режим: сводка из mock/state.json, «разбор» приходит через две секунды.
  function mockApi() {
    let state = null;
    async function load() {
      if (state) return state;
      let text;
      try {
        const res = await fetch("mock/state.json", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        text = await res.text();
      } catch (e) {
        throw fail("offline");
      }
      state = L.parseState(text);
      if (!state) throw fail("badstate");
      return state;
    }
    return {
      getState: load,
      getRepo: async () => "",
      async put(tok, file) {
        await load();
        setTimeout(() => { state = L.mockProcess(state, file, Date.now()); wake(); }, 2000);
        return Date.now();
      },
      dispatch: async () => "",
    };
  }

  const api = MOCK ? mockApi() : github;

  // Читает сводку. Если её нет — выясняет, виден ли сам репозиторий.
  async function probe(tok) {
    try {
      return { kind: "ok", state: await api.getState(tok) };
    } catch (err) {
      if (err.kind !== "notfound") return { kind: err.kind, status: err.status };
      try {
        await api.getRepo(tok);
        return { kind: "nostate" };
      } catch (err2) {
        return { kind: err2.kind, status: err2.status };
      }
    }
  }

  // ---------- сводка и опрос ----------

  function accept(state) {
    confirmed = state;
    store.set("state", state);
    settle();
  }

  // Убирает подтверждённые отметки и сообщения, на которые пришёл ответ.
  function settle() {
    const now = Date.now();
    if (confirmed) pending = L.overlayState(confirmed, pending, now).pending;
    outbox = L.pruneOutbox(outbox, confirmed, now);
    saveLocal();
  }

  function trouble(kind, status) {
    let text = L.errorText(kind, status);
    if ((kind === "offline" || kind === "timeout") && confirmed) text += " Показываю последнюю сводку.";
    if (outbox.some((e) => e.state === "queued")) {
      // обещаем только то, что на самом деле так
      text += !saved ? " Сохранить на устройстве не получилось: не закрывай приложение, пока сообщение не уйдёт."
        : HOME ? " Сказанное сохранено на устройстве — отправлю, как только получится."
          : " Сказанное сохранено до закрытия вкладки — отправлю, как только получится.";
    }
    return text;
  }

  async function refresh() {
    if (refreshing || screen !== "app") return;
    refreshing = true;
    const r = await probe(token);
    refreshing = false;
    if (screen !== "app") return;
    loaded = true;
    if (r.kind === "ok") {
      accept(r.state);
      setBanner("");
    } else if (r.kind === "auth" || r.kind === "forbidden" || r.kind === "notfound") {
      toSetup(L.errorText(r.kind, r.status));
      return;
    } else {
      setBanner(trouble(r.kind, r.status), true);
    }
    render();
  }

  // Каждые 5 секунд, пока ждём ответа; иначе раз в минуту. В фоне не опрашиваем.
  function schedule() {
    clearTimeout(pollTimer);
    if (document.hidden || screen !== "app") return;
    pollTimer = setTimeout(wake, L.isWaiting(outbox, pending, Date.now()) ? FAST_MS : SLOW_MS);
  }

  async function wake() {
    clearTimeout(pollTimer);
    await refresh();
    await flushOutbox();   // в конце сам назначит следующий опрос
  }

  // ---------- отправка ----------

  // Исходящие уходят по порядку: PUT файла, потом событие для разбора. На первом сбое останавливаемся —
  // всё остаётся на устройстве и уйдёт при следующей попытке.
  async function flushOutbox() {
    if (flushing || screen !== "app") return;
    flushing = true;
    const poked = new Set();
    try {
      while (screen === "app") {
        const e = outbox.find((x) => x.state === "queued" || (!x.dispatched && !poked.has(x)));
        if (!e) break;
        if (e.state === "queued" && !(await deliver(e))) break;
        if (e.state === "sent" && !e.dispatched) {
          poked.add(e);
          await poke(e);
        }
      }
    } finally {
      flushing = false;
    }
    settle();
    render();
    schedule();
  }

  // Не вышло: либо ключ больше не подходит (тогда на настройку), либо говорим, что случилось, и ждём.
  function halt(kind, status) {
    if (kind === "auth" || kind === "forbidden" || kind === "notfound") toSetup(L.errorText(kind, status));
    else setBanner(trouble(kind, status), true);
  }

  async function deliver(e) {
    for (;;) {
      // У прошлой попытки исход неизвестен: файл мог лечь, и его могли уже разобрать и убрать. Тогда
      // повторный PUT записал бы сообщение второй раз. Поэтому сначала свежая сводка: есть в ней ответ
      // с этим id — сообщение дошло. (У отметок ответов не бывает, а их повтор ничего не меняет.)
      if (e.tried && e.file.type === "text") {
        const r = await probe(token);
        if (screen !== "app") return false;
        if (r.kind === "ok") {
          accept(r.state);
          const reply = L.replyTo(r.state, e.id);
          if (reply) {
            markSent(e, 0);
            e.dispatched = reply.ok !== false;   // разбор не удался — файл ещё во входящих, позовём разбор снова
            saveLocal();
            return true;
          }
        } else if (["auth", "forbidden", "notfound", "offline", "timeout"].includes(r.kind)) {
          halt(r.kind, r.status);                // ключ не подходит или связи нет: отправлять сейчас бессмысленно
          return false;
        }
        // Сводки нет или она не читается по другой причине — отправляем: сообщение с тем же id
        // ядро второй раз не применит.
      }
      const was = { tried: e.tried, renamed: e.renamed };
      e.tried = true;   // если приложение закроют посреди запроса, исход останется неизвестным
      saveLocal();
      try {
        markSent(e, await api.put(token, e.file));
        return true;
      } catch (err) {
        // связь оборвалась, время вышло или сервер ответил ошибкой — файл мог лечь; в остальных случаях точно нет
        if (err.kind !== "offline" && err.kind !== "timeout" && err.kind !== "server") e.tried = was.tried;
        const act = L.afterPutError(was, err.kind, err.status);
        // 409: GitHub в этот миг принимал другой коммит и наш файл не записал. Пробуем снова сразу,
        // под тем же именем, до трёх раз; не вышло — сообщение ждёт следующего опроса.
        if (act === "later" && err.status === 409 && (e.conflicts = (e.conflicts || 0) + 1) <= 3) continue;
        if (act === "delivered") {
          markSent(e, 0);
          return true;
        }
        if (act === "rename") {
          const id = newId(Date.now());
          if (e.file.type === "ops") pending = L.renameBatch(pending, e.id, id);
          Object.assign(e, { id, file: { ...e.file, id }, renamed: true, tried: false });
          continue;
        }
        saveLocal();
        halt(err.kind, err.status);
        return false;
      }
    }
  }

  function markSent(e, stamp) {
    const now = Date.now();
    Object.assign(e, { state: "sent", sentAt: now, tried: false });
    if (e.file.type === "ops") pending = L.markBatchSent(pending, e.id, stamp || now, now);
    saveLocal();
  }

  // Событие для разбора. Не дошло с трёх раз — не страшно: файл уже в памяти, разбор подхватит его по расписанию.
  async function poke(e) {
    try {
      await api.dispatch(token);
      e.dispatched = true;
    } catch (err) {
      e.pokes = (e.pokes || 0) + 1;
      if (e.pokes >= 3) e.dispatched = true;
      if (err.kind === "auth") toSetup(L.errorText("auth"));
    }
    saveLocal();
  }

  function sendText() {
    const field = $("say");
    const text = L.cleanText(field.value);
    if (!text) {
      field.focus();
      return;
    }
    // Этот текст уже стоит в исходящих и остался в поле только потому, что его не удалось сохранить
    // на устройстве: второе нажатие «Отправить» не должно создать второе сообщение.
    if (held && held.state === "queued" && held.file.text === text) {
      flushOutbox();
      return;
    }
    const now = Date.now();
    held = L.outboxEntry(L.textMessage(newId(now), L.isoAt(now, offset()), text), now);
    outbox.push(held);
    saveLocal();           // сохранилось — поле очистится тут же; нет — когда сообщение уйдёт в GitHub
    flushOutbox();         // в конце сам перерисует
    render();
  }

  function tapTask(id) {
    const view = shown();
    const task = view && view.tasks.find((t) => t.id === id);
    if (!task) return;
    const base = confirmed.tasks.find((t) => t.id === id);
    pending = L.tapTask(pending, id, task.status, base ? base.status : null);
    keep.add(id);
    saveLocal();
    render();
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flushTaps, TAP_MS);
  }

  function flushTaps() {
    clearTimeout(batchTimer);
    const now = Date.now();
    const id = newId(now);
    const batch = L.takeBatch(pending, id);
    if (!batch.ops.length) return;
    pending = batch.pending;
    outbox.push(L.outboxEntry(L.opsMessage(id, L.isoAt(now, offset()), batch.ops), now));
    saveLocal();
    flushOutbox();
  }

  // ---------- настройка ----------

  function show(name) {
    screen = name;
    $("setup").hidden = name !== "setup";
    $("app").hidden = name !== "app";
    $("tabs").hidden = name !== "app";
  }

  const setupMsg = (text) => { $("setupMsg").textContent = text; };

  // text — почему вернулись сюда не по своей воле (ключ перестал подходить)
  function toSetup(text) {
    clearTimeout(pollTimer);
    show("setup");
    $("token").value = "";
    $("back").hidden = !token || !!text;
    setupMsg(text || "");
    window.scrollTo(0, 0);
  }

  function toApp() {
    $("token").value = "";   // ключ не остаётся лежать в поле
    setupMsg("");
    show("app");
    render();
    wake();
    flushTaps();             // отметки, которые не успели уйти до закрытия или пока ключ не подходил
  }

  // «Проверить связь» (keepIt = false) и «Подключить» (keepIt = true).
  async function tryKey(keepIt) {
    if (checking) return;
    const typed = $("token").value.replace(/\s+/g, "");
    const tok = typed || token;
    if (!tok) {
      setupMsg("Сначала вставь ключ.");
      $("token").focus();
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(tok)) {
      setupMsg("Это не похоже на ключ: в нём только латинские буквы, цифры и знак подчёркивания.");
      return;
    }
    if (!MOCK && !L.validRepo(REPO)) {
      setupMsg("В config.js неверное имя репозитория памяти.");
      return;
    }
    checking = true;
    setupMsg("Проверяю…");
    const r = await probe(tok);
    checking = false;
    if (screen !== "setup") return;
    if (r.kind !== "ok" && r.kind !== "nostate" && r.kind !== "badstate") {
      setupMsg(L.errorText(r.kind, r.status));
      return;
    }
    if (!keepIt) {
      setupMsg(r.kind === "ok" ? `Связь есть. Сводка от ${L.fmtWhen(r.state.generated_at, "")}.` : L.errorText(r.kind));
      return;
    }
    token = tok;
    store.set("token", tok);
    loaded = true;
    if (r.state) accept(r.state);
    setBanner(r.kind === "ok" ? "" : L.errorText(r.kind), true);
    toApp();
  }

  // ---------- отрисовка ----------

  // Единственный путь текста на страницу: строки становятся текстовыми узлами, HTML нигде не разбирается.
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "data") Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    node.append(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false && kid !== ""));
    return node;
  }

  // Перерисовываем блок, только если изменилось то, что в нём показано:
  // лишняя перерисовка съедает нажатие, если попадает между касанием и отпусканием.
  function paint(id, model, build) {
    const sig = JSON.stringify(model);
    if (painted.get(id) === sig) return;
    painted.set(id, sig);
    $(id).replaceChildren(...[build()].flat(Infinity).filter(Boolean));
  }

  function setBanner(text, warn) {
    const node = $("banner");
    const line = text || (MOCK ? "Пробный режим: данные ненастоящие, ничего никуда не отправляется." : "");
    node.textContent = line;
    node.hidden = !line;
    node.classList.toggle("warn", !!text && !!warn);
  }

  function bar(done, total) {
    const fill = el("i");
    fill.style.width = L.pct(done, total) + "%";
    return el("div", { class: "bar" }, fill);
  }

  const joined = (...bits) => bits.filter(Boolean).join(" · ");
  const STATUS = { open: "открыта", done: "сделана", fail: "не сделана" };

  // Строка задачи. Нажатие: открыта → сделана → не сделана → открыта.
  const taskRow = (t, caption) => el("li", null,
    el("button", { type: "button", class: "task", data: { act: "task", id: t.id, s: t.status } },
      el("span", { class: "box", "aria-hidden": "true" }),
      el("span", { class: "txt" }, el("span", null, t.text), caption ? el("small", null, caption) : null),
      el("span", { class: "sr" }, STATUS[t.status] || "")));

  const groupCard = (g) => el("section", { class: "card" + (g.done === g.total ? " complete" : "") },
    el("div", { class: "card-head" }, el("h2", null, g.title), el("span", { class: "count" }, `${g.done}/${g.total}`)),
    bar(g.done, g.total),
    el("ul", null, g.tasks.map((t) => taskRow(t, t.topic))));

  function foldBlock(name, title, tasks, caption) {
    if (!tasks.length) return null;
    const node = el("details", { class: "fold", open: fold[name] },
      el("summary", null,
        el("span", null, title),
        el("span", { class: "count" }, String(tasks.filter((t) => t.status === "open").length))),
      el("ul", null, tasks.map((t) => taskRow(t, caption(t)))));
    node.addEventListener("toggle", () => { fold[name] = node.open; });
    return node;
  }

  function renderToday(st, today) {
    const vm = L.deriveToday(st, today, [...keep]);
    paint("tab-today", vm, () => [
      el("div", { class: "total" },
        el("div", { class: "total-label" },
          el("span", null, "Сделано за день"), el("span", null, `${vm.done} из ${vm.total}`)),
        bar(vm.done, vm.total)),
      el("section", { class: "card main" },
        el("div", { class: "tag" }, "Главная задача дня"),
        vm.main
          ? el("ul", null, taskRow(vm.main, joined(vm.main.areaTitle, vm.main.topic)))
          : el("p", { class: "empty" }, "Не выбрана. Скажи, какая задача сегодня главная.")),
      vm.groups.length ? el("div", { class: "grid" }, vm.groups.map(groupCard)) : null,
      vm.total ? null : el("p", { class: "empty lone" }, "На сегодня задач нет. Расскажи о планах во вкладке «Сказать»."),
      foldBlock("hanging", "Висят с прошлых дней", vm.hanging, (t) => joined(L.fmtDay(t.day), t.areaTitle, t.topic)),
      foldBlock("backlog", "Ждут распределения", vm.backlog, (t) => joined(t.areaTitle, t.topic)),
    ]);
  }

  const HORIZON = { week: "Цель недели", month: "Цель месяца" };
  const CLOSED = { done: "достигнута", dropped: "снята" };

  function goalCard(g, today) {
    const full = g.status === "done" || (g.total > 0 && g.done === g.total);
    const day = (t) => (!t.day ? "без дня" : t.day === today ? "сегодня" : L.fmtDay(t.day));
    return el("article", { class: "card goal" + (full ? " complete" : "") + (g.status !== "active" ? " closed" : "") },
      el("div", { class: "goal-top" },
        el("div", null,
          el("div", { class: "tag" }, joined(HORIZON[g.horizon] || "Цель", L.fmtRange(g.from, g.to), CLOSED[g.status])),
          el("h2", null, g.title)),
        el("span", { class: "pct" }, g.pct + "%")),
      bar(g.done, g.total),
      el("div", { class: "goal-meta" }, joined(`Подзадач сделано: ${g.done} из ${g.total}`, g.topic)),
      g.done_when ? el("div", { class: "goal-meta" }, "Готово, когда: " + g.done_when) : null,
      g.tasks.length ? el("ul", null, g.tasks.map((t) => taskRow(t, day(t)))) : null);
  }

  function renderGoals(st, today) {
    const vm = L.deriveGoals(st);
    paint("tab-goals", [vm, today], () => (vm.length
      ? vm.map((a) => [
        el("h2", { class: "area" }, a.title),
        a.goals.length ? a.goals.map((g) => goalCard(g, today)) : el("p", { class: "empty lone" }, "Целей пока нет."),
      ])
      : el("p", { class: "empty lone" }, "Сфер пока нет.")));
  }

  const DECISION = { reviewed: "пересмотрено", superseded: "заменено другим" };

  function renderReview(st, today) {
    const vm = L.deriveReview(st);
    const th = (text, label) => el("th", { class: label ? "num" : null, scope: "col", "aria-label": label }, text);
    const num = (v) => el("td", { class: "num" }, String(Number(v) || 0));
    const tile = (n, label) => el("div", { class: "tile" }, el("b", null, String(n)), el("span", null, label));
    paint("tab-review", [vm, today], () => [
      el("section", { class: "panel" },
        el("h2", null, "По дням"),
        vm.days.length ? [
          el("table", null,
            el("thead", null, el("tr", null,
              th("День"), th("План", "Запланировано"), th("✓", "Сделано"), th("✕", "Не сделано"), th("→", "Перенесено"))),
            el("tbody", null, vm.days.map((d) => el("tr", { class: d.date === today ? "now" : null, "aria-current": d.date === today ? "date" : null },
              el("td", null, L.fmtDayShort(d.date)), num(d.planned), num(d.done), num(d.fail), num(d.moved))))),
          el("p", { class: "hint" }, "✓ сделано · ✕ не сделано · → перенесено на другой день"),
        ] : el("p", { class: "empty" }, "Дней пока нет.")),
      el("section", { class: "panel" },
        el("h2", null, "Итоги по месяцу"),
        vm.months.length
          ? vm.months.map((m) => [
            el("h3", null, L.fmtMonth(m.month)),
            el("div", { class: "tiles" },
              tile(m.planned, "запланировано"), tile(m.done, "сделано"), tile(m.fail, "не сделано"), tile(m.moved, "перенесено")),
          ]).concat(vm.monthsFromDays ? [el("p", { class: "hint" }, "Посчитано по дням за последние 30 дней.")] : [])
          : el("p", { class: "empty" }, "Пока нечего считать.")),
      el("section", { class: "panel" },
        el("h2", null, "Решения"),
        vm.decisions.length
          ? el("ul", null, vm.decisions.map((d) => el("li", { class: "decision" },
            el("div", null, d.title),
            el("small", null, joined(L.fmtDay(d.date), d.areaTitle,
              DECISION[d.status] || (d.review_on ? "пересмотр " + L.fmtDay(d.review_on) : "без даты пересмотра"))))))
          : el("p", { class: "empty" }, "Решений пока нет.")),
    ]);
  }

  function renderSay(st, today) {
    const feed = L.buildFeed(st, outbox, Date.now());
    const offline = navigator.onLine === false;
    const WAIT = {
      queued: flushing ? "отправляю…"
        : offline ? "нет связи — отправлю, когда появится" : "пока не отправлено — попробую ещё раз",
      working: "разбираю…",
      late: "сообщение сохранено, разберу позже",
    };
    paint("feed", [feed, today, WAIT.queued], () => (feed.length
      ? feed.map((m) => el("article", { class: "msg" },
        el("div", { class: "msg-top" }, L.fmtWhen(m.at, today)),
        m.text ? el("p", { class: "said" }, m.text) : null,
        m.phase !== "answered" ? el("p", { class: "reply wait" }, WAIT[m.phase]) : null,
        m.phase === "answered" && m.reply ? el("p", { class: "reply" }, m.reply) : null,
        !m.ok ? el("p", { class: "msg-note" }, "Не разобрано. Текст сообщения сохранён.") : null,
        m.ok && m.errors ? el("p", { class: "msg-note" }, "Записалось не всё. Скажи это ещё раз другими словами.") : null))
      : el("p", { class: "empty lone" }, "Здесь появятся твои сообщения и ответы на них.")));
  }

  function render() {
    if (screen !== "app") return;
    const st = shown();
    const today = todayIso();
    const head = {
      today: ["Сегодня", L.fmtDayLong(today)],
      goals: ["Цели", "по сферам"],
      review: ["Обзор", "дни, месяцы, решения"],
      say: ["Сказать", "голосом или текстом"],
    }[tab];
    $("title").textContent = head[0];
    $("sub").textContent = head[1];
    if (tab === "say") renderSay(st, today);
    else if (!st) paint("tab-" + tab, loaded, () => el("p", { class: "empty lone" }, loaded ? "Сводки пока нет." : "Загружаю сводку…"));
    else if (tab === "today") renderToday(st, today);
    else if (tab === "goals") renderGoals(st, today);
    else renderReview(st, today);
    $("foot").textContent = st ? "Сводка от " + L.fmtWhen(st.generated_at, today) : "";
  }

  function setTab(name) {
    if (!TABS.includes(name)) name = "today";
    if (name !== tab) keep.clear();
    tab = name;
    for (const t of TABS) $("tab-" + t).hidden = t !== tab;
    for (const b of $("tabs").children) {
      if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    window.scrollTo(0, 0);
    render();
  }

  // ---------- события ----------

  document.addEventListener("click", (ev) => {
    const node = ev.target.closest("[data-act]");
    if (!node) return;
    const act = node.dataset.act;
    if (act === "task") tapTask(node.dataset.id);
    else if (act === "tab") setTab(node.dataset.tab);
    else if (act === "settings") toSetup("");
    else if (act === "back") toApp();
    else if (act === "check") tryKey(false);
  });
  $("setupForm").addEventListener("submit", (ev) => { ev.preventDefault(); tryKey(true); });
  $("sayForm").addEventListener("submit", (ev) => { ev.preventDefault(); sendText(); });
  $("say").addEventListener("input", () => store.set("draft", $("say").value));   // недописанное переживёт закрытие

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      flushTaps();          // свернули — не ждём трёх секунд
    } else {
      keep.clear();
      wake();
    }
  });
  window.addEventListener("pagehide", flushTaps);
  window.addEventListener("online", wake);
  window.addEventListener("offline", render);

  // ---------- запуск ----------

  $("say").value = String(store.get("draft") || "");
  if (!MOCK && !HOME) $("setupForm").append(el("p", { class: "hint" }, "В обычной вкладке ключ хранится только до её закрытия."));
  setBanner("");
  setTab(location.hash.slice(1));   // #say и т. п. — открыть сразу нужную вкладку
  if (!MOCK && !L.validRepo(REPO)) toSetup("В config.js неверное имя репозитория памяти.");
  else if (!token) toSetup("");
  else toApp();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }
})();
