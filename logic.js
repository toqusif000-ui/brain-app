// Чистые функции приложения: ни DOM, ни сети, ни памяти устройства.
// Грузится обычным скриптом в браузере (window.BrainLogic) и через import/require в Node (тесты).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BrainLogic = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const API = "https://api.github.com";
  const API_VERSION = "2022-11-28";
  const WAIT_MS = 3 * 60 * 1000;             // дольше ответа не ждём: «разберу позже»
  const OVERLAY_MAX_MS = 60 * 60 * 1000;     // свою отметку держим поверх сводки не дольше часа
  const OUTBOX_KEEP_MS = 24 * 60 * 60 * 1000;
  const NEXT = { open: "done", done: "fail", fail: "open" };

  const pad = (n) => String(n).padStart(2, "0");
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

  // ---------- время ----------

  // Смещение в минутах из ISO-строки: "2026-10-05T14:02:11+03:00" → 180.
  function offsetOf(iso, fallback) {
    const s = String(iso || "");
    const m = /T.*([+-])(\d{2}):?(\d{2})$/.exec(s);
    if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    return /T.*Z$/.test(s) ? 0 : fallback;
  }

  // Какой день (ГГГГ-ММ-ДД) идёт в поясе с таким смещением.
  const dateAt = (ms, offsetMin) => new Date(ms + offsetMin * 60000).toISOString().slice(0, 10);

  // ISO 8601 со смещением: 2026-10-05T14:02:11+03:00.
  function isoAt(ms, offsetMin) {
    const a = Math.abs(offsetMin);
    return new Date(ms + offsetMin * 60000).toISOString().slice(0, 19) +
      (offsetMin < 0 ? "-" : "+") + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
  }

  // ---------- подписи дат ----------

  const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

  function parts(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m || m[2] < 1 || m[2] > 12) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  const weekday = (p) => new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();

  // Непонятную дату показываем как есть: лучше странная строка, чем пустое место.
  function fmtDay(iso) {
    const p = parts(iso);
    return p ? `${p.d} ${MONTHS_GEN[p.m - 1]}` : String(iso || "");
  }
  function fmtDayLong(iso) {
    const p = parts(iso);
    return p ? `${WEEKDAYS[weekday(p)]}, ${fmtDay(iso)}` : String(iso || "");
  }
  function fmtDayShort(iso) {
    const p = parts(iso);
    return p ? `${WEEKDAYS_SHORT[weekday(p)]}, ${p.d} ${MONTHS_SHORT[p.m - 1]}` : String(iso || "");
  }
  function fmtRange(from, to) {
    const a = parts(from), b = parts(to);
    if (!a || !b) return [from, to].filter(Boolean).join(" – ");
    return a.y === b.y && a.m === b.m ? `${a.d}–${fmtDay(to)}` : `${fmtDay(from)} – ${fmtDay(to)}`;
  }
  function fmtMonth(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
    return m && MONTHS_NOM[m[2] - 1] ? `${MONTHS_NOM[m[2] - 1]} ${m[1]}` : String(ym || "");
  }
  // Время берём прямо из строки: это время в поясе памяти, а не в поясе устройства.
  function fmtWhen(iso, today) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso || ""));
    if (!m) return "";
    return m[1] === today ? m[2] : `${fmtDay(m[1])}, ${m[2]}`;
  }

  // ---------- входящие ----------

  // Имя и id сообщения: <ГГГГММДДTччммссZ>-<6 hex>, время по UTC.
  function inboxId(ms, hex6) {
    if (!/^[0-9a-f]{6}$/.test(hex6)) throw new Error("нужны 6 шестнадцатеричных знаков");
    return new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z-" + hex6;
  }
  const inboxPath = (id) => `inbox/pending/${id}.json`;
  const cleanText = (s) => String(s || "").replace(/\r\n?/g, "\n").trim();
  const textMessage = (id, sentAt, text) => ({ id, sent_at: sentAt, channel: "phone", type: "text", text });
  const opsMessage = (id, sentAt, ops) => ({ id, sent_at: sentAt, channel: "phone", type: "ops", ops });
  const inboxBody = (file) => JSON.stringify(file, null, 2) + "\n";

  // base64 от UTF-8: btoa ломается на кириллице, поэтому считаем по байтам сами.
  function utf8ToBase64(str) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = new TextEncoder().encode(String(str));
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += A[n >> 18] + A[(n >> 12) & 63] +
        (i + 1 < bytes.length ? A[(n >> 6) & 63] : "=") +
        (i + 2 < bytes.length ? A[n & 63] : "=");
    }
    return out;
  }

  // ---------- запросы к GitHub ----------

  // владелец/имя; «.» и «..» вместо имени не годятся — это уже путь, а не репозиторий
  const validRepo = (repo) => /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(String(repo || ""));

  // Что и куда слать. kind: "state" | "repo" | "put" (arg — файл сообщения) | "dispatch".
  function request(kind, repo, token, arg) {
    if (!validRepo(repo)) throw new Error("неверное имя репозитория");
    const base = `${API}/repos/${repo}`;
    const headers = {
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": API_VERSION,
      Accept: kind === "state" ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    };
    if (kind === "state") return { url: `${base}/contents/data/state.json`, init: { method: "GET", headers, cache: "no-store" } };
    if (kind === "repo") return { url: base, init: { method: "GET", headers, cache: "no-store" } };
    const write = (method, url, payload) => ({
      url,
      init: { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" },
    });
    if (kind === "put") {
      return write("PUT", `${base}/contents/${inboxPath(arg.id)}`,
        { message: "inbox: " + arg.id, content: utf8ToBase64(inboxBody(arg)) });
    }
    if (kind === "dispatch") return write("POST", `${base}/dispatches`, { event_type: "inbox" });
    throw new Error("неизвестный запрос: " + kind);
  }

  // Что значит код ответа. rateLimited — заголовки говорят, что упёрлись в лимит запросов.
  function classify(status, rateLimited) {
    if (status >= 200 && status < 300) return "ok";
    if (status === 401) return "auth";
    if (status === 429 || (status === 403 && rateLimited)) return "rate";
    if (status === 403) return "forbidden";
    if (status === 404) return "notfound";
    if (status === 409 || status === 422) return "conflict";
    return "server";
  }

  function errorText(kind, status) {
    switch (kind) {
      case "auth": return "Ключ не подходит или истёк. Вставь новый ключ.";
      case "forbidden": return "У ключа не хватает прав. Нужен ключ только для репозитория памяти с правом Contents: read and write.";
      case "notfound": return "Репозиторий не найден: в config.js неверное имя или у ключа нет к нему доступа.";
      case "nostate": return "Ключ подходит, но сводки в репозитории пока нет (data/state.json).";
      case "badstate": return "Сводка не читается (data/state.json). Показываю прошлую.";
      case "rate": return "GitHub временно ограничил запросы. Попробую позже.";
      case "offline": return "Нет связи.";
      case "timeout": return "GitHub не ответил вовремя.";
      case "conflict": return "GitHub не принял сообщение.";
      default: return `GitHub ответил ошибкой${status ? " " + status : ""}. Попробую ещё раз.`;
    }
  }

  // Что делать с сообщением, если PUT не прошёл.
  // entry.tried — у прошлой попытки исход неизвестен (связь оборвалась посреди запроса).
  function afterPutError(entry, kind, status) {
    if (kind === "conflict") {
      if (status === 422 && entry.tried) return "delivered";   // файл уже лежит: прошлая попытка дошла
      return entry.renamed ? "later" : "rename";               // один раз пробуем под новым именем
    }
    if (kind === "auth" || kind === "forbidden" || kind === "notfound") return "setup";
    return "later";
  }

  // Очередь: запросы идут строго по одному, сбой одного не останавливает следующие.
  function serialQueue() {
    let tail = Promise.resolve();
    return (job) => {
      const run = tail.then(job, job);
      tail = run.catch(() => {});
      return run;
    };
  }

  // ---------- сводка ----------

  function parseState(raw) {
    let s = raw;
    if (typeof raw === "string") {
      try { s = JSON.parse(raw); } catch (e) { return null; }
    }
    if (!s || typeof s !== "object" || Array.isArray(s) || s.version !== 1) return null;
    const list = (v) => (Array.isArray(v) ? v : []);
    return {
      ...s,
      generated_at: String(s.generated_at || ""),
      today: String(s.today || ""),
      areas: list(s.areas), goals: list(s.goals), tasks: list(s.tasks), days: list(s.days),
      decisions: list(s.decisions), replies: list(s.replies),
      main: s.main || null,
      inbox_pending: Number(s.inbox_pending) || 0,
    };
  }

  // Счёт дня d по правилу из описания: запланировано, сделано, не сделано, перенесено, открыто.
  function dayCounts(tasks, d) {
    const c = { planned: 0, done: 0, fail: 0, moved: 0, open: 0 };
    for (const t of tasks) {
      const days = t.days || [];
      if (!days.includes(d)) continue;
      c.planned++;
      const last = days[days.length - 1];
      if (last > d) c.moved++;
      else if (last === d && c[t.status] !== undefined) c[t.status]++;
    }
    return c;
  }

  // ---------- свои отметки поверх сводки ----------

  const nextStatus = (s) => NEXT[s] || "done";

  // pending: { [id задачи]: { status, batch, stamp, sentAt, again } }
  //   batch  — id файла, в котором отметка ушла (null — ещё копится);
  //   stamp  — время коммита этого файла по часам GitHub; sentAt — то же по часам устройства;
  //   again  — прежняя отметка этой задачи уже ушла файлом и ещё не подтверждена.
  // Нажатие: показываемый статус → следующий. Если вернулись к уже записанному и ничего не уходило — отметки нет.
  function tapTask(pending, id, shown, confirmed) {
    const next = nextStatus(shown);
    const prev = pending[id];
    const again = !!(prev && (prev.batch || prev.again));
    const out = { ...pending };
    if (next === confirmed && !again) delete out[id];
    else out[id] = { status: next, batch: null, stamp: null, sentAt: null, again };
    return out;
  }

  // Всё, что накопилось, — в один набор операций под одним id файла.
  function takeBatch(pending, batchId) {
    const ops = [];
    const out = {};
    for (const [id, c] of Object.entries(pending)) {
      if (c.batch) { out[id] = c; continue; }
      ops.push({ op: "set_status", id, status: c.status });
      out[id] = { ...c, batch: batchId };
    }
    return { ops, pending: out };
  }

  function mapBatch(pending, batchId, change) {
    const out = {};
    for (const [id, c] of Object.entries(pending)) out[id] = c.batch === batchId ? change(c) : c;
    return out;
  }
  const markBatchSent = (pending, batchId, stamp, nowMs) =>
    mapBatch(pending, batchId, (c) => ({ ...c, stamp, sentAt: nowMs }));
  const renameBatch = (pending, oldId, newId) => mapBatch(pending, oldId, (c) => ({ ...c, batch: newId }));
  // Отметки, чей файл потерялся до отправки (приложение закрыли между двумя записями), копим заново.
  function repairPending(pending, outbox) {
    const alive = new Set(outbox.map((e) => e.id));
    const out = {};
    for (const [id, c] of Object.entries(pending)) {
      out[id] = c.batch && c.stamp == null && !alive.has(c.batch) ? { ...c, batch: null } : c;
    }
    return out;
  }

  // Накладывает неподтверждённые отметки на свежую сводку и убирает подтверждённые.
  // Отметка подтверждена, когда сводка собрана позже её коммита и при этом: статус совпал,
  // либо входящие пусты (значит, файл разобран), либо задачи в сводке больше нет.
  function overlayState(state, pending, nowMs) {
    const gen = Date.parse(state.generated_at) || 0;
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    const patch = new Map();
    const left = {};
    for (const [id, c] of Object.entries(pending || {})) {
      const task = byId.get(id);
      if (c.stamp != null) {
        if (gen > c.stamp && (!task || task.status === c.status || state.inbox_pending === 0)) continue;
        if (nowMs - c.sentAt > OVERLAY_MAX_MS) continue;
      }
      left[id] = c;
      if (task && task.status !== c.status) patch.set(id, c.status);
    }
    if (!patch.size) return { state, pending: left };
    const tasks = state.tasks.map((t) => (patch.has(t.id) ? { ...t, status: patch.get(t.id) } : t));
    return { state: { ...state, tasks }, pending: left };
  }

  // ---------- свои сообщения ----------

  // Запись в исходящих: file — то, что ляжет в inbox/pending; state: "queued" → "sent".
  const outboxEntry = (file, nowMs) => ({
    id: file.id, file, state: "queued", tried: false, renamed: false, dispatched: false, pokes: 0,
    sentAt: null, createdAt: nowMs,
  });

  // Что можно забыть: отправленные отметки (дальше они живут в pending), сообщения с пришедшим ответом
  // и очень старые. Неотправленное не трогаем никогда.
  function pruneOutbox(outbox, state, nowMs) {
    const answered = new Set(state ? state.replies.map((r) => r.id) : []);
    return outbox.filter((e) => {
      if (e.state !== "sent" || !e.dispatched) return true;
      if (e.file.type !== "text") return false;
      return !answered.has(e.id) && nowMs - e.sentAt < OUTBOX_KEEP_MS;
    });
  }

  // Ждём ли прямо сейчас ответа (тогда сводку спрашиваем часто).
  function isWaiting(outbox, pending, nowMs) {
    return outbox.some((e) => e.state === "sent" && e.file.type === "text" && nowMs - e.sentAt < WAIT_MS) ||
      Object.values(pending).some((c) => c.stamp != null && nowMs - c.sentAt < WAIT_MS);
  }

  // Лента «Сказать»: свои сообщения без ответа и ответы из сводки, новые сверху.
  // phase: queued — ещё не ушло; working — разбирается; late — ответа нет дольше трёх минут; answered.
  function buildFeed(state, outbox, nowMs) {
    const replies = state ? state.replies : [];
    const answered = new Set(replies.map((r) => r.id));
    const mine = outbox
      .filter((e) => e.file.type === "text" && !answered.has(e.id))
      .map((e) => ({
        id: e.id, at: e.file.sent_at, text: e.file.text, reply: "", ok: true, errors: 0,
        phase: e.state !== "sent" ? "queued" : nowMs - e.sentAt >= WAIT_MS ? "late" : "working",
      }));
    const theirs = replies
      .filter((r) => r.text || r.reply)
      .map((r) => ({
        id: r.id, at: r.at, text: r.text || "", reply: r.reply || "", ok: r.ok !== false,
        errors: Array.isArray(r.errors) ? r.errors.length : 0, phase: "answered",
      }));
    const time = (m) => Date.parse(m.at) || 0;
    return [...mine, ...theirs].sort((a, b) => time(b) - time(a));
  }

  // ---------- экраны ----------

  function titles(state) {
    const area = new Map(), topic = new Map();
    for (const a of state.areas) {
      area.set(a.id, a.title);
      for (const t of a.topics || []) topic.set(t.id, t.title);
    }
    return { area, topic };
  }

  // Сферы в порядке сводки; сферы, которых в списке нет, но на которые кто-то ссылается, — в конце.
  function areaOrder(state, items) {
    const ids = state.areas.map((a) => a.id);
    for (const it of items) if (it.area && !ids.includes(it.area)) ids.push(it.area);
    return ids;
  }

  const row = (t, tt) => ({
    id: t.id, text: t.text, status: t.status, day: t.day || null,
    areaTitle: tt.area.get(t.area) || t.area || "", topic: tt.topic.get(t.topic) || "",
  });

  // «Сегодня»: главная задача, задачи дня по сферам, счётчик, «висят» и «ждут распределения».
  // keepIds — задачи, отмеченные на этом экране: не исчезают из «висят», пока экран открыт,
  // иначе строка уходит из-под пальца и второе нажатие попадает в соседнюю.
  function deriveToday(state, today, keepIds) {
    const keep = new Set(keepIds || []);
    const tt = titles(state);
    const todays = state.tasks.filter((t) => t.day === today);
    // главная задача назначена на день сводки; если сводка вчерашняя, сегодня главной ещё нет
    const main = (state.today === today && state.main && state.tasks.find((t) => t.id === state.main)) || null;
    const groups = [];
    for (const id of areaOrder(state, todays)) {
      const tasks = todays.filter((t) => t.area === id && !(main && t.id === main.id));
      if (!tasks.length) continue;
      groups.push({
        id, title: tt.area.get(id) || id, tasks: tasks.map((t) => row(t, tt)),
        done: tasks.filter((t) => t.status === "done").length, total: tasks.length,
      });
    }
    const stays = (t) => t.status === "open" || keep.has(t.id);
    return {
      date: today,
      main: main ? row(main, tt) : null,
      groups,
      done: todays.filter((t) => t.status === "done").length,
      total: todays.length,
      hanging: state.tasks.filter((t) => t.day && t.day < today && stays(t))
        .sort((a, b) => b.day.localeCompare(a.day)).map((t) => row(t, tt)),
      backlog: state.tasks.filter((t) => !t.day && !t.goal && stays(t)).map((t) => row(t, tt)),
    };
  }

  // «Цели»: сфера → цель → подзадачи. Шкала считается по задачам (с учётом своих отметок).
  function deriveGoals(state) {
    const tt = titles(state);
    return areaOrder(state, state.goals).map((id) => ({
      id, title: tt.area.get(id) || id,
      goals: state.goals.filter((g) => g.area === id)
        .sort((a, b) => (a.status !== "active") - (b.status !== "active") || String(a.to).localeCompare(String(b.to)))
        .map((g) => {
          const subs = state.tasks.filter((t) => t.goal === g.id);
          const total = subs.length || Number(g.total) || 0;
          const done = subs.length ? subs.filter((t) => t.status === "done").length : Number(g.done) || 0;
          return {
            id: g.id, title: g.title, horizon: g.horizon, from: g.from, to: g.to,
            done_when: g.done_when || "", status: g.status, topic: tt.topic.get(g.topic) || "",
            done, total, pct: pct(done, total), tasks: subs.map((t) => row(t, tt)),
          };
        }),
    }));
  }

  // «Обзор»: дни (новые сверху), итоги по месяцам из тех же дней, решения.
  function deriveReview(state) {
    const tt = titles(state);
    const days = [...state.days].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const byMonth = new Map();
    for (const d of days) {
      const key = String(d.date).slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, { month: key, days: 0, planned: 0, done: 0, fail: 0, moved: 0 });
      const m = byMonth.get(key);
      m.days++;
      for (const k of ["planned", "done", "fail", "moved"]) m[k] += Number(d[k]) || 0;
    }
    const decisions = [...state.decisions]
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map((d) => ({
        id: d.id, title: d.title, date: d.date, areaTitle: tt.area.get(d.area) || d.area || "",
        review_on: d.review_on || null, status: d.status,
      }));
    return { days, months: [...byMonth.values()], decisions };
  }

  // ---------- пробный режим ----------

  // Изображает разбор сообщения: отметки меняют задачи и счёт, на текст приходит ответ.
  function mockProcess(state, file, nowMs) {
    const at = isoAt(nowMs, offsetOf(state.generated_at, 180));
    const next = { ...state, generated_at: at, inbox_pending: 0 };
    if (file.type === "ops") {
      const want = new Map();
      for (const op of file.ops || []) if (op.op === "set_status") want.set(op.id, op.status);
      next.tasks = state.tasks.map((t) => (want.has(t.id)
        ? { ...t, status: want.get(t.id), closed_at: want.get(t.id) === "open" ? null : at } : t));
      next.goals = state.goals.map((g) => {
        const subs = next.tasks.filter((t) => t.goal === g.id);
        return { ...g, done: subs.filter((t) => t.status === "done").length, total: subs.length };
      });
      next.days = state.days.map((d) => ({ ...d, ...dayCounts(next.tasks, d.date) }));
    } else {
      next.replies = [...state.replies, {
        id: file.id, at, text: file.text, ok: true, applied: 0, errors: [],
        reply: "Это пробный режим: сообщение никуда не ушло. В настоящем приложении здесь будет ответ — что записано и куда.",
      }].slice(-10);
    }
    return next;
  }

  return {
    WAIT_MS, OVERLAY_MAX_MS, OUTBOX_KEEP_MS, pct,
    offsetOf, dateAt, isoAt,
    fmtDay, fmtDayLong, fmtDayShort, fmtRange, fmtMonth, fmtWhen,
    inboxId, inboxPath, cleanText, textMessage, opsMessage, inboxBody, utf8ToBase64,
    validRepo, request, classify, errorText, afterPutError, serialQueue,
    parseState, dayCounts,
    nextStatus, tapTask, takeBatch, markBatchSent, renameBatch, repairPending, overlayState,
    outboxEntry, pruneOutbox, isWaiting, buildFeed,
    deriveToday, deriveGoals, deriveReview,
    mockProcess,
  };
});
