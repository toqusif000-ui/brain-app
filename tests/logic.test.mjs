// Тесты чистых функций и — в конце файла — app.js и sw.js целиком в поддельном окружении (harness.mjs).
// Запуск из папки приложения: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import L from "../logic.js";
import { DAYS, FakeStorage, STAGE2, fakeGitHub, fakePush, fakeWindow, hashOf, settle, startApp, startWorker } from "./harness.mjs";

const fixtureText = readFileSync(new URL("../mock/state.json", import.meta.url), "utf8");
const fixture = () => L.parseState(fixtureText);
const TODAY = "2026-10-05";      // понедельник
const TOMORROW = "2026-10-06";
const FRIDAY = "2026-10-09";
const at = (iso) => Date.parse(iso);
const taskByText = (state, text) => state.tasks.find((t) => t.text === text);

// ---------- время и подписи ----------

test("смещение, дата и время в поясе памяти", () => {
  assert.equal(L.offsetOf("2026-10-05T14:02:11+03:00", 0), 180);
  assert.equal(L.offsetOf("2026-10-05T14:02:11-0530", 0), -330);
  assert.equal(L.offsetOf("2026-10-05T11:02:11Z", 180), 0);
  assert.equal(L.offsetOf("2026-10-05", 180), 180);
  assert.equal(L.offsetOf(null, 180), 180);

  const ms = Date.UTC(2026, 9, 5, 11, 2, 11);
  assert.equal(L.isoAt(ms, 180), "2026-10-05T14:02:11+03:00");
  assert.equal(L.isoAt(ms, 0), "2026-10-05T11:02:11+00:00");
  assert.equal(L.isoAt(ms, -330), "2026-10-05T05:32:11-05:30");
  assert.equal(at(L.isoAt(ms, 180)), ms, "тот же момент времени");

  // 21:30 UTC — в Москве уже следующий день
  assert.equal(L.dateAt(Date.UTC(2026, 9, 5, 21, 30), 180), "2026-10-06");
  assert.equal(L.dateAt(Date.UTC(2026, 9, 5, 20, 59), 180), "2026-10-05");
  assert.equal(L.dateAt(Date.UTC(2026, 11, 31, 22, 0), 180), "2027-01-01");
});

test("подписи дат по-русски", () => {
  assert.equal(L.fmtDay("2026-10-05"), "5 октября");
  assert.equal(L.fmtDayLong("2026-10-05"), "понедельник, 5 октября");
  assert.equal(L.fmtDayShort("2026-10-03"), "сб, 3 окт");
  assert.equal(L.fmtRange("2026-10-05", "2026-10-11"), "5–11 октября");
  assert.equal(L.fmtRange("2026-09-28", "2026-10-04"), "28 сентября – 4 октября");
  assert.equal(L.fmtMonth("2026-10"), "Октябрь 2026");
  assert.equal(L.fmtWhen("2026-10-05T12:17:58+03:00", "2026-10-05"), "12:17");
  assert.equal(L.fmtWhen("2026-10-03T21:05:33+03:00", "2026-10-05"), "3 октября, 21:05");
  assert.equal(L.fmtDay("мусор"), "мусор");
  assert.equal(L.fmtWhen(null, TODAY), "");
  assert.equal(L.pct(1, 3), 33);
  assert.equal(L.pct(0, 0), 0);
});

// ---------- входящие ----------

test("id и имя файла сообщения", () => {
  const ms = Date.UTC(2026, 9, 5, 11, 2, 11, 987);
  const id = L.inboxId(ms, "a1b2c3");
  assert.equal(id, "20261005T110211Z-a1b2c3");
  assert.match(id, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  assert.equal(L.inboxPath(id), "inbox/pending/20261005T110211Z-a1b2c3.json");
  assert.throws(() => L.inboxId(ms, "XYZ"));
  assert.throws(() => L.inboxId(ms, "a1b2c"));
});

test("тело сообщения: текст и нажатия — как в описании", () => {
  const id = "20261005T110211Z-a1b2c3";
  const sent = "2026-10-05T14:02:11+03:00";
  const text = L.textMessage(id, sent, L.cleanText("  сегодня надо\r\nпозвонить «Иванову»  "));
  assert.deepEqual(text, { id, sent_at: sent, channel: "phone", type: "text", text: "сегодня надо\nпозвонить «Иванову»" });
  const ops = L.opsMessage(id, sent, [{ op: "set_status", id: "t-0a1b2c3d", status: "done" }]);
  assert.deepEqual(ops, {
    id, sent_at: sent, channel: "phone", type: "ops",
    ops: [{ op: "set_status", id: "t-0a1b2c3d", status: "done" }],
  });
  const body = L.inboxBody(text);
  assert.ok(body.endsWith("}\n"));
  assert.ok(body.includes("«Иванову»"), "кириллица не превращается в \\u-коды");
  assert.deepEqual(JSON.parse(body), text);
});

test("base64 от UTF-8 совпадает с эталоном", () => {
  const samples = ["", "a", "ab", "abc", "abcd", "Привет, мир!", "ёЁ «кавычки» — тире", "🙂 эмодзи 👍🏽", "строка\nс переносом\tи табом",
    JSON.stringify({ текст: "я".repeat(1000) })];
  for (const s of samples) {
    const got = L.utf8ToBase64(s);
    assert.equal(got, Buffer.from(s, "utf8").toString("base64"));
    assert.equal(Buffer.from(got, "base64").toString("utf8"), s);
  }
});

// ---------- запросы ----------

test("запросы к GitHub: адреса, заголовки, тело", () => {
  const repo = "toqusif000-ui/brain";
  const state = L.request("state", repo, "KEY");
  assert.equal(state.url, "https://api.github.com/repos/toqusif000-ui/brain/contents/data/state.json");
  assert.equal(state.init.method, "GET");
  assert.equal(state.init.cache, "no-store");
  assert.equal(state.init.headers.Accept, "application/vnd.github.raw+json");
  assert.equal(state.init.headers.Authorization, "Bearer KEY");
  assert.equal(state.init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(state.init.body, undefined);

  const file = L.textMessage("20261005T110211Z-a1b2c3", "2026-10-05T14:02:11+03:00", "написал отчёт 🙂");
  const put = L.request("put", repo, "KEY", file);
  assert.equal(put.url, "https://api.github.com/repos/toqusif000-ui/brain/contents/inbox/pending/20261005T110211Z-a1b2c3.json");
  assert.equal(put.init.method, "PUT");
  assert.equal(put.init.headers.Authorization, "Bearer KEY");
  assert.equal(put.init.headers["X-GitHub-Api-Version"], "2022-11-28");
  const payload = JSON.parse(put.init.body);
  assert.deepEqual(Object.keys(payload).sort(), ["content", "message"]);
  assert.deepEqual(JSON.parse(Buffer.from(payload.content, "base64").toString("utf8")), file);
  assert.equal(payload.message, "inbox: 20261005T110211Z-a1b2c3", "в названии коммита только id, без текста сообщения");

  const dispatch = L.request("dispatch", repo, "KEY");
  assert.equal(dispatch.url, "https://api.github.com/repos/toqusif000-ui/brain/dispatches");
  assert.equal(dispatch.init.method, "POST");
  assert.deepEqual(JSON.parse(dispatch.init.body), { event_type: "inbox" });

  assert.equal(L.request("repo", repo, "KEY").url, "https://api.github.com/repos/toqusif000-ui/brain");
  for (const kind of ["state", "repo", "put", "dispatch"]) {
    const req = L.request(kind, repo, "KEY", file);
    assert.ok(req.url.startsWith("https://api.github.com/"), "ключ уходит только в GitHub");
  }
  assert.throws(() => L.request("state", "../evil", "KEY"));
  assert.throws(() => L.request("state", "a/b/c", "KEY"));
  assert.ok(L.validRepo("toqusif000-ui/brain"));
  assert.ok(!L.validRepo("brain"));
  assert.ok(!L.validRepo("a/b?x=1"));
  assert.ok(!L.validRepo("a/.."));
  assert.ok(L.validRepo("user-1/my.repo_2"));
});

test("что значит ответ GitHub", () => {
  assert.equal(L.classify(200), "ok");
  assert.equal(L.classify(201), "ok");
  assert.equal(L.classify(204), "ok");
  assert.equal(L.classify(401), "auth");
  assert.equal(L.classify(403, false), "forbidden");
  assert.equal(L.classify(403, true), "rate");
  assert.equal(L.classify(429, false), "rate");
  assert.equal(L.classify(404), "notfound");
  assert.equal(L.classify(409), "conflict");
  assert.equal(L.classify(422), "conflict");
  assert.equal(L.classify(500), "server");
  assert.equal(L.classify(503, true), "server");
  assert.match(L.errorText("auth"), /Ключ не подходит или истёк/);
  assert.match(L.errorText("notfound"), /не найден/);
  assert.match(L.errorText("server", 502), /502/);
  for (const kind of ["auth", "forbidden", "notfound", "nostate", "badstate", "rate", "offline", "timeout", "conflict", "server"]) {
    assert.match(L.errorText(kind), /[а-яё]/, kind);
  }
});

test("сбой PUT: что делать с сообщением", () => {
  const fresh = { tried: false, renamed: false };
  const tried = { tried: true, renamed: false };
  // 409 — ничего не записано: повторяем позже под тем же именем, иначе файл встанет не на своё место по порядку
  assert.equal(L.afterPutError(fresh, "conflict", 409), "later");
  assert.equal(L.afterPutError(tried, "conflict", 409), "later");
  assert.equal(L.afterPutError({ tried: true, renamed: true }, "conflict", 409), "later");
  // 422 без единой попытки с неизвестным исходом — имя занято чужим файлом: один раз пробуем под новым
  assert.equal(L.afterPutError(fresh, "conflict", 422), "rename");
  assert.equal(L.afterPutError({ tried: false, renamed: true }, "conflict", 422), "later", "новое имя пробуем один раз");
  // прошлая попытка оборвалась, а теперь «файл уже есть» — значит, она дошла; второй раз не шлём и не переименовываем
  assert.equal(L.afterPutError(tried, "conflict", 422), "delivered");
  assert.equal(L.afterPutError({ tried: true, renamed: true }, "conflict", 422), "delivered");
  for (const kind of ["auth", "forbidden", "notfound"]) assert.equal(L.afterPutError(fresh, kind, 0), "setup");
  for (const kind of ["offline", "timeout", "server", "rate"]) assert.equal(L.afterPutError(fresh, kind, 0), "later");
  for (const kind of ["offline", "timeout", "server", "rate"]) assert.equal(L.afterPutError(tried, kind, 0), "later");
});

test("ответ на своё сообщение в сводке", () => {
  const state = fixture();
  assert.equal(L.replyTo(state, state.replies[1].id), state.replies[1]);
  assert.equal(L.replyTo(state, "20261005T110211Z-a1b2c3"), null);
  assert.equal(L.replyTo(null, state.replies[1].id), null, "сводки ещё нет");
});

test("очередь: строго по одному, сбой не останавливает", async () => {
  const queue = L.serialQueue();
  const log = [];
  let running = 0;
  let peak = 0;
  const job = (name, ms, boom) => async () => {
    running++;
    peak = Math.max(peak, running);
    log.push("start " + name);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    log.push("end " + name);
    if (boom) throw new Error(name);
    return name;
  };
  const a = queue(job("a", 20));
  const b = queue(job("b", 1, true));
  const c = queue(job("c", 5));
  assert.equal(await a, "a");
  await assert.rejects(b, /b/);
  assert.equal(await c, "c");
  assert.equal(peak, 1);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

// ---------- сводка ----------

test("разбор сводки", () => {
  assert.equal(L.parseState("не json"), null);
  assert.equal(L.parseState("[]"), null);
  assert.equal(L.parseState(null), null);
  assert.equal(L.parseState('{"version": 2, "tasks": []}'), null, "чужая версия");
  const bare = L.parseState('{"version": 1, "generated_at": "2026-10-05T14:02:11+03:00", "today": "2026-10-05"}');
  assert.deepEqual(bare.tasks, []);
  assert.deepEqual(bare.replies, []);
  assert.equal(bare.main, null);
  assert.equal(bare.inbox_pending, 0);
  assert.equal(fixture().tasks.length, 28);
  assert.deepEqual(L.parseState(fixture()), fixture(), "объект разбирается так же, как строка");
});

test("пример сводки согласован с описанием данных", () => {
  const s = JSON.parse(fixtureText);
  assert.deepEqual(Object.keys(s), ["version", "generated_at", "timezone", "today", "areas", "goals", "tasks",
    "main", "days", "decisions", "replies", "inbox_pending"]);
  assert.equal(s.version, 1);
  assert.equal(s.timezone, "Europe/Moscow");
  assert.equal(s.today, TODAY);
  const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00$/;
  const date = /^\d{4}-\d{2}-\d{2}$/;
  assert.match(s.generated_at, stamp);

  // три сферы с темами: сфер столько, сколько назвала память
  assert.deepEqual(s.areas.map((a) => [a.id, a.title]),
    [["course", "Онлайн-курс"], ["channel", "Канал"], ["personal", "Быт и личное"]]);
  const topics = new Set();
  for (const a of s.areas) {
    assert.deepEqual(Object.keys(a), ["id", "title", "topics"]);
    assert.ok(a.topics.length > 0);
    for (const t of a.topics) {
      assert.match(t.id, /^tp-[0-9a-f]{6}$/);
      topics.add(t.id);
    }
  }
  const areas = new Set(s.areas.map((a) => a.id));

  // задачи
  const ids = new Set();
  for (const t of s.tasks) {
    assert.deepEqual(Object.keys(t), ["id", "text", "area", "topic", "goal", "day", "days", "time", "status", "created_at", "closed_at"]);
    assert.match(t.id, /^t-[0-9a-f]{8}$/);
    assert.ok(!ids.has(t.id), "повтор id " + t.id);
    ids.add(t.id);
    assert.ok(areas.has(t.area));
    assert.ok(t.topic === null || topics.has(t.topic));
    assert.ok(["open", "done", "fail"].includes(t.status));
    assert.equal(t.day, t.days.length ? t.days[t.days.length - 1] : null, "day — последний из days");
    assert.deepEqual([...t.days].sort(), t.days, "дни по порядку");
    for (const d of t.days) assert.match(d, date);
    // время — «ЧЧ:ММ» или null; без дня времени не бывает
    assert.ok(t.time === null || (/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) && t.day !== null), t.text);
    assert.match(t.created_at, stamp);
    if (t.status === "open") assert.equal(t.closed_at, null);
    else assert.match(t.closed_at, stamp);
    // в сводку попадают открытые, подзадачи целей и задачи с днём за последние 14 дней
    assert.ok(t.status === "open" || t.goal || t.days.some((d) => d >= "2026-09-22"), t.text);
  }

  // одна активная недельная цель с тремя подзадачами
  assert.equal(s.goals.length, 1);
  const g = s.goals[0];
  assert.deepEqual(Object.keys(g), ["id", "title", "area", "topic", "horizon", "from", "to", "done_when", "status", "done", "total"]);
  assert.match(g.id, /^g-[0-9a-f]{8}$/);
  assert.equal(g.horizon, "week");
  assert.equal(g.status, "active");
  assert.ok(g.from <= TODAY && TODAY <= g.to);
  const subs = s.tasks.filter((t) => t.goal === g.id);
  assert.equal(subs.length, 3);
  assert.equal(g.total, 3);
  assert.equal(g.done, subs.filter((t) => t.status === "done").length);
  for (const t of s.tasks) assert.ok(t.goal === null || t.goal === g.id);

  // задачи на сегодня в двух сферах, главная — одна из них
  const todays = s.tasks.filter((t) => t.day === TODAY);
  assert.deepEqual(new Set(todays.map((t) => t.area)), new Set(["course", "channel"]));
  assert.ok(todays.some((t) => t.id === s.main));
  // завтра и в пятницу — по три открытые задачи, у одной из трёх время; в третьей сфере — бытовые дела
  for (const day of [TOMORROW, FRIDAY]) {
    const planned = s.tasks.filter((t) => t.day === day);
    assert.deepEqual(planned.map((t) => t.status), ["open", "open", "open"], day);
    assert.equal(planned.filter((t) => t.time).length, 1, day);
  }
  assert.deepEqual(s.tasks.filter((t) => t.time).map((t) => [t.day, t.time, t.text]),
    [[TOMORROW, "11:00", "Созвониться с монтажёром"], [FRIDAY, "15:30", "Стоматолог"]]);
  assert.deepEqual(s.tasks.filter((t) => t.area === "personal").map((t) => t.text),
    ["Забрать посылку на почте", "Купить продукты на неделю", "Стоматолог"]);
  assert.ok(s.tasks.every((t) => !t.day || t.day <= FRIDAY));
  // одна висит с прошлого дня, две ждут распределения
  assert.equal(s.tasks.filter((t) => t.status === "open" && t.day && t.day < TODAY).length, 1);
  assert.equal(s.tasks.filter((t) => t.status === "open" && !t.day && !t.goal).length, 2);

  // дни: сегодня и шесть дней истории, новые сверху, счёт — по правилу из описания
  assert.equal(s.days.length, 7);
  assert.equal(s.days[0].date, TODAY);
  assert.deepEqual(s.days.map((d) => d.date), s.days.map((d) => d.date).sort().reverse());
  for (const d of s.days) {
    assert.deepEqual(Object.keys(d), ["date", "planned", "done", "fail", "moved", "open", "morning", "evening"]);
    const planned = s.tasks.filter((t) => t.days.includes(d.date));
    const last = (t) => t.days[t.days.length - 1];
    assert.equal(d.planned, planned.length, d.date);
    assert.equal(d.done, planned.filter((t) => t.status === "done" && last(t) === d.date).length, d.date);
    assert.equal(d.fail, planned.filter((t) => t.status === "fail" && last(t) === d.date).length, d.date);
    assert.equal(d.moved, planned.filter((t) => last(t) > d.date).length, d.date);
    assert.equal(d.open, planned.filter((t) => t.status === "open" && last(t) === d.date).length, d.date);
    assert.equal(d.planned, d.done + d.fail + d.moved + d.open, d.date);
    assert.equal(typeof d.morning, "boolean");
    assert.equal(typeof d.evening, "boolean");
    assert.deepEqual(L.dayCounts(s.tasks, d.date),
      { planned: d.planned, done: d.done, fail: d.fail, moved: d.moved, open: d.open });
  }
  // каждый день не позже сегодняшнего, на который что-то запланировано, есть в таблице; будущих дней в ней нет
  for (const t of s.tasks) for (const d of t.days) assert.equal(s.days.some((x) => x.date === d), d <= TODAY, d);

  // одно решение, три ответа
  assert.equal(s.decisions.length, 1);
  assert.deepEqual(Object.keys(s.decisions[0]), ["id", "title", "date", "area", "review_on", "status"]);
  assert.match(s.decisions[0].id, /^d-[0-9a-f]{8}$/);
  assert.ok(areas.has(s.decisions[0].area));
  assert.equal(s.replies.length, 3);
  for (const r of s.replies) {
    assert.deepEqual(Object.keys(r), ["id", "at", "text", "reply", "ok", "applied", "errors"]);
    assert.match(r.id, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    assert.match(r.at, stamp);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  }
  assert.equal(s.inbox_pending, 0);
});

// ---------- экраны ----------

test("«Сегодня»: главная, группы по сферам, счётчик, висят, ждут", () => {
  const vm = L.deriveToday(fixture(), TODAY, []);
  assert.equal(vm.date, TODAY);
  assert.equal(vm.main.text, "Записать первый урок");
  assert.equal(vm.main.areaTitle, "Онлайн-курс");
  assert.equal(vm.main.topic, "Уроки");
  assert.equal(vm.done, 2);
  assert.equal(vm.total, 5);
  assert.deepEqual(vm.groups.map((g) => [g.title, g.done, g.total]), [["Онлайн-курс", 1, 2], ["Канал", 1, 2]]);
  const shownIds = vm.groups.flatMap((g) => g.tasks.map((t) => t.id));
  assert.ok(!shownIds.includes(vm.main.id), "главная задача показана один раз — сверху");
  assert.equal(shownIds.length + 1, vm.total);
  assert.deepEqual(vm.groups[1].tasks.map((t) => t.topic), ["Видео", "Рассылка"]);
  assert.deepEqual(vm.hanging.map((t) => [t.text, t.day]), [["Ответить на вопросы под вступительным роликом", "2026-10-02"]]);
  assert.deepEqual(vm.backlog.map((t) => t.text), [
    "Придумать название для второго модуля",
    "Посчитать, сколько времени уходит на монтаж одного ролика",
  ]);
  assert.ok(!vm.backlog.some((t) => t.text.startsWith("Смонтировать и выложить")), "подзадача цели без дня — не «ждёт распределения»");
});

test("«Сегодня» на следующий день со вчерашней сводкой", () => {
  const vm = L.deriveToday(fixture(), "2026-10-06", []);
  assert.equal(vm.main, null, "главная назначалась на вчера");
  assert.equal(vm.total, 3, "то, что вчера стояло на завтра");
  assert.deepEqual(vm.groups.map((g) => [g.title, g.done, g.total]), [["Онлайн-курс", 0, 1], ["Канал", 0, 1], ["Быт и личное", 0, 1]]);
  assert.equal(vm.hanging.length, 4, "вчерашние открытые теперь висят");
  assert.deepEqual(vm.hanging.map((t) => t.day), ["2026-10-05", "2026-10-05", "2026-10-05", "2026-10-02"], "свежие сверху");
  assert.ok(vm.hanging.every((t) => t.status === "open"));
});

test("отмеченная задача не исчезает из «висят», пока экран открыт", () => {
  const state = fixture();
  const hang = taskByText(state, "Ответить на вопросы под вступительным роликом");
  const pending = L.tapTask({}, hang.id, "open", "open");
  const view = L.overlayState(state, pending, 0).state;
  assert.equal(L.deriveToday(view, TODAY, []).hanging.length, 0);
  const kept = L.deriveToday(view, TODAY, [hang.id]).hanging;
  assert.deepEqual(kept.map((t) => [t.id, t.status]), [[hang.id, "done"]]);
});

test("«Цели»: сфера → цель → подзадачи, шкала по задачам", () => {
  const state = fixture();
  const vm = L.deriveGoals(state);
  assert.deepEqual(vm.map((a) => [a.title, a.goals.length]), [["Онлайн-курс", 1], ["Канал", 0], ["Быт и личное", 0]]);
  const g = vm[0].goals[0];
  assert.equal(g.title, "Записать и выложить первый урок");
  assert.deepEqual([g.done, g.total, g.pct], [1, 3, 33]);
  assert.equal(g.topic, "Уроки");
  assert.equal(L.fmtRange(g.from, g.to), "5–11 октября");
  assert.deepEqual(g.tasks.map((t) => [t.status, t.day]), [["done", TODAY], ["open", TODAY], ["open", null]]);

  // своя неподтверждённая отметка сразу двигает шкалу
  const sub = taskByText(state, "Записать первый урок");
  const view = L.overlayState(state, L.tapTask({}, sub.id, "open", "open"), 0).state;
  const g2 = L.deriveGoals(view)[0].goals[0];
  assert.deepEqual([g2.done, g2.total, g2.pct], [2, 3, 67]);

  // закрытые цели — после активных; цель без задач в сводке берёт счёт из самой цели
  const more = { ...state, goals: [
    { id: "g-00000001", title: "Старая", area: "course", topic: null, horizon: "month", from: "2026-09-01", to: "2026-09-30", done_when: null, status: "done", done: 4, total: 4 },
    ...state.goals,
  ] };
  const list = L.deriveGoals(more)[0].goals;
  assert.deepEqual(list.map((x) => x.status), ["active", "done"]);
  assert.deepEqual([list[1].done, list[1].total, list[1].pct], [4, 4, 100]);
});

test("«Обзор»: дни, итоги месяцев, решения", () => {
  const vm = L.deriveReview(fixture());
  assert.equal(vm.days.length, 7);
  assert.deepEqual(vm.days[0], { date: TODAY, planned: 5, done: 2, fail: 0, moved: 0, open: 3, morning: true, evening: false });
  assert.deepEqual(vm.days.map((d) => d.date), [...vm.days.map((d) => d.date)].sort().reverse());
  assert.deepEqual(vm.months, [
    { month: "2026-10", days: 4, planned: 14, done: 7, fail: 1, moved: 2 },
    { month: "2026-09", days: 3, planned: 8, done: 6, fail: 1, moved: 1 },
  ]);
  assert.deepEqual(vm.decisions, [{
    id: "d-5c4b3a29", title: "Уроки делаем короткими — по десять минут", date: "2026-10-01",
    areaTitle: "Онлайн-курс", review_on: "2026-11-01", status: "open",
  }]);
  // порядок дней в сводке не важен
  const shuffled = { ...fixture(), days: [...fixture().days].reverse() };
  assert.deepEqual(L.deriveReview(shuffled).days, vm.days);
});

test("«Обзор»: итоги месяца берутся из сводки, а не складываются из дней", () => {
  // счёт ядра по месяцу: задача, перенесённая внутри месяца, считается один раз, поэтому он не равен сумме дней
  const months = [
    { month: "2026-10", planned: 12, done: 7, fail: 1, moved: 0, open: 4 },
    { month: "2026-09", planned: 7, done: 6, fail: 1, moved: 0, open: 0 },
  ];
  const state = L.parseState({ ...JSON.parse(fixtureText), months });
  assert.deepEqual(L.deriveReview(state).months, [
    { month: "2026-10", planned: 12, done: 7, fail: 1, moved: 0 },
    { month: "2026-09", planned: 7, done: 6, fail: 1, moved: 0 },
  ]);
  // новые сверху, в каком бы порядке ни пришли
  assert.deepEqual(L.deriveReview({ ...state, months: [...months].reverse() }).months.map((m) => m.month), ["2026-10", "2026-09"]);

  // прошлый месяц виден и тогда, когда его дни уже ушли из таблицы за 30 дней
  const november = { ...state, days: [], months: [{ month: "2026-10", planned: 15, done: 12, fail: 2, moved: 1, open: 0 }] };
  assert.deepEqual(L.deriveReview(november).months, [{ month: "2026-10", planned: 15, done: 12, fail: 2, moved: 1 }]);

  // ядро сказало «месяцев нет» — верим ему, а не дням; чисел нет — считаем нулём
  assert.deepEqual(L.deriveReview({ ...state, months: [] }).months, []);
  assert.deepEqual(L.deriveReview({ ...state, months: [{ month: "2026-10" }] }).months,
    [{ month: "2026-10", planned: 0, done: 0, fail: 0, moved: 0 }]);

  // сводка от прежнего ядра, поля months нет — как раньше, сумма по дням
  assert.equal(fixture().months, undefined);
  assert.deepEqual(L.deriveReview(fixture()).months.map((m) => [m.month, m.planned]), [["2026-10", 14], ["2026-09", 8]]);
});

// ---------- «Задачи»: полоса дней и выбранный день ----------

test("день через n дней", () => {
  assert.equal(L.addDays("2026-10-05", 1), "2026-10-06");
  assert.equal(L.addDays("2026-10-05", 0), "2026-10-05");
  assert.equal(L.addDays("2026-10-05", -5), "2026-09-30");
  assert.equal(L.addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(L.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(L.addDays("2028-02-28", 1), "2028-02-29", "високосный год");
  assert.equal(L.addDays("мусор", 1), "");
  assert.equal(L.addDays(null, 1), "");
});

test("полоса дней: от трёх дней назад до двух недель вперёд, подписи и число открытых задач", () => {
  assert.deepEqual([L.DAYS_BACK, L.DAYS_AHEAD], [3, 14]);
  const strip = L.dayStrip(fixture(), TODAY, TODAY);
  assert.deepEqual(Object.keys(strip[0]), ["date", "label", "open", "picked"]);
  assert.equal(strip.length, 18);
  assert.equal(strip[0].date, "2026-10-02");
  assert.equal(strip[3].date, TODAY);
  assert.equal(strip[17].date, "2026-10-19");
  assert.deepEqual(strip.map((c) => c.date), Array.from({ length: 18 }, (_, i) => L.addDays("2026-10-02", i)), "каждый день по разу, по порядку");
  assert.deepEqual(strip.map((c) => c.label), ["пт 2", "сб 3", "Вчера", "Сегодня", "Завтра", "ср 7", "чт 8", "пт 9", "сб 10", "вс 11",
    "пн 12", "вт 13", "ср 14", "чт 15", "пт 16", "сб 17", "вс 18", "пн 19"]);
  // число на дне — его открытые задачи; сделанные, несделанные и перенесённые с него в счёт не идут
  assert.deepEqual(strip.filter((c) => c.open).map((c) => [c.label, c.open]), [["пт 2", 1], ["Сегодня", 3], ["Завтра", 3], ["пт 9", 3]]);
  assert.deepEqual(strip.filter((c) => c.picked).map((c) => c.date), [TODAY]);
  assert.deepEqual(L.dayStrip(fixture(), TODAY, FRIDAY).filter((c) => c.picked).map((c) => c.label), ["пт 9"]);

  // своя неподтверждённая отметка сразу меняет число на дне
  const state = fixture();
  const call = taskByText(state, "Созвониться с монтажёром");
  const view = L.overlayState(state, L.tapTask({}, call.id, "open", "open"), 0).state;
  assert.equal(L.dayStrip(view, TODAY, TODAY).find((c) => c.date === TOMORROW).open, 2);

  // задач нет вовсе — полоса та же, без чисел; «сегодня» непонятно — полосы нет
  const bare = L.dayStrip({ ...state, tasks: [] }, TODAY, TODAY);
  assert.deepEqual(bare.map((c) => [c.date, c.open]), strip.map((c) => [c.date, 0]));
  assert.deepEqual(L.dayStrip(state, "", ""), []);
});

test("полоса дней: в другом месяце и в другом году к подписи добавляется месяц", () => {
  const empty = { ...fixture(), tasks: [] };
  const labels = (today) => L.dayStrip(empty, today, today).map((c) => c.label);
  // 30 октября 2026 — пятница
  assert.deepEqual(labels("2026-10-30"), ["вт 27", "ср 28", "Вчера", "Сегодня", "Завтра", "вс 1 нояб", "пн 2 нояб", "вт 3 нояб",
    "ср 4 нояб", "чт 5 нояб", "пт 6 нояб", "сб 7 нояб", "вс 8 нояб", "пн 9 нояб", "вт 10 нояб", "ср 11 нояб", "чт 12 нояб", "пт 13 нояб"]);
  // назад через границу; «Вчера» и «Завтра» остаются словами и в чужом месяце
  assert.deepEqual(labels("2026-11-02").slice(0, 5), ["пт 30 окт", "сб 31 окт", "Вчера", "Сегодня", "Завтра"]);
  assert.deepEqual(labels("2026-11-01").slice(0, 5), ["чт 29 окт", "пт 30 окт", "Вчера", "Сегодня", "Завтра"]);
  assert.deepEqual(labels("2026-10-31").slice(2, 6), ["Вчера", "Сегодня", "Завтра", "пн 2 нояб"]);
  // через Новый год
  assert.deepEqual(labels("2026-12-30").slice(0, 7), ["вс 27", "пн 28", "Вчера", "Сегодня", "Завтра", "пт 1 янв", "сб 2 янв"]);
  // тот же месяц другого года — тоже с месяцем, иначе «чт 7» читалось бы как ближайший четверг
  const base = fixture().tasks[0];
  const next = { ...empty, tasks: [{ ...base, day: "2027-10-07", days: ["2027-10-07"], status: "open" }] };
  assert.deepEqual(L.dayStrip(next, TODAY, TODAY).slice(-2).map((c) => c.label), ["пн 19", "чт 7 окт"]);
  // все двенадцать месяцев
  const year = { ...empty, tasks: Array.from({ length: 12 }, (_, i) => {
    const day = `2027-${String(i + 1).padStart(2, "0")}-15`;
    return { ...base, id: "t-month" + i, day, days: [day], status: "open" };
  }) };
  assert.deepEqual(L.dayStrip(year, TODAY, TODAY).slice(18).map((c) => c.label.split(" ")[2]),
    ["янв", "февр", "мар", "апр", "мая", "июн", "июл", "авг", "сент", "окт", "нояб", "дек"]);
});

test("полоса дней: более поздний день с задачами встаёт в конец; выбранный день на полосе всегда", () => {
  const state = fixture();
  const on = (n, day, status = "open") => ({ ...state.tasks[0], id: "t-far0000" + n, day, days: [day], status, time: null });
  const more = { ...state, tasks: [...state.tasks,
    on(1, "2026-11-20"), on(2, "2026-12-01", "done"), on(3, "2026-11-20"), on(4, "2026-10-19"), on(5, "2026-09-20"),
    { ...on(6, "скоро"), days: [] }, { ...on(7, null), days: [] }] };
  const strip = L.dayStrip(more, TODAY, TODAY);
  assert.equal(strip.length, 20, "два дальних дня, каждый по разу");
  assert.deepEqual(strip.slice(17).map((c) => [c.date, c.label, c.open]), [
    ["2026-10-19", "пн 19", 1],            // последний день обычной полосы
    ["2026-11-20", "пт 20 нояб", 2],       // дальше — только дни с задачами, по порядку
    ["2026-12-01", "вт 1 дек", 0],         // задача на нём уже сделана: день есть, числа нет
  ]);
  assert.equal(strip[0].date, "2026-10-02", "день раньше полосы на неё не попадает: его открытые задачи видны в «Висят»");
  assert.deepEqual(strip.map((c) => c.date), [...strip.map((c) => c.date)].sort());

  // выбранный дальний день остаётся на полосе, даже когда задач на нём уже нет
  const picked = L.dayStrip(state, TODAY, "2026-11-20");
  assert.equal(picked.length, 19);
  assert.deepEqual(picked[18], { date: "2026-11-20", label: "пт 20 нояб", open: 0, picked: true });
  assert.deepEqual(picked.filter((c) => c.picked).length, 1);
  // непонятный выбор полосу не ломает
  const junk = L.dayStrip(state, TODAY, "мусор");
  assert.equal(junk.length, 18);
  assert.ok(junk.every((c) => !c.picked));
});

test("день «Задач»: сегодня — главная, группы, «висят» и «ждут», как раньше", () => {
  const vm = L.deriveDay(fixture(), TODAY, TODAY, []);
  assert.deepEqual(Object.keys(vm), ["date", "isToday", "main", "groups", "done", "total", "moved", "hanging", "backlog"]);
  assert.deepEqual([vm.date, vm.isToday, vm.done, vm.total], [TODAY, true, 2, 5]);
  assert.equal(vm.main.text, "Записать первый урок");
  assert.deepEqual(vm.groups.map((g) => [g.title, g.done, g.total]), [["Онлайн-курс", 1, 2], ["Канал", 1, 2]]);
  assert.ok(!vm.groups.some((g) => g.tasks.some((t) => t.id === vm.main.id)), "главная показана один раз — сверху");
  assert.deepEqual(vm.hanging.map((t) => t.text), ["Ответить на вопросы под вступительным роликом"]);
  assert.equal(vm.backlog.length, 2);
  assert.deepEqual(vm.moved, [], "перенесённые показываем только на прошедшем дне");
  assert.deepEqual(L.deriveToday(fixture(), TODAY, []), vm, "прежний вопрос «что сегодня» даёт тот же ответ");

  // задача стояла на сегодня и перенесена на завтра: сегодня её в списке нет, а завтра сегодняшний день её покажет
  const state = fixture();
  const button = taskByText(state, "Починить кнопку «Записаться» на сайте");
  const later = { ...state, tasks: state.tasks.map((t) => (t.id === button.id ? { ...t, day: TOMORROW, days: [TODAY, TOMORROW] } : t)) };
  const now = L.deriveDay(later, TODAY, TODAY, []);
  assert.deepEqual([now.total, now.moved.length], [4, 0]);
  assert.deepEqual(L.deriveDay(later, TODAY, TOMORROW, []).moved.map((t) => [t.text, t.day]), [[button.text, TOMORROW]]);
});

test("день «Задач»: будущий день — задачи по сферам, с временем первыми; ничего сегодняшнего", () => {
  const vm = L.deriveDay(fixture(), TOMORROW, TODAY, []);
  assert.deepEqual([vm.date, vm.isToday, vm.main, vm.done, vm.total], [TOMORROW, false, null, 0, 3]);
  assert.deepEqual(vm.groups.map((g) => [g.title, g.done, g.total, g.tasks.map((t) => [t.time, t.text, t.topic, t.status])]), [
    ["Онлайн-курс", 0, 1, [["", "Проверить оплату на сайте курса", "Сайт курса", "open"]]],
    ["Канал", 0, 1, [["11:00", "Созвониться с монтажёром", "Видео", "open"]]],
    ["Быт и личное", 0, 1, [["", "Забрать посылку на почте", "Дом", "open"]]],
  ]);
  assert.deepEqual([vm.moved, vm.hanging, vm.backlog], [[], [], []], "главная, «висят» и «ждут» — только на сегодняшнем дне");

  // пятница: «Стоматолог» в 15:30 стоит в сводке после покупок, а показан первым
  const friday = L.deriveDay(fixture(), FRIDAY, TODAY, []);
  assert.deepEqual(friday.groups.map((g) => [g.title, g.tasks.map((t) => [t.time, t.text])]), [
    ["Канал", [["", "Выложить ролик о том, как устроен курс"]]],
    ["Быт и личное", [["15:30", "Стоматолог"], ["", "Купить продукты на неделю"]]],
  ]);
  assert.deepEqual([friday.done, friday.total], [0, 3]);

  // своя отметка на будущем дне сразу в счёте; id у строки тот же, что у задачи: по нему уходит нажатие
  const state = fixture();
  const call = taskByText(state, "Созвониться с монтажёром");
  const view = L.overlayState(state, L.tapTask({}, call.id, "open", "open"), 0).state;
  const marked = L.deriveDay(view, TOMORROW, TODAY, []);
  assert.deepEqual([marked.done, marked.total, marked.groups[1].done], [1, 3, 1]);
  assert.deepEqual(marked.groups[1].tasks.map((t) => [t.id, t.status]), [[call.id, "done"]]);
});

test("день «Задач»: прошедший день — что на нём осталось и что с него перенесли", () => {
  const vm = L.deriveDay(fixture(), "2026-10-03", TODAY, []);
  assert.deepEqual([vm.isToday, vm.main, vm.done, vm.total], [false, null, 1, 2]);
  assert.deepEqual(vm.groups.map((g) => [g.title, g.tasks.map((t) => [t.text, t.status])]), [
    ["Онлайн-курс", [["Проверить сайт с телефона", "done"]]],
    ["Канал", [["Снять короткий анонс курса", "fail"]]],
  ]);
  assert.deepEqual(vm.moved.map((t) => [t.text, t.day, t.areaTitle, t.topic]),
    [["Смонтировать ролик о том, как устроен курс", TODAY, "Канал", "Видео"]]);
  assert.ok(!vm.groups.some((g) => g.tasks.some((t) => t.id === vm.moved[0].id)), "перенесённая — отдельно и в счёт дня не идёт");
  assert.deepEqual([vm.hanging, vm.backlog], [[], []]);
  // сходится с таблицей «Обзора»: запланировано = осталось на дне + перенесено
  for (const d of fixture().days) {
    const day = L.deriveDay(fixture(), d.date, "2026-10-20", []);
    assert.deepEqual([day.total, day.moved.length, day.done], [d.planned - d.moved, d.moved, d.done], d.date);
  }

  // открытая задача прошедшего дня — в его списке (и нажимается), с него никто ничего не переносил
  const friday = L.deriveDay(fixture(), "2026-10-02", TODAY, []);
  assert.deepEqual([friday.done, friday.total, friday.moved.length], [2, 3, 0]);
  assert.ok(friday.groups[1].tasks.some((t) => t.text === "Ответить на вопросы под вступительным роликом" && t.status === "open"));

  // задачу сняли с дня совсем (дней у неё больше нет): на прежнем дне её не показываем
  const state = fixture();
  const lost = { ...state, tasks: state.tasks.map((t) => (t.day === "2026-10-03" ? { ...t, day: null, days: [] } : t)) };
  assert.deepEqual([L.deriveDay(lost, "2026-10-03", TODAY, []).total, L.deriveDay(lost, "2026-10-03", TODAY, []).moved.length], [0, 1]);
});

test("день «Задач»: пустой день", () => {
  const blank = (date) => ({ date, isToday: false, main: null, groups: [], done: 0, total: 0, moved: [], hanging: [], backlog: [] });
  assert.deepEqual(L.deriveDay(fixture(), "2026-10-07", TODAY, []), blank("2026-10-07"));
  assert.deepEqual(L.deriveDay(fixture(), "2026-10-04", TODAY, []), blank("2026-10-04"), "вчера, на котором ничего не стояло");
  assert.deepEqual(L.deriveDay(fixture(), "2026-11-20", TODAY, []), blank("2026-11-20"));
  // пустой сегодняшний день: групп нет, а «висят» и «ждут» на месте
  const next = L.deriveDay(fixture(), "2026-10-07", "2026-10-07", []);
  assert.deepEqual([next.isToday, next.total, next.groups.length, next.main], [true, 0, 0, null]);
  assert.equal(next.hanging.length, 7);
  assert.equal(next.backlog.length, 2);
});

test("время задачи: с временем — первыми и по времени, остальные в прежнем порядке; не «ЧЧ:ММ» — времени нет", () => {
  const state = fixture();
  const base = taskByText(state, "Забрать посылку на почте");
  const task = (n, time) => ({ ...base, id: "t-0000000" + n, text: "задача " + n, time });
  const { time: gone, ...old } = task(3, null);   // сводка от ядра, которое о времени ещё не знает
  const tasks = [task(1, null), task(2, "18:00"), old, task(4, "09:05"), task(5, "9:30"), task(6, "24:00"),
    task(7, "00:00"), task(8, "12:60"), task(9, ""), task(0, "18:00"), { ...task(1, "15:30:00"), id: "t-0000000a" },
    { ...task(1, 1530), id: "t-0000000b" }, { ...task(1, "23:59"), id: "t-0000000c" }];
  const vm = L.deriveDay({ ...state, tasks }, TOMORROW, TODAY, []);
  assert.equal(vm.groups.length, 1);
  assert.deepEqual(vm.groups[0].tasks.map((t) => [t.time, t.id]), [
    ["00:00", "t-00000007"], ["09:05", "t-00000004"], ["18:00", "t-00000002"], ["18:00", "t-00000000"], ["23:59", "t-0000000c"],
    ["", "t-00000001"], ["", "t-00000003"], ["", "t-00000005"], ["", "t-00000006"], ["", "t-00000008"], ["", "t-00000009"],
    ["", "t-0000000a"], ["", "t-0000000b"],
  ]);

  // у главной задачи время тоже видно
  const main = taskByText(state, "Записать первый урок");
  const timed = { ...state, tasks: state.tasks.map((t) => (t.id === main.id ? { ...t, time: "10:00" } : t)) };
  assert.equal(L.deriveDay(timed, TODAY, TODAY, []).main.time, "10:00");
  assert.equal(L.deriveDay(state, TODAY, TODAY, []).main.time, "");
  // «висят», «ждут», перенесённые и подзадачи во вкладке «Цели» — как раньше, без времени
  const vmToday = L.deriveDay(timed, TODAY, TODAY, []);
  for (const t of [...vmToday.hanging, ...vmToday.backlog, ...L.deriveDay(timed, "2026-10-03", TODAY, []).moved,
    ...L.deriveGoals(timed)[0].goals[0].tasks]) assert.ok(!("time" in t), t.text);
});

test("сфер столько, сколько назвала сводка: одна, три или пять, и ещё та, которой в списке нет", () => {
  const state = fixture();
  const base = taskByText(state, "Забрать посылку на почте");
  const areas = ["a", "b", "c", "d", "e"].map((id) => ({ id, title: "Сфера " + id, topics: [] }));
  const tasks = [...areas, { id: "чужая" }].map((a, i) => ({ ...base, id: "t-0000000" + i, area: a.id, topic: null })).reverse();
  const five = { ...state, areas, tasks, goals: [], decisions: [], main: null };
  const titles = ["Сфера a", "Сфера b", "Сфера c", "Сфера d", "Сфера e", "чужая"];
  assert.deepEqual(L.deriveDay(five, TOMORROW, TODAY, []).groups.map((g) => [g.title, g.total]), titles.map((t) => [t, 1]));
  assert.deepEqual(L.deriveDay(five, TOMORROW, TOMORROW, []).groups.map((g) => g.title), titles);
  assert.equal(L.deriveDay(five, TOMORROW, TODAY, []).total, 6);
  assert.deepEqual(L.deriveGoals(five).map((a) => a.title), titles.slice(0, 5));
  assert.equal(L.dayStrip(five, TODAY, TODAY).find((c) => c.date === TOMORROW).open, 6);

  const one = { ...five, areas: areas.slice(2, 3), tasks: tasks.filter((t) => t.area === "c") };
  assert.deepEqual(L.deriveDay(one, TOMORROW, TODAY, []).groups.map((g) => g.title), ["Сфера c"]);
  assert.deepEqual(L.deriveGoals(one).map((a) => a.title), ["Сфера c"]);
  assert.deepEqual(L.deriveDay({ ...one, areas: [], tasks: [] }, TOMORROW, TODAY, []).groups, []);

  // три сферы примера: каждая со своими задачами в свой день
  assert.deepEqual(L.deriveDay(fixture(), TOMORROW, TODAY, []).groups.map((g) => g.id), ["course", "channel", "personal"]);
});

// ---------- свои отметки ----------

test("нажатие: открыта → сделана → не сделана → открыта", () => {
  assert.equal(L.nextStatus("open"), "done");
  assert.equal(L.nextStatus("done"), "fail");
  assert.equal(L.nextStatus("fail"), "open");

  let p = L.tapTask({}, "t-1", "open", "open");
  assert.deepEqual(p, { "t-1": { status: "done", batch: null, stamp: null, sentAt: null, again: false } });
  p = L.tapTask(p, "t-1", "done", "open");
  assert.equal(p["t-1"].status, "fail");
  p = L.tapTask(p, "t-1", "fail", "open");
  assert.deepEqual(p, {}, "вернулись к записанному, ничего не уходило — слать нечего");

  // отметка уже ушла файлом: возврат к прежнему надо отправить отдельно
  const sent = { "t-1": { status: "done", batch: "B1", stamp: 5, sentAt: 5 } };
  const back = L.tapTask(L.tapTask(sent, "t-1", "done", "open"), "t-1", "fail", "open");
  assert.deepEqual(back, { "t-1": { status: "open", batch: null, stamp: null, sentAt: null, again: true } });
  // и после этого набор с возвратом действительно собирается
  assert.deepEqual(L.takeBatch(back, "B2").ops, [{ op: "set_status", id: "t-1", status: "open" }]);
});

test("отметки уходят одним набором", () => {
  let p = L.tapTask({}, "t-1", "open", "open");
  p = L.tapTask(p, "t-2", "done", "done");
  const first = L.takeBatch(p, "B1");
  assert.deepEqual(first.ops, [
    { op: "set_status", id: "t-1", status: "done" },
    { op: "set_status", id: "t-2", status: "fail" },
  ]);
  assert.ok(Object.values(first.pending).every((c) => c.batch === "B1"));
  // второй раз те же отметки не уходят
  assert.deepEqual(L.takeBatch(first.pending, "B2").ops, []);
  // новое нажатие после отправки — новый набор только с ним
  const again = L.tapTask(first.pending, "t-2", "fail", "done");
  const second = L.takeBatch(again, "B2");
  assert.deepEqual(second.ops, [{ op: "set_status", id: "t-2", status: "open" }]);
  assert.equal(second.pending["t-1"].batch, "B1");

  const marked = L.markBatchSent(second.pending, "B1", 1000, 1500);
  assert.deepEqual(marked["t-1"], { status: "done", batch: "B1", stamp: 1000, sentAt: 1500, again: false });
  assert.equal(marked["t-2"].stamp, null);
  assert.equal(L.renameBatch(marked, "B2", "B3")["t-2"].batch, "B3");
  assert.equal(L.renameBatch(marked, "B2", "B3")["t-1"].batch, "B1");
});

test("отметки, чей файл потерялся до отправки, копятся заново", () => {
  const pending = {
    "t-1": { status: "done", batch: "LOST", stamp: null, sentAt: null },
    "t-2": { status: "done", batch: "ALIVE", stamp: null, sentAt: null },
    "t-3": { status: "done", batch: "GONE", stamp: 10, sentAt: 10 },
  };
  const fixed = L.repairPending(pending, [{ id: "ALIVE" }]);
  assert.equal(fixed["t-1"].batch, null);
  assert.equal(fixed["t-2"].batch, "ALIVE");
  assert.equal(fixed["t-3"].batch, "GONE", "отправленное ждёт подтверждения сводкой");
});

test("свои отметки поверх свежей сводки", () => {
  const state = fixture();
  const frozen = JSON.stringify(state);
  const gen = at(state.generated_at);
  const task = taskByText(state, "Записать первый урок");
  const change = (stamp, extra) => ({ [task.id]: { status: "done", batch: "B1", stamp, sentAt: stamp, ...extra } });
  const statusIn = (r) => r.state.tasks.find((t) => t.id === task.id).status;

  // ещё не ушло в GitHub — показываем своё
  let r = L.overlayState(state, { [task.id]: { status: "done", batch: null, stamp: null, sentAt: null } }, gen);
  assert.equal(statusIn(r), "done");
  assert.equal(Object.keys(r.pending).length, 1);
  assert.equal(JSON.stringify(state), frozen, "сводка не портится");
  assert.equal(taskByText(r.state, "Записать первый урок").text, task.text);

  // ушло, но сводка собрана раньше — держим своё, даже если входящие в ней пусты
  r = L.overlayState(state, change(gen + 5000), gen + 6000);
  assert.equal(statusIn(r), "done");
  assert.equal(Object.keys(r.pending).length, 1);

  // сводка новее, но файл ещё во входящих и статус прежний — держим
  const busy = { ...state, generated_at: L.isoAt(gen + 20000, 180), inbox_pending: 1 };
  r = L.overlayState(busy, change(gen + 5000), gen + 21000);
  assert.equal(statusIn(r), "done");
  assert.equal(Object.keys(r.pending).length, 1);

  // сводка новее и статус совпал — подтверждено
  const applied = { ...busy, tasks: state.tasks.map((t) => (t.id === task.id ? { ...t, status: "done" } : t)) };
  r = L.overlayState(applied, change(gen + 5000), gen + 21000);
  assert.equal(statusIn(r), "done");
  assert.deepEqual(r.pending, {});
  assert.equal(r.state, applied, "нечего накладывать — та же сводка");

  // сводка новее, входящие пусты, а статус другой (операцию отвергли или переиграли) — верим сводке
  const drained = { ...state, generated_at: L.isoAt(gen + 20000, 180), inbox_pending: 0 };
  r = L.overlayState(drained, change(gen + 5000), gen + 21000);
  assert.equal(statusIn(r), "open");
  assert.deepEqual(r.pending, {});

  // задачи в новой сводке больше нет
  const gone = { ...busy, tasks: state.tasks.filter((t) => t.id !== task.id) };
  assert.deepEqual(L.overlayState(gone, change(gen + 5000), gen + 21000).pending, {});

  // застряло дольше часа — перестаём накладывать
  r = L.overlayState(busy, change(gen + 5000), gen + 5000 + L.OVERLAY_MAX_MS + 1);
  assert.equal(statusIn(r), "open");
  assert.deepEqual(r.pending, {});

  // совпадение статуса до отправки ничего не подтверждает: быстрый «туда-обратно» не теряется
  r = L.overlayState(state, { [task.id]: { status: "open", batch: "B2", stamp: gen + 9000, sentAt: gen + 9000 } }, gen + 9500);
  assert.equal(Object.keys(r.pending).length, 1);
});

// ---------- свои сообщения ----------

test("лента «Сказать»: свои сообщения и ответы, новые сверху", () => {
  const state = fixture();
  const now = at("2026-10-05T12:30:00+03:00");
  const mine = (hex, isoSent, patch) => ({
    ...L.outboxEntry(L.textMessage(L.inboxId(at(isoSent), hex), isoSent, "текст " + hex), at(isoSent)), ...patch,
  });
  const queued = mine("aaaaaa", "2026-10-05T12:29:50+03:00", {});
  const working = mine("bbbbbb", "2026-10-05T12:29:00+03:00", { state: "sent", sentAt: now - 60000 });
  const late = mine("cccccc", "2026-10-05T12:20:00+03:00", { state: "sent", sentAt: now - L.WAIT_MS });
  const ops = { ...L.outboxEntry(L.opsMessage("20261005T092955Z-dddddd", "2026-10-05T12:29:55+03:00", []), now), state: "sent", sentAt: now };
  const answered = { ...mine("3fa9c1", "2026-10-05T09:30:12+03:00", { state: "sent", sentAt: now }), id: state.replies[0].id };

  const feed = L.buildFeed(state, [late, working, queued, ops, answered], now);
  assert.deepEqual(feed.map((m) => m.phase), ["queued", "working", "late", "answered", "answered", "answered"]);
  assert.deepEqual(feed.slice(0, 3).map((m) => m.text), ["текст aaaaaa", "текст bbbbbb", "текст cccccc"]);
  assert.equal(feed.filter((m) => m.id === state.replies[0].id).length, 1, "пришёл ответ — своя копия не дублируется");
  assert.equal(feed[3].id, "20261005T091730Z-58c0aa", "последний ответ выше остальных");
  assert.match(feed[3].reply, /Письмо о старте записи/);
  assert.equal(feed[5].id, "20261005T063012Z-3fa9c1");

  // сводки ещё нет — показываем хотя бы своё
  assert.deepEqual(L.buildFeed(null, [queued], now).map((m) => m.phase), ["queued"]);

  // неудачный разбор и частичные ошибки видны
  const bad = { ...state, replies: [
    { id: "x1", at: "2026-10-05T12:00:00+03:00", text: "что-то", reply: "Не получилось: кончился лимит.", ok: false, applied: 0, errors: [] },
    { id: "x2", at: "2026-10-05T11:00:00+03:00", text: "ещё", reply: "Записал одну задачу.", ok: true, applied: 1, errors: ["set_status: нет задачи"] },
    { id: "x3", at: "2026-10-05T10:00:00+03:00", text: "", reply: "", ok: true, applied: 1, errors: [] },
  ] };
  const f2 = L.buildFeed(bad, [], now);
  assert.deepEqual(f2.map((m) => [m.id, m.ok, m.errors]), [["x1", false, 0], ["x2", true, 1]], "пустая запись (нажатия) в ленту не идёт");
});

test("исходящие: что забываем и когда ждём ответа", () => {
  const state = fixture();
  const now = at("2026-10-05T12:30:00+03:00");
  const text = (id, patch) => ({ ...L.outboxEntry(L.textMessage(id, "2026-10-05T12:29:00+03:00", "т"), now), ...patch });
  const ops = (id, patch) => ({ ...L.outboxEntry(L.opsMessage(id, "2026-10-05T12:29:00+03:00", []), now), ...patch });
  const sent = { state: "sent", sentAt: now - 1000, dispatched: true };
  const box = [
    text("q1", {}),                                              // не отправлено
    text("s1", { state: "sent", sentAt: now - 1000 }),           // отправлено, разбор ещё не позвали
    text("s2", sent),                                            // ждёт ответа
    text(state.replies[2].id, sent),                             // ответ пришёл
    text("old", { ...sent, sentAt: now - L.OUTBOX_KEEP_MS }),    // сутки без ответа
    ops("o1", {}),                                               // отметки не отправлены
    ops("o2", sent),                                             // отметки отправлены
  ];
  assert.deepEqual(L.pruneOutbox(box, state, now).map((e) => e.id), ["q1", "s1", "s2", "o1"]);
  assert.deepEqual(L.pruneOutbox(box, null, now).map((e) => e.id), ["q1", "s1", "s2", state.replies[2].id, "o1"]);

  assert.equal(L.isWaiting([], {}, now), false);
  assert.equal(L.isWaiting([text("q1", {})], {}, now), false, "неотправленное — это не ожидание ответа");
  assert.equal(L.isWaiting([text("s2", sent)], {}, now), true);
  assert.equal(L.isWaiting([text("s2", { ...sent, sentAt: now - L.WAIT_MS })], {}, now), false, "через три минуты опрашиваем реже");
  assert.equal(L.isWaiting([ops("o2", sent)], {}, now), false);
  assert.equal(L.isWaiting([], { "t-1": { status: "done", batch: "B", stamp: now, sentAt: now - 1000 } }, now), true);
  assert.equal(L.isWaiting([], { "t-1": { status: "done", batch: null, stamp: null, sentAt: null } }, now), false);
});

// ---------- пробный режим ----------

test("пробный режим изображает разбор", () => {
  const state = fixture();
  const gen = at(state.generated_at);
  const now = gen + 60000;
  const task = taskByText(state, "Записать первый урок");
  const hang = taskByText(state, "Ответить на вопросы под вступительным роликом");

  const afterOps = L.mockProcess(state, L.opsMessage("id1", "x", [
    { op: "set_status", id: task.id, status: "done" },
    { op: "set_status", id: hang.id, status: "fail" },
  ]), now);
  assert.ok(at(afterOps.generated_at) > gen);
  assert.equal(L.offsetOf(afterOps.generated_at), 180);
  assert.equal(taskByText(afterOps, task.text).status, "done");
  assert.equal(taskByText(afterOps, task.text).closed_at, afterOps.generated_at);
  assert.deepEqual([afterOps.goals[0].done, afterOps.goals[0].total], [2, 3]);
  assert.deepEqual([afterOps.days[0].done, afterOps.days[0].open], [3, 2]);
  const oct2 = afterOps.days.find((d) => d.date === "2026-10-02");
  assert.deepEqual([oct2.fail, oct2.open], [1, 0]);
  assert.equal(taskByText(state, task.text).status, "open", "исходная сводка не меняется");

  // после «разбора» своя отметка считается подтверждённой
  const pending = L.markBatchSent(L.takeBatch(L.tapTask({}, task.id, "open", "open"), "id1").pending, "id1", now - 2000, now - 2000);
  assert.deepEqual(L.overlayState(afterOps, pending, now).pending, {});

  const reopened = L.mockProcess(afterOps, L.opsMessage("id2", "x", [{ op: "set_status", id: task.id, status: "open" }]), now + 1000);
  assert.equal(taskByText(reopened, task.text).closed_at, null);

  const msg = L.textMessage("20261005T093100Z-abcdef", "2026-10-05T12:31:00+03:00", "проверка связи");
  const afterText = L.mockProcess(state, msg, now);
  assert.equal(afterText.replies.length, 4);
  const feed = L.buildFeed(afterText, [{ ...L.outboxEntry(msg, now), state: "sent", sentAt: now }], now);
  assert.equal(feed[0].id, msg.id);
  assert.equal(feed[0].phase, "answered");
  assert.equal(feed[0].text, "проверка связи");
  assert.match(feed[0].reply, /пробный режим/i);
});

// ---------- напоминания: расчёты ----------

// открытый ключ сервера напоминаний из договорённости с ядром (он же applicationServerKey)
const VAPID_PUBLIC = "BMcZV71hIDHwnooVxCUbw-JvuprLQaICfWaGKcKyk5tR_URRuaLKj_JElv1aS58qsh6PnfbasFOtR368es_-k1c";

test("config.js: открытый ключ напоминаний на месте, прежние настройки не тронуты", () => {
  const window = {};
  vm.runInNewContext(readFileSync(new URL("../config.js", import.meta.url), "utf8"), { window });
  const cfg = window.BRAIN_CONFIG;
  assert.deepEqual(Object.keys(cfg).sort(), ["repo", "utcOffsetMinutes", "vapidPublicKey"], "ничего лишнего: закрытого ключа здесь нет");
  assert.equal(cfg.vapidPublicKey, VAPID_PUBLIC);
  assert.equal(cfg.repo, "toqusif000-ui/brain");
  assert.equal(cfg.utcOffsetMinutes, 180);
  const key = L.base64urlToBytes(cfg.vapidPublicKey);
  assert.equal(key.length, 65);
  assert.equal(key[0], 4, "несжатая точка P-256");
});

test("версия в app.js и logic.js одна и та же", () => {
  const app = /const VERSION = "([^"]+)"/.exec(readFileSync(new URL("../app.js", import.meta.url), "utf8"));
  assert.equal(app[1], L.VERSION);
});

test("base64url → байты", () => {
  for (let size = 0; size <= 70; size++) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37 + size * 11 + 250) % 256);
    const text = Buffer.from(bytes).toString("base64url");
    assert.deepEqual(L.base64urlToBytes(text), bytes, "длина " + size);
  }
  assert.deepEqual(L.base64urlToBytes("-_-_"), Uint8Array.from([0xfb, 0xff, 0xbf]), "знаки «-» и «_», а не «+» и «/»");
  assert.deepEqual(L.base64urlToBytes("Zm8="), Uint8Array.from(Buffer.from("fo")), "«=» в конце не мешает");
  assert.equal(Buffer.from(L.base64urlToBytes(VAPID_PUBLIC)).toString("base64url"), VAPID_PUBLIC);
  assert.throws(() => L.base64urlToBytes("a+b/"));
  assert.throws(() => L.base64urlToBytes("ключ"));
});

test("отпечаток подписки: первые 16 знаков SHA-256 от адреса", async () => {
  assert.equal(await L.endpointHash("abc", crypto.subtle), "ba7816bf8f01cfea", "известное значение SHA-256");
  const endpoint = "https://web.push.apple.com/QGk3fFz8Vn1pLr0aXw7dTt2yYb5cJm9sHh4eUu6iOoKq";
  const hash = await L.endpointHash(endpoint, crypto.subtle);
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(hash, hashOf(endpoint));
  assert.notEqual(await L.endpointHash(endpoint + "x", crypto.subtle), hash);
});

test("что память знает о подписках", () => {
  assert.equal(L.pushInfo(fixture()), null, "сводка от ядра, которое о напоминаниях не знает");
  assert.equal(L.pushInfo(null), null);
  assert.equal(L.pushInfo({ push: "да" }), null);
  assert.equal(L.pushInfo({ push: ["a"] }), null);
  assert.deepEqual(L.pushInfo({ push: { endpoints: ["0011223344556677"], broken: false } }),
    { endpoints: ["0011223344556677"], broken: false });
  assert.deepEqual(L.pushInfo({ push: { endpoints: [], broken: true } }), { endpoints: [], broken: true });
  assert.deepEqual(L.pushInfo({ push: {} }), { endpoints: [], broken: false }, "неполная запись читается как «подписок нет»");
  assert.deepEqual(L.pushInfo({ push: { endpoints: "x", broken: "да" } }), { endpoints: [], broken: false });
  // разбор сводки поле не теряет
  const state = L.parseState({ ...JSON.parse(fixtureText), push: { endpoints: ["0011223344556677"], broken: true } });
  assert.deepEqual(L.pushInfo(state), { endpoints: ["0011223344556677"], broken: true });
});

test("подписка: чинить или нет", () => {
  const mine = "0011223344556677";
  const knows = { endpoints: ["ffffffffffffffff", mine], broken: false };
  const forgot = { endpoints: ["ffffffffffffffff"], broken: false };
  const ask = (patch) => L.pushHeal({ permission: "granted", hash: mine, push: knows, waiting: false, ...patch });

  assert.equal(ask({}), "none", "память знает эту подписку");
  assert.equal(ask({ push: { ...knows, broken: true } }), "none", "сломалась чужая подписка, наша на месте");
  assert.equal(ask({ push: forgot }), "subscribe", "памяти подписка неизвестна — шлём её снова");
  assert.equal(ask({ push: { endpoints: [], broken: false } }), "subscribe");
  assert.equal(ask({ push: { ...forgot, broken: true } }), "renew", "пуш-сервис сказал, что подписки нет: нужна новая");
  assert.equal(ask({ hash: "" }), "subscribe", "подписки на устройстве нет");
  assert.equal(ask({ hash: "", push: { endpoints: [], broken: true } }), "subscribe", "снимать нечего");

  // подписка уже в исходящих: ждём, второй раз не шлём
  assert.equal(ask({ push: forgot, waiting: true }), "none");
  assert.equal(ask({ push: { ...forgot, broken: true }, waiting: true }), "none");
  assert.equal(ask({ hash: "", waiting: true }), "none");
  // разрешения нет — подписку не трогаем
  for (const permission of ["default", "denied", "", undefined]) {
    assert.equal(ask({ permission, push: forgot }), "none");
    assert.equal(ask({ permission, hash: "" }), "none");
  }
  // ядро о напоминаниях ещё не знает — сверять не с чем
  assert.equal(ask({ push: null }), "none");
  assert.equal(ask({ push: null, hash: "" }), "none");
});

test("что показать о напоминаниях", () => {
  const ask = (patch) => L.pushNotice({ installed: true, supported: true, permission: "default", phase: "", ...patch });
  assert.deepEqual(ask({}), { kind: "offer", text: "Включить напоминания в 9:00 и 21:00", button: "Включить", busy: false });
  assert.deepEqual(ask({ phase: "busy" }), { kind: "offer", text: "Включить напоминания в 9:00 и 21:00", button: "Включаю…", busy: true });
  assert.deepEqual(ask({ phase: "busy", permission: "granted" }).button, "Включаю…", "разрешили, подписка ещё идёт");
  assert.deepEqual(ask({ permission: "granted", phase: "enabled" }), { kind: "enabled", text: "Напоминания включены.", button: "", busy: false });
  assert.deepEqual(ask({ permission: "granted" }), { kind: "none", text: "", button: "", busy: false }, "включено давно — молчим");
  assert.deepEqual(ask({ permission: "granted", phase: "failed" }),
    { kind: "failed", text: "Не получилось включить напоминания.", button: "Попробовать ещё раз", busy: false });

  // запрещено — одна строка, без кнопки: приложение спросить ещё раз не может
  for (const phase of ["", "busy", "enabled", "failed"]) {
    const denied = ask({ permission: "denied", phase });
    assert.equal(denied.kind, "denied");
    assert.equal(denied.button, "");
    assert.match(denied.text, /Разреши уведомления для «Мозг»/);
    assert.match(denied.text, /Настройки iPhone/);
  }

  // обычная вкладка и устройство без пушей — ничего
  for (const permission of ["default", "denied", "granted"]) {
    for (const phase of ["", "busy", "enabled", "failed"]) {
      assert.equal(ask({ installed: false, permission, phase }).kind, "none");
      assert.equal(ask({ supported: false, permission, phase }).kind, "none");
    }
  }
  // ни похвалы, ни упрёков, ни восклицаний
  for (const note of [ask({}), ask({ phase: "failed" }), ask({ permission: "denied" }), ask({ permission: "granted", phase: "enabled" })]) {
    assert.doesNotMatch(note.text + note.button, /!|молодец|отлично|жаль|подряд/i);
  }
});

test("имя устройства по строке браузера", () => {
  assert.equal(L.deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"), "iPhone");
  assert.equal(L.deviceName("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"), "iPad");
  assert.equal(L.deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"), "Android");
  assert.equal(L.deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"), "Mac");
  assert.equal(L.deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"), "Windows");
  assert.equal(L.deviceName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"), "Linux");
  assert.equal(L.deviceName(""), "Другое");
  assert.equal(L.deviceName(undefined), "Другое");
});

test("операция подписки для входящих — по договорённости с ядром", () => {
  const sub = {
    endpoint: "https://web.push.apple.com/QGk3fFz8Vn1pLr0aXw7d",
    expirationTime: null,
    keys: { p256dh: "BPkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk", auth: "aaaaaaaaaaaaaaaaaaaaaa" },
  };
  const op = L.subscribeOp(sub, "iPhone");
  assert.deepEqual(op, { op: "push_subscribe", endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, device: "iPhone" });
  assert.deepEqual(Object.keys(op), ["op", "endpoint", "p256dh", "auth", "device"]);
  // файл для входящих — обычный файл нажатий
  const file = L.opsMessage("20261005T092000Z-a1b2c3", "2026-10-05T12:20:00+03:00", [op]);
  assert.deepEqual(file, { id: "20261005T092000Z-a1b2c3", sent_at: "2026-10-05T12:20:00+03:00", channel: "phone", type: "ops", ops: [op] });
  assert.deepEqual(JSON.parse(L.inboxBody(file)), file);

  // ключи приводятся к base64url без «=»
  const padded = L.subscribeOp({ ...sub, keys: { p256dh: "ab+/cd==", auth: "ef/+gh=" } }, "iPhone");
  assert.deepEqual([padded.p256dh, padded.auth], ["ab-_cd", "ef_-gh"]);

  // подписка не по форме в память не уходит
  assert.equal(L.subscribeOp(null, "iPhone"), null);
  assert.equal(L.subscribeOp({}, "iPhone"), null);
  assert.equal(L.subscribeOp({ ...sub, endpoint: "http://web.push.apple.com/Q" }, "iPhone"), null, "адрес только https");
  assert.equal(L.subscribeOp({ ...sub, endpoint: "https://" }, "iPhone"), null);
  assert.equal(L.subscribeOp({ ...sub, endpoint: "https://web.push.apple.com/Q 1" }, "iPhone"), null);
  assert.equal(L.subscribeOp({ ...sub, endpoint: 5 }, "iPhone"), null);
  assert.equal(L.subscribeOp({ ...sub, keys: { p256dh: sub.keys.p256dh } }, "iPhone"), null);
  assert.equal(L.subscribeOp({ ...sub, keys: { p256dh: "", auth: sub.keys.auth } }, "iPhone"), null);
  assert.equal(L.subscribeOp({ ...sub, keys: { p256dh: "ключ", auth: sub.keys.auth } }, "iPhone"), null);
  assert.equal(L.subscribeOp({ endpoint: sub.endpoint }, "iPhone"), null);
});

test("с какой вкладки начать", () => {
  assert.deepEqual(L.TABS, ["today", "goals", "review", "say"]);
  for (const tab of L.TABS) {
    assert.equal(L.startTab("?tab=" + tab, ""), tab);
    assert.equal(L.startTab("", "#" + tab), tab);
  }
  assert.equal(L.startTab("?tab=say", "#review"), "say", "адрес из уведомления главнее");
  assert.equal(L.startTab("?mock=1&tab=goals", ""), "goals");
  assert.equal(L.startTab("?tab=чужое", "#review"), "review");
  assert.equal(L.startTab("?tab=", ""), "today");
  assert.equal(L.startTab("?tab=settings", "#nope"), "today");
  assert.equal(L.startTab("", ""), "today");
  assert.equal(L.startTab(undefined, undefined), "today");

  // первая вкладка теперь «Задачи»: её зовут и tasks, и по-прежнему today
  assert.equal(L.startTab("?tab=tasks", ""), "today");
  assert.equal(L.startTab("?tab=tasks", "#say"), "today", "так открывает уведомление о событии");
  assert.equal(L.startTab("?mock=1&tab=tasks", ""), "today");
  assert.equal(L.startTab("", "#tasks"), "today");
  assert.equal(L.tabId("tasks"), "today");
  for (const tab of L.TABS) assert.equal(L.tabId(tab), tab);
  for (const junk of ["чужое", "", "Tasks", "constructor", "__proto__", null, undefined, 5, {}]) assert.equal(L.tabId(junk), "", String(junk));
});

test("число для значка: открытые задачи на сегодня", () => {
  const state = fixture();
  assert.equal(L.openToday(state, TODAY), 3);
  assert.equal(L.openToday(state, "2026-10-06"), 3);
  assert.equal(L.openToday(state, "2026-10-07"), 0, "висящие с прошлых дней и задачи будущих дней в значок не идут");
  assert.equal(L.openToday(state, "2026-10-02"), 1);
  // своя неподтверждённая отметка уже учтена
  const task = taskByText(state, "Записать первый урок");
  const view = L.overlayState(state, L.tapTask({}, task.id, "open", "open"), 0).state;
  assert.equal(L.openToday(view, TODAY), 2);
  assert.equal(L.openToday({ ...state, tasks: [] }, TODAY), 0);
});

test("исходящие: отправленная подписка ждёт, пока сводка её покажет, но не дольше десяти минут", () => {
  const now = at("2026-10-05T12:30:00+03:00");
  const mine = "0011223344556677";
  const op = { op: "push_subscribe", endpoint: "https://web.push.apple.com/Q1", p256dh: "p", auth: "a", device: "iPhone" };
  const entry = (patch) => ({ ...L.outboxEntry(L.opsMessage("p1", "2026-10-05T12:29:00+03:00", [op]), now), push: mine, ...patch });
  const sent = { state: "sent", sentAt: now - 1000, dispatched: true };
  const withPush = (endpoints) => ({ ...fixture(), push: { endpoints, broken: false } });
  const left = (box, state, when = now) => L.pruneOutbox(box, state, when).map((e) => e.id);

  assert.deepEqual(left([entry({})], withPush([])), ["p1"], "неотправленное не трогаем");
  assert.deepEqual(left([entry({ state: "sent", sentAt: now - 1000 })], withPush([mine])), ["p1"], "разбор ещё не позвали");
  assert.deepEqual(left([entry(sent)], withPush([])), ["p1"], "в пути: сводка подписку ещё не показала");
  assert.deepEqual(left([entry(sent)], withPush(["ffffffffffffffff"])), ["p1"]);
  assert.deepEqual(left([entry(sent)], fixture()), ["p1"], "сводка без поля push");
  assert.deepEqual(left([entry(sent)], null), ["p1"], "сводки нет");
  assert.deepEqual(left([entry(sent)], withPush([mine])), [], "память подписку знает");
  assert.deepEqual(left([entry(sent)], withPush([]), now - 1000 + L.PUSH_WAIT_MS - 1), ["p1"]);
  assert.deepEqual(left([entry(sent)], withPush([]), now - 1000 + L.PUSH_WAIT_MS), [], "десять минут прошло");
  assert.equal(L.PUSH_WAIT_MS, 10 * 60 * 1000);
  // обычные отметки по-прежнему забываются сразу после отправки
  assert.deepEqual(left([entry({ ...sent, push: undefined })], withPush([])), []);
  // подписка в пути частого опроса не требует
  assert.equal(L.isWaiting([entry(sent)], {}, now), false);
});

// ---------- приложение целиком: отправка ----------

// Открывает приложение с уже вставленным ключом (key: false — без ключа, на экране настройки).
// По умолчанию оно установлено на экран «Домой»; home: false — обычная вкладка браузера.
// push — fakePush(): устройство с уведомлениями; search и hash — хвост адреса (?tab=say, #review).
async function boot(options = {}) {
  const clock = options.clock || { now: at("2026-10-05T12:20:00+03:00") };
  const gh = options.gh || fakeGitHub(clock, { ...JSON.parse(fixtureText), ...options.state });
  const local = options.local || new FakeStorage();
  const session = options.session || new FakeStorage();
  const home = options.home !== false;
  const disk = home || options.ios ? local : session;   // где приложение должно держать своё
  if (options.key !== false) disk.setItem("brain:token", JSON.stringify("KEY"));
  const app = startApp({
    clock, gh, local, session, home, ios: options.ios,
    push: options.push, search: options.search, hash: options.hash, oldLogic: options.oldLogic,
  });
  await settle();
  return { app, gh, clock, local, session, disk };
}
const queued = (disk) => disk.read("outbox").filter((e) => e.state === "queued");
// Вкладка «Задачи»: дни на полосе и текст выбранного дня (всё, что под полосой).
const chips = (app) => app.nodes("tab-today", "day")
  .map((n) => ({ date: n.dataset.date, text: n.textContent, picked: n.attrs["aria-pressed"] === "true" }));
const pickedDay = (app) => chips(app).filter((c) => c.picked).map((c) => c.date);
const dayText = (app) => app.inner("tab-today", "day").textContent;

test("ответ на PUT потерялся, а сообщение уже разобрали: второй раз оно не отправляется", async () => {
  const { app, gh, disk } = await boot();
  gh.plan.push("lost");
  await app.say("купить домен");
  const [entry] = disk.read("outbox");
  assert.deepEqual([entry.state, entry.tried], ["queued", true], "исход попытки неизвестен");
  assert.deepEqual(gh.accepted, [entry.id], "файл на самом деле лёг");
  assert.equal(gh.dispatches, 0);

  gh.process(entry.id);   // разобрал запуск по расписанию или запуск от прошлого сообщения
  const mark = gh.log.length;
  await app.wake();
  assert.deepEqual(gh.accepted, [entry.id], "один принятый PUT на одно сообщение");
  assert.ok(!gh.log.slice(mark).some((line) => line.startsWith("PUT")), "повторного PUT не было вовсе");
  assert.equal(gh.dispatches, 0, "разбирать больше нечего");
  assert.deepEqual(disk.read("outbox"), [], "сообщение с ответом забыто");
  await app.click({ act: "tab", tab: "say" });
  assert.match(app.text("feed"), /купить домен/);
  assert.match(app.text("feed"), /Записал\./);
});

test("приложение закрыли посреди PUT, сообщение разобрали: после запуска оно не отправляется заново", async () => {
  const first = await boot();
  first.gh.plan.push("hang");
  await first.app.say("купить домен");
  const [entry] = first.disk.read("outbox");
  assert.deepEqual([entry.state, entry.tried], ["queued", true]);
  first.gh.process(entry.id);

  const { clock, gh, local, session } = first;
  await boot({ clock, gh, local, session });   // то же устройство, приложение открыто заново
  assert.deepEqual(gh.accepted, [entry.id]);
  assert.equal(gh.dispatches, 0);
  assert.deepEqual(local.read("outbox"), []);
});

test("ответ на PUT потерялся, файл ещё не разобран: повтор получает 422 и считается доставленным", async () => {
  const { app, gh, disk } = await boot();
  gh.plan.push("lost");
  await app.say("купить домен");
  const [entry] = disk.read("outbox");
  const mark = gh.log.length;
  await app.wake();
  // свежая сводка читается прямо перед повтором (второй GET), ответа в ней нет — тогда PUT
  assert.deepEqual(gh.log.slice(mark), ["GET state", "GET state", "PUT " + entry.id, "POST dispatches"]);
  assert.deepEqual(gh.accepted, [entry.id]);
  assert.deepEqual([...gh.files.keys()], [entry.id], "файл один, под тем же именем");
  assert.equal(gh.dispatches, 1);
  assert.deepEqual(queued(disk), []);
});

test("перед повтором сводка не читается: сообщение всё равно уходит, повтор отсеет ядро по id", async () => {
  const { app, gh, disk } = await boot();
  gh.plan.push("lost");
  await app.say("купить домен");
  const [entry] = disk.read("outbox");
  gh.process(entry.id);
  gh.stateStatus = 500;
  await app.wake();
  // Файл лёг второй раз под тем же id: ядро такой id второй раз не применяет, а сообщение не застревает на устройстве.
  assert.deepEqual(gh.accepted, [entry.id, entry.id]);
  assert.equal(queued(disk).length, 0);
});

test("сводки в репозитории ещё нет: повтор после оборванной попытки всё равно уходит", async () => {
  const { app, gh, disk } = await boot({ gh: fakeGitHub({ now: 0 }, null) });
  gh.online = false;
  await app.say("первое сообщение");
  assert.equal(disk.read("outbox")[0].tried, true);
  gh.online = true;
  await app.wake();
  assert.equal(gh.accepted.length, 1);
  assert.deepEqual(queued(disk), []);
});

test("разбор сообщения не удался (ok: false): повторного PUT нет, но разбор зовём ещё раз", async () => {
  const { app, gh, disk } = await boot();
  gh.plan.push("lost");
  await app.say("купить домен");
  const [entry] = disk.read("outbox");
  // файл остался во входящих, в ответах — запись о неудаче
  const failed = { id: entry.id, at: gh.state.generated_at, text: entry.file.text, reply: "Не получилось: кончился лимит.", ok: false, applied: 0, errors: [] };
  gh.state = { ...gh.state, replies: [failed, ...gh.state.replies] };
  const mark = gh.log.length;
  await app.wake();
  assert.deepEqual(gh.log.slice(mark), ["GET state", "GET state", "POST dispatches"]);
  assert.deepEqual(gh.accepted, [entry.id]);
});

test("GitHub ответил 502, хотя файл записал: повтор не переименовывается и второго файла нет", async () => {
  const { app, gh, disk } = await boot();
  gh.plan.push({ status: 502, lands: true });
  await app.say("купить домен");
  const [entry] = disk.read("outbox");
  assert.deepEqual([entry.state, entry.tried], ["queued", true], "после ошибки сервера исход неизвестен");
  await app.wake();
  assert.deepEqual(gh.accepted, [entry.id]);
  assert.deepEqual([...gh.files.keys()], [entry.id]);
  assert.equal(gh.dispatches, 1);
  assert.deepEqual(queued(disk), []);
});

test("ответ потерялся, потом 409: сообщение остаётся под тем же именем и не задваивается", async () => {
  const { app, gh, disk } = await boot();
  gh.plan.push("lost", { status: 409 });
  await app.say("купить домен");
  const [entry] = disk.read("outbox");
  await app.wake();   // вторая попытка: 409, сразу третья: 422 — файл уже лежит
  assert.deepEqual(gh.accepted, [entry.id]);
  assert.deepEqual([...gh.files.keys()], [entry.id]);
  assert.deepEqual(queued(disk), []);
});

test("409 на первый набор отметок: он уходит под своим именем раньше второго", async () => {
  const { app, gh, clock, disk } = await boot();
  const task = taskByText(gh.state, "Записать первый урок");
  let release;
  gh.plan.push({ hold: new Promise((resolve) => { release = resolve; }) });
  await app.click({ act: "task", id: task.id });   // открыта → сделана
  await app.flushTaps();                           // первый набор в пути, GitHub пока молчит
  clock.now += 2000;
  await app.click({ act: "task", id: task.id });   // сделана → не сделана
  await app.flushTaps();                           // второй набор ждёт своей очереди
  const [b1, b2] = disk.read("outbox").map((e) => e.id);
  clock.now += 2000;
  release({ status: 409 });
  await settle();
  // 409: ничего не записано, первый набор сразу уходит снова под прежним именем, второй — следом
  assert.deepEqual(gh.accepted, [b1, b2]);
  assert.deepEqual([...gh.accepted].sort(), gh.accepted, "разбор идёт по имени: порядок файлов — порядок нажатий");
  assert.deepEqual(gh.accepted.map((id) => gh.files.get(id).ops[0].status), ["done", "fail"], "последнее нажатие применится последним");
});

// ---------- приложение целиком: «Обзор» ----------

test("экран «Обзор» показывает месяцы из сводки, без оговорки про 30 дней", async () => {
  const months = [
    { month: "2026-10", planned: 41, done: 37, fail: 3, moved: 1, open: 0 },
    { month: "2026-09", planned: 58, done: 52, fail: 4, moved: 2, open: 0 },
  ];
  const { app } = await boot({ state: { months } });
  await app.click({ act: "tab", tab: "review" });
  const text = app.text("tab-review");
  assert.match(text, /Октябрь 2026 41 запланировано 37 сделано 3 не сделано 1 перенесено/);
  assert.match(text, /Сентябрь 2026 58 запланировано 52 сделано 4 не сделано 2 перенесено/);
  assert.doesNotMatch(text, /30 дней/);
  assert.doesNotMatch(text, /из таблицы выше/);
});

// ---------- приложение целиком: память устройства ----------

test("на устройстве нет места: текст остаётся в поле, пока сообщение не уйдёт", async () => {
  const { app, gh, local } = await boot();
  local.full = true;
  gh.online = false;
  await app.say("позвонить Ане");
  assert.equal(app.el("say").value, "позвонить Ане", "сохранить не удалось — поле не очищаем");
  assert.doesNotMatch(app.text("banner"), /сохранено/, "не обещаем того, чего нет");
  assert.match(app.text("banner"), /Нет связи\./);
  assert.match(app.text("banner"), /не закрывай приложение/);

  await app.say();   // текст всё ещё в поле, «Отправить» нажали ещё раз
  gh.online = true;
  await app.wake();
  assert.equal(gh.accepted.length, 1, "второе нажатие не создало второго сообщения");
  assert.equal(gh.files.get(gh.accepted[0]).text, "позвонить Ане");
  assert.equal(app.el("say").value, "", "ушло в GitHub — теперь поле можно очистить");
});

test("на устройстве нет места, но связь есть: сообщение уходит сразу и поле очищается", async () => {
  const { app, gh, local } = await boot();
  local.full = true;
  await app.say("позвонить Ане");
  assert.equal(gh.accepted.length, 1);
  assert.equal(app.el("say").value, "");
});

test("пока сообщение не сохранено, новый текст в поле не стирается", async () => {
  const { app, gh, local } = await boot();
  local.full = true;
  gh.online = false;
  await app.say("позвонить Ане");
  app.el("say").value = "и ещё написать Боре";   // начал печатать следующее
  gh.online = true;
  await app.wake();
  assert.equal(gh.accepted.length, 1);
  assert.equal(app.el("say").value, "и ещё написать Боре");
});

test("сообщение сохранено на устройстве: поле очищается сразу, об этом сказано", async () => {
  const { app, gh, local } = await boot();
  gh.online = false;
  await app.say("позвонить Ане");
  assert.equal(app.el("say").value, "");
  assert.equal(local.read("outbox").length, 1);
  assert.match(app.text("banner"), /Сказанное сохранено на устройстве — отправлю, как только получится\./);
});

test("обычная вкладка: ключ, исходящие и сводка живут в sessionStorage, в общий localStorage ничего не пишется", async () => {
  const { app, gh, local, session } = await boot({ home: false, key: false });
  assert.equal(app.screen(), "setup");
  assert.match(app.text("setupForm"), /В обычной вкладке ключ хранится только до её закрытия/);
  await app.connect("TEST-KEY-1");
  assert.equal(app.screen(), "app");
  assert.equal(session.read("token"), "TEST-KEY-1");
  assert.equal(session.read("state").today, TODAY);

  gh.online = false;
  await app.click({ act: "task", id: taskByText(gh.state, "Записать первый урок").id });
  await app.say("позвонить Ане");
  assert.equal(session.read("outbox").length, 1);
  assert.equal(Object.keys(session.read("pending")).length, 1);
  assert.deepEqual(local.keys(), [], "соседние сайты того же адреса ничего не увидят");
  assert.match(app.text("banner"), /Сказанное сохранено до закрытия вкладки — отправлю, как только получится\./);
  assert.doesNotMatch(app.text("banner"), /на устройстве/);
});

test("приложение с экрана «Домой»: всё хранится в localStorage, строки про вкладку нет", async () => {
  for (const mode of [{ home: true }, { home: false, ios: true }]) {
    const { app, gh, local, session } = await boot({ ...mode, key: false });
    assert.equal(app.screen(), "setup");
    assert.doesNotMatch(app.text("setupForm"), /вкладк/);
    await app.connect("TEST-KEY-1");
    gh.online = false;
    await app.say("позвонить Ане");
    assert.equal(local.read("token"), "TEST-KEY-1");
    assert.equal(local.read("state").today, TODAY);
    assert.equal(local.read("outbox").length, 1);
    assert.deepEqual(session.keys(), []);
  }
});

// ---------- приложение целиком: вкладка из адреса ----------

test("адрес ?tab=say открывает «Сказать»; #review работает как раньше; ?tab=tasks, ?tab=today и адрес без хвоста — «Задачи»", async () => {
  const say = await boot({ search: "?tab=say" });
  assert.equal(say.app.text("title"), "Сказать");
  assert.equal(say.app.el("tab-say").hidden, false);
  assert.equal(say.app.el("tab-today").hidden, true);
  assert.equal(say.app.screen(), "app");

  const review = await boot({ hash: "#review" });
  assert.equal(review.app.text("title"), "Обзор");
  assert.equal(review.app.el("tab-review").hidden, false);

  for (const tail of [{ search: "?tab=nope" }, {}, { search: "?tab=tasks" }, { search: "?tab=today" }, { search: "?tab=tasks", hash: "#say" }, { hash: "#tasks" }]) {
    const { app } = await boot(tail);
    assert.equal(app.text("title"), "Задачи", JSON.stringify(tail));
    assert.equal(app.el("tab-today").hidden, false);
    assert.equal(app.el("tab-say").hidden, true);
    assert.deepEqual(pickedDay(app), [TODAY], "при запуске выбран сегодняшний день");
  }
});

// ---------- приложение целиком: напоминания ----------

const pushState = (endpoints = [], broken = false) => ({ push: { endpoints, broken } });
const pushButtons = (app) => app.buttons("tab-today").filter((b) => b.act === "push");
const subscribeOps = (gh) => gh.accepted.map((id) => gh.files.get(id).ops[0]);
const Q1 = "https://web.push.apple.com/Q1";      // первая подписка, которую выдаёт поддельный пуш-сервис
const OLD = "https://web.push.apple.com/QOld";   // подписка, которая была на устройстве до запуска

test("напоминания: «Включить» спрашивает разрешение прямо из нажатия, подписывает и шлёт подписку один раз", async () => {
  const push = fakePush();
  const { app, gh, disk, clock } = await boot({ push, state: pushState() });
  assert.match(dayText(app), /^понедельник, 5 октября Сделано 2 из 5 Включить напоминания в 9:00 и 21:00 Включить Главная задача дня /,
    "карточка — сразу под днём, выше задач");
  assert.deepEqual(pushButtons(app), [{ act: "push", text: "Включить", disabled: false }]);
  assert.deepEqual(push.log, [], "пока не нажали — ничего не спрашиваем и не подписываем");
  assert.deepEqual(gh.accepted, []);

  const mark = gh.log.length;
  app.press({ act: "push" });
  assert.deepEqual(push.log, ["ask"], "вопрос о разрешении — первым делом в обработчике нажатия");
  assert.equal(gh.log.length, mark, "до вопроса — никакой сети");
  assert.deepEqual(pushButtons(app), [{ act: "push", text: "Включаю…", disabled: true }]);
  app.press({ act: "push" });   // нетерпеливое второе нажатие
  await settle();

  assert.deepEqual(push.log, ["ask", "subscribe"], "подписка — сразу за ответом и один раз");
  assert.equal(push.options[0].userVisibleOnly, true);
  assert.equal(Buffer.from(push.options[0].applicationServerKey).toString("base64url"), VAPID_PUBLIC);
  assert.equal(push.options[0].applicationServerKey.length, 65);

  // подписка ушла обычным файлом нажатий, и разбор позвали
  const [id] = gh.accepted;
  assert.deepEqual(gh.log.slice(mark), ["PUT " + id, "POST dispatches"]);
  assert.match(id, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  assert.deepEqual(gh.files.get(id), {
    id, sent_at: "2026-10-05T12:20:00+03:00", channel: "phone", type: "ops",
    ops: [{ op: "push_subscribe", endpoint: Q1, p256dh: "BP" + "k".repeat(85), auth: "a".repeat(22), device: "iPhone" }],
  });
  assert.match(dayText(app), / Сделано 2 из 5 Напоминания включены\. Главная задача дня /);
  assert.deepEqual(pushButtons(app), []);

  // пока память не подтвердила подписку, её не дублируют ни нажатие, ни опрос, ни возврат в приложение
  app.press({ act: "push" });
  await settle();
  await app.wake();
  await app.back();
  assert.deepEqual(gh.accepted, [id]);
  assert.deepEqual(disk.read("outbox").map((e) => [e.id, e.state, e.push]), [[id, "sent", hashOf(Q1)]]);
  assert.doesNotMatch(app.text("tab-today"), /апоминани/, "вернулись в приложение — строка уже не нужна");

  // память подписку узнала: исходящие пусты, и дальше приложение её не трогает
  clock.now += 30000;
  gh.state = { ...gh.state, generated_at: L.isoAt(clock.now, 180), ...pushState([hashOf(Q1)]) };
  await app.wake();
  assert.deepEqual(disk.read("outbox"), []);
  await app.wake();
  await app.back();
  assert.deepEqual(gh.accepted, [id]);
  assert.ok(!push.log.includes("unsubscribe"));
});

test("напоминания: на вопрос ответили «не разрешать» — одна строка про Настройки, ничего не отправлено", async () => {
  const push = fakePush({ answer: "denied" });
  const { app, gh } = await boot({ push, state: pushState() });
  app.press({ act: "push" });
  await settle();
  assert.deepEqual(push.log, ["ask"], "подписываться без разрешения не пробуем");
  assert.match(dayText(app), / Сделано 2 из 5 Напоминания выключены\. Разреши уведомления для «Мозг»: Настройки iPhone → Уведомления → Мозг\. Главная задача дня /);
  assert.deepEqual(pushButtons(app), [], "кнопки нет: спросить второй раз приложение не может");
  await app.wake();
  await app.back();
  assert.deepEqual(push.log, ["ask"]);
  assert.deepEqual(gh.accepted, []);

  // так же выглядит запуск, когда уведомления уже запрещены
  const denied = fakePush({ permission: "denied" });
  const second = await boot({ push: denied, state: pushState() });
  assert.match(second.app.text("tab-today"), /Разреши уведомления для «Мозг»/);
  assert.deepEqual(pushButtons(second.app), []);
  assert.deepEqual(denied.log, []);
});

test("напоминания: вопрос закрыли без ответа — карточка остаётся", async () => {
  const push = fakePush({ answer: "default" });
  const { app, gh } = await boot({ push, state: pushState() });
  app.press({ act: "push" });
  await settle();
  assert.deepEqual(push.log, ["ask"]);
  assert.deepEqual(pushButtons(app), [{ act: "push", text: "Включить", disabled: false }]);
  assert.deepEqual(gh.accepted, []);
});

test("напоминания: подписаться не вышло — об этом сказано, повтор по кнопке, ничего лишнего не ушло", async () => {
  const push = fakePush();
  push.subscribeFails = true;
  const { app, gh } = await boot({ push, state: pushState() });
  app.press({ act: "push" });
  await settle();
  assert.match(dayText(app), / Сделано 2 из 5 Не получилось включить напоминания\. Попробовать ещё раз Главная задача дня /);
  assert.deepEqual(pushButtons(app), [{ act: "push", text: "Попробовать ещё раз", disabled: false }]);
  assert.deepEqual(gh.accepted, []);

  push.subscribeFails = false;
  app.press({ act: "push" });
  await settle();
  assert.match(dayText(app), / Сделано 2 из 5 Напоминания включены\. Главная задача дня /);
  assert.deepEqual(subscribeOps(gh).map((op) => [op.op, op.endpoint]), [["push_subscribe", Q1]]);
});

test("напоминания: включили без связи — подписка ждёт на устройстве и уходит один раз", async () => {
  const push = fakePush();
  const first = await boot({ push, state: pushState() });
  const { gh, clock, local, session } = first;
  gh.online = false;
  first.app.press({ act: "push" });
  await settle();
  assert.match(first.app.text("tab-today"), /Напоминания включены/);
  assert.match(first.app.text("banner"), /Нет связи\./);
  assert.equal(queued(local).length, 1);
  assert.deepEqual(gh.accepted, []);

  // приложение открыли заново, связи всё ещё нет: сводку прочитать не удалось — подписку не трогаем
  const second = await boot({ push, gh, clock, local, session });
  assert.deepEqual(push.log, ["ask", "subscribe"]);
  assert.equal(queued(local).length, 1);

  gh.online = true;
  await second.app.wake();
  await second.app.wake();
  await second.app.back();
  assert.deepEqual(subscribeOps(gh).map((op) => op.endpoint), [Q1], "ушла один раз");
  assert.deepEqual(push.log, ["ask", "subscribe"], "и заново не подписывались");
});

test("напоминания: память подписку не знает — приложение молча шлёт её снова, один раз за запуск", async () => {
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const first = await boot({ push, state: pushState(["ffffffffffffffff"]) });
  const { app, gh, clock, local, session } = first;
  assert.deepEqual(push.log, ["subscribe"], "разрешение уже есть: вопросов не задаём, прежнюю подписку не снимаем");
  assert.equal(push.options[0].userVisibleOnly, true);
  assert.equal(Buffer.from(push.options[0].applicationServerKey).toString("base64url"), VAPID_PUBLIC);
  assert.deepEqual(subscribeOps(gh), [{ op: "push_subscribe", endpoint: OLD, p256dh: "BP" + "k".repeat(85), auth: "a".repeat(22), device: "iPhone" }]);
  assert.equal(gh.dispatches, 1);
  assert.doesNotMatch(app.text("tab-today"), /апоминани/, "чиним молча");

  // подписка так и не появилась в сводке; прошло больше десяти минут — по кругу не ходим
  await app.wake();
  await app.back();
  clock.now += L.PUSH_WAIT_MS + 1000;
  await app.wake();
  await app.back();
  assert.deepEqual(local.read("outbox"), []);
  assert.equal(gh.accepted.length, 1);
  assert.deepEqual(push.log, ["subscribe"]);

  // следующий запуск — ещё одна попытка, и снова только одна
  const second = await boot({ push, gh, clock, local, session });
  await second.app.wake();
  await second.app.back();
  assert.deepEqual(subscribeOps(gh).map((op) => op.endpoint), [OLD, OLD]);
  assert.deepEqual(push.log, ["subscribe", "subscribe"]);
});

test("напоминания: подписки на устройстве нет, а разрешение есть — подписываемся молча", async () => {
  const push = fakePush({ permission: "granted" });
  const { app, gh } = await boot({ push, state: pushState() });
  assert.deepEqual(push.log, ["subscribe"]);
  assert.deepEqual(subscribeOps(gh).map((op) => [op.op, op.endpoint, op.device]), [["push_subscribe", Q1, "iPhone"]]);
  assert.deepEqual(pushButtons(app), []);
  assert.doesNotMatch(app.text("tab-today"), /апоминани/);
});

test("напоминания: пуш-сервис сообщил, что подписка умерла — снимаем её и шлём новую", async () => {
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const { app, gh } = await boot({ push, state: pushState([], true) });
  assert.deepEqual(push.log, ["unsubscribe", "subscribe"], "иначе браузер вернул бы ту же мёртвую подписку");
  assert.deepEqual(subscribeOps(gh).map((op) => op.endpoint), [Q1]);
  await app.wake();
  await app.back();
  assert.equal(gh.accepted.length, 1);
});

test("напоминания: память подписку знает — ничего не делаем, даже если сломалась чужая", async () => {
  for (const broken of [false, true]) {
    const push = fakePush({ permission: "granted", endpoint: OLD });
    const { app, gh } = await boot({ push, state: pushState(["ffffffffffffffff", hashOf(OLD)], broken) });
    await app.wake();
    await app.back();
    assert.deepEqual(push.log, []);
    assert.deepEqual(gh.accepted, []);
    assert.doesNotMatch(app.text("tab-today"), /апоминани/);
  }
});

test("напоминания: сводка не прочиталась или ядро о них ещё не знает — подписку не трогаем", async () => {
  // сводка от прежнего ядра: поля push нет
  const old = fakePush({ permission: "granted", endpoint: OLD });
  const first = await boot({ push: old });
  await first.app.wake();
  await first.app.back();
  assert.deepEqual(old.log, []);
  assert.deepEqual(first.gh.accepted, []);

  // на устройстве лежит прошлая сводка без нашей подписки, а свежую прочитать не удалось
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const clock = { now: at("2026-10-05T12:20:00+03:00") };
  const gh = fakeGitHub(clock, { ...JSON.parse(fixtureText), ...pushState([hashOf(OLD)]) });
  gh.online = false;
  const local = new FakeStorage({ "brain:state": JSON.stringify({ ...JSON.parse(fixtureText), ...pushState() }) });
  const { app } = await boot({ push, gh, clock, local });
  assert.deepEqual(push.log, [], "прошлой сводке про подписку не верим");
  gh.online = true;
  await app.wake();
  assert.deepEqual(push.log, [], "свежая сводка подписку знает");
  assert.deepEqual(gh.accepted, []);
});

test("обычная вкладка: о напоминаниях ни слова, подписку и значок не трогаем", async () => {
  for (const permission of ["default", "denied", "granted"]) {
    const push = fakePush({ permission, endpoint: OLD });
    const { app, gh } = await boot({ home: false, push, state: pushState() });
    assert.equal(app.screen(), "app");
    assert.doesNotMatch(app.text("tab-today"), /апоминани|ведомлени/);
    assert.deepEqual(pushButtons(app), []);
    app.press({ act: "push" });
    await settle();
    await app.wake();
    await app.back();
    assert.deepEqual(push.log, []);
    assert.deepEqual(gh.accepted, []);
    assert.deepEqual(push.badges, []);
  }
});

test("запас отдал новый app.js со старым logic.js: одна перезагрузка, дальше приложение работает как раньше, без напоминаний", async () => {
  for (const name of STAGE2) assert.ok(name in L, name + " — есть в нынешнем logic.js");
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const session = new FakeStorage();
  const first = await boot({ push, session, oldLogic: true, state: pushState() });
  assert.equal(first.app.reloads(), 1, "версии разошлись — одна перезагрузка");
  assert.deepEqual(first.gh.log, [], "до перезагрузки приложение ничего не делает");

  // после перезагрузки logic.js всё ещё прежний: работаем как есть
  const { clock, gh, local } = first;
  const { app } = await boot({ push, session, clock, gh, local, oldLogic: true, search: "?tab=review", hash: "#say" });
  assert.equal(app.reloads(), 0, "по кругу не перезагружаемся");
  assert.equal(app.screen(), "app");
  assert.equal(app.text("title"), "Сказать", "вкладка — как раньше, из #");
  await app.click({ act: "tab", tab: "today" });
  assert.equal(app.text("title"), "Задачи");
  assert.match(app.text("tab-today"), /^понедельник, 5 октября Сделано 2 из 5 Главная задача дня Записать первый урок /);
  assert.deepEqual(chips(app), [], "выбора дня в прежнем logic.js нет: показываем сегодня");
  assert.deepEqual(pushButtons(app), []);
  await app.click({ act: "task", id: taskByText(gh.state, "Записать первый урок").id });
  await app.flushTaps();
  await app.say("купить домен");
  await app.back();
  assert.deepEqual(gh.accepted.map((id) => gh.files.get(id).type), ["ops", "text"], "отметки и сообщения уходят");
  assert.deepEqual(push.log, [], "подписку не трогаем");
  assert.deepEqual(push.badges, [], "значок не трогаем");
});

test("приложение с экрана «Домой» на устройстве без пушей: о напоминаниях ни слова", async () => {
  const { app, gh } = await boot({ state: pushState() });
  assert.doesNotMatch(app.text("tab-today"), /апоминани|ведомлени/);
  app.press({ act: "push" });
  await settle();
  await app.wake();
  assert.deepEqual(gh.accepted, []);
});

test("воркер просит вкладку (нажали на уведомление при открытом приложении) — приложение её показывает", async () => {
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const { app, gh } = await boot({ push, state: pushState([hashOf(OLD)]) });
  assert.equal(app.text("title"), "Задачи");
  await app.swMessage({ type: "tab", tab: "say" });
  assert.equal(app.text("title"), "Сказать");
  assert.equal(app.el("tab-say").hidden, false);
  assert.equal(app.el("tab-today").hidden, true);
  for (const junk of [{ type: "tab", tab: "чужое" }, { type: "other", tab: "today" }, null, "say", {}]) {
    await app.swMessage(junk);
    assert.equal(app.text("title"), "Сказать", "непонятное сообщение ничего не меняет");
  }
  await app.swMessage({ type: "tab", tab: "today" });
  assert.equal(app.text("title"), "Задачи");
  assert.equal(app.el("tab-today").hidden, false);

  // уведомление о событии зовёт tasks: это та же вкладка, и показывает она сегодняшний день
  await app.click({ act: "day", date: FRIDAY });
  await app.click({ act: "tab", tab: "say" });
  await app.swMessage({ type: "tab", tab: "tasks" });
  assert.equal(app.text("title"), "Задачи");
  assert.equal(app.el("tab-today").hidden, false);
  assert.equal(app.el("tab-say").hidden, true);
  assert.deepEqual(pickedDay(app), [TODAY]);
  assert.deepEqual(gh.accepted, []);
});

test("значок приложения: открытые задачи на сегодня; ноль — значок убран", async () => {
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const { app, gh } = await boot({ push, state: pushState([hashOf(OLD)]) });
  assert.deepEqual(push.badges, [3]);
  await app.wake();
  await app.click({ act: "tab", tab: "goals" });
  assert.deepEqual(push.badges, [3], "число то же — значок не трогаем");
  await app.click({ act: "task", id: taskByText(gh.state, "Записать первый урок").id });
  assert.deepEqual(push.badges, [3, 2], "своя отметка сразу видна на значке");
  await app.back();
  assert.deepEqual(push.badges, [3, 2, 2], "после возврата ставим заново: значок мог поменять пуш");

  const done = JSON.parse(fixtureText).tasks.map((t) => (t.day === TODAY ? { ...t, status: "done" } : t));
  const cleared = fakePush({ permission: "granted", endpoint: OLD });
  await boot({ push: cleared, state: { tasks: done, ...pushState([hashOf(OLD)]) } });
  assert.deepEqual(cleared.badges, [0]);
});

// ---------- приложение целиком: «Задачи» по дням ----------

const taskIds = (app) => app.nodes("tab-today", "task").map((n) => n.dataset.id);

test("«Задачи»: полоса дней; нажатие на день показывает его задачи", async () => {
  const { app, gh } = await boot();
  assert.equal(app.text("title"), "Задачи");
  assert.equal(app.text("sub"), "понедельник, 5 октября");
  const strip = chips(app);
  assert.equal(strip.length, 18);
  assert.deepEqual(strip.slice(0, 9).map((c) => c.text), ["пт 2 1", "сб 3", "Вчера", "Сегодня 3", "Завтра 3", "ср 7", "чт 8", "пт 9 3", "сб 10"]);
  assert.deepEqual(pickedDay(app), [TODAY], "при запуске выбран сегодняшний день");
  assert.ok(app.text("tab-today").startsWith("пт 2 1 сб 3 Вчера Сегодня 3 Завтра 3 "), "полоса — вверху вкладки");
  assert.match(dayText(app), /^понедельник, 5 октября Сделано 2 из 5 Главная задача дня Записать первый урок Онлайн-курс · Уроки открыта Онлайн-курс 1\/2 /);
  assert.match(dayText(app), / Висят с прошлых дней 1 .* Ждут распределения 2 /);
  assert.equal(taskIds(app).length, 8, "главная, четыре в группах, одна висит, две ждут");

  // завтра: задачи трёх сфер с темой под каждой; у задачи с временем оно стоит перед текстом
  await app.click({ act: "day", date: TOMORROW });
  assert.deepEqual(pickedDay(app), [TOMORROW]);
  assert.equal(dayText(app), "вторник, 6 октября Сделано 0 из 3 " +
    "Онлайн-курс 0/1 Проверить оплату на сайте курса Сайт курса открыта " +
    "Канал 0/1 11:00 Созвониться с монтажёром Видео открыта " +
    "Быт и личное 0/1 Забрать посылку на почте Дом открыта");
  assert.equal(taskIds(app).length, 3);
  assert.equal(app.text("title"), "Задачи");
  assert.equal(app.text("sub"), "понедельник, 5 октября", "в шапке по-прежнему сегодняшний день");

  // пятница: событие в 15:30 — первым в своей сфере
  await app.click({ act: "day", date: FRIDAY });
  assert.deepEqual(pickedDay(app), [FRIDAY]);
  assert.equal(dayText(app), "пятница, 9 октября Сделано 0 из 3 " +
    "Канал 0/1 Выложить ролик о том, как устроен курс Видео открыта " +
    "Быт и личное 0/2 15:30 Стоматолог Здоровье открыта Купить продукты на неделю Дом открыта");

  // пустой день
  await app.click({ act: "day", date: "2026-10-07" });
  assert.equal(dayText(app), "среда, 7 октября Сделано 0 из 0 На этот день задач нет. Скажи, что поставить.");
  assert.deepEqual(taskIds(app), []);

  // прошедший день: что на нём осталось — нажимается; перенесённая с него видна, но не нажимается
  await app.click({ act: "day", date: "2026-10-03" });
  assert.equal(dayText(app), "суббота, 3 октября Сделано 1 из 2 " +
    "Онлайн-курс 1/1 Проверить сайт с телефона Сайт курса сделана " +
    "Канал 0/1 Снять короткий анонс курса Видео не сделана " +
    "Перенесены на другой день 1 Смонтировать ролик о том, как устроен курс перенесена на 5 октября · Канал · Видео");
  assert.deepEqual(taskIds(app), [taskByText(gh.state, "Проверить сайт с телефона").id, taskByText(gh.state, "Снять короткий анонс курса").id]);

  // главная задача, «висят» и «ждут» — только на сегодняшнем дне
  for (const date of [TOMORROW, FRIDAY, "2026-10-07", "2026-10-03", "2026-10-04"]) {
    await app.click({ act: "day", date });
    assert.doesNotMatch(dayText(app), /Главная задача дня|Висят с прошлых дней|Ждут распределения/, date);
  }
  await app.click({ act: "day", date: TODAY });
  assert.deepEqual(pickedDay(app), [TODAY]);
  assert.match(dayText(app), /^понедельник, 5 октября Сделано 2 из 5 Главная задача дня /);
  assert.match(dayText(app), / Висят с прошлых дней 1 .* Ждут распределения 2 /);
  assert.equal(chips(app).length, 18, "от выбора дня полоса не меняется");
  assert.deepEqual(gh.accepted, [], "выбор дня никуда не отправляется");
});

test("«Задачи»: нажатие на задачу другого дня уходит тем же файлом нажатий, что и раньше", async () => {
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const { app, gh, disk } = await boot({ push, state: pushState([hashOf(OLD)]) });
  const call = taskByText(gh.state, "Созвониться с монтажёром");
  const mark = gh.log.length;
  await app.click({ act: "day", date: TOMORROW });
  await app.click({ act: "task", id: call.id });   // открыта → сделана
  // видно сразу: в строке, в счёте дня и в числе на полосе
  assert.match(dayText(app), /^вторник, 6 октября Сделано 1 из 3 .* Канал 1\/1 11:00 Созвониться с монтажёром Видео сделана /);
  assert.deepEqual(chips(app).slice(3, 5).map((c) => c.text), ["Сегодня 3", "Завтра 2"]);
  assert.deepEqual(push.badges, [3], "значок приложения по-прежнему про сегодня");
  assert.deepEqual(gh.accepted, [], "отметки копятся");

  await app.flushTaps();
  const [id] = gh.accepted;
  assert.deepEqual(gh.log.slice(mark), ["PUT " + id, "POST dispatches"]);
  assert.deepEqual(gh.files.get(id), {
    id, sent_at: "2026-10-05T12:20:00+03:00", channel: "phone", type: "ops",
    ops: [{ op: "set_status", id: call.id, status: "done" }],
  });
  assert.equal(disk.read("pending")[call.id].batch, id);

  // тот же круг из трёх состояний; два нажатия подряд уходят одним файлом
  await app.click({ act: "task", id: call.id });   // сделана → не сделана
  assert.match(dayText(app), /11:00 Созвониться с монтажёром Видео не сделана /);
  await app.click({ act: "task", id: call.id });   // не сделана → открыта
  assert.match(dayText(app), /11:00 Созвониться с монтажёром Видео открыта /);
  assert.equal(chips(app)[4].text, "Завтра 3");
  await app.flushTaps();
  assert.equal(gh.accepted.length, 2);
  assert.deepEqual(gh.files.get(gh.accepted[1]).ops, [{ op: "set_status", id: call.id, status: "open" }]);

  // задача сегодняшнего дня уходит точно таким же файлом
  const today = await boot();
  const lesson = taskByText(today.gh.state, "Записать первый урок");
  await today.app.click({ act: "task", id: lesson.id });
  await today.app.flushTaps();
  const twin = today.gh.files.get(today.gh.accepted[0]);
  assert.deepEqual(twin, { ...gh.files.get(id), ops: [{ op: "set_status", id: lesson.id, status: "done" }] });
});

test("«Задачи»: прошедший день — открытая задача нажимается, перенесённая с него нет", async () => {
  const { app, gh } = await boot();
  await app.click({ act: "day", date: "2026-10-02" });
  const hang = taskByText(gh.state, "Ответить на вопросы под вступительным роликом");
  assert.equal(chips(app)[0].text, "пт 2 1");
  await app.click({ act: "task", id: hang.id });
  assert.match(dayText(app), /^пятница, 2 октября Сделано 3 из 3 /);
  assert.equal(chips(app)[0].text, "пт 2");
  await app.flushTaps();
  assert.deepEqual(gh.files.get(gh.accepted[0]).ops, [{ op: "set_status", id: hang.id, status: "done" }]);

  await app.click({ act: "day", date: "2026-10-03" });
  const gone = app.inner("tab-today", "day").textContent;
  assert.match(gone, /Смонтировать ролик о том, как устроен курс перенесена на 5 октября/);
  assert.ok(!taskIds(app).includes(taskByText(gh.state, "Смонтировать ролик о том, как устроен курс").id));
  assert.equal(gh.accepted.length, 1);
});

test("«Задачи»: выбор дня держится, пока идёт тот же день; наступил новый — выбран снова сегодняшний", async () => {
  const { app, gh, clock, local, session } = await boot();
  await app.click({ act: "day", date: FRIDAY });
  await app.back();                               // свернули и открыли в тот же день
  await app.wake();
  assert.deepEqual(pickedDay(app), [FRIDAY]);
  await app.click({ act: "tab", tab: "goals" });   // сходили на другую вкладку
  await app.click({ act: "tab", tab: "today" });
  assert.deepEqual(pickedDay(app), [FRIDAY]);
  assert.match(dayText(app), /^пятница, 9 октября /);

  clock.now = at("2026-10-06T00:00:30+03:00");     // полночь прошла, приложение открыли снова
  await app.back();
  assert.deepEqual(pickedDay(app), [TOMORROW], "новый день — выбран он");
  assert.equal(app.text("sub"), "вторник, 6 октября");
  const strip = chips(app);
  assert.deepEqual([strip[0].date, strip[17].date], ["2026-10-03", "2026-10-20"], "полоса сдвинулась на день");
  assert.deepEqual(strip.slice(2, 5).map((c) => c.text), ["Вчера 3", "Сегодня 3", "Завтра"]);
  // сводка ещё вчерашняя: главной на новый день нет, вчерашние открытые висят
  assert.match(dayText(app), /^вторник, 6 октября Сделано 0 из 3 Главная задача дня Не выбрана\. Скажи, какая задача сегодня главная\. /);
  assert.match(dayText(app), / Висят с прошлых дней 4 /);

  // новый запуск приложения — снова сегодня, что бы ни было выбрано раньше
  await app.click({ act: "day", date: FRIDAY });
  const again = await boot({ clock, gh, local, session });
  assert.deepEqual(pickedDay(again.app), [TOMORROW]);
});

test("«Задачи»: карточка напоминаний — только на сегодняшнем дне", async () => {
  const push = fakePush();
  const { app } = await boot({ push, state: pushState() });
  assert.deepEqual(pushButtons(app), [{ act: "push", text: "Включить", disabled: false }]);
  await app.click({ act: "day", date: TOMORROW });
  assert.deepEqual(pushButtons(app), []);
  assert.doesNotMatch(app.text("tab-today"), /апоминани/);
  await app.click({ act: "day", date: TODAY });
  assert.deepEqual(pushButtons(app), [{ act: "push", text: "Включить", disabled: false }]);
  assert.deepEqual(push.log, []);
});

test("«Задачи»: сводки сначала нет, потом она пришла — полоса и день на месте", async () => {
  const clock = { now: at("2026-10-05T12:20:00+03:00") };
  const gh = fakeGitHub(clock, null);
  const { app } = await boot({ gh, clock });
  assert.equal(app.text("tab-today"), "Сводки пока нет.");
  assert.deepEqual(chips(app), []);
  gh.state = JSON.parse(fixtureText);
  await app.wake();
  assert.equal(chips(app).length, 18);
  assert.deepEqual(pickedDay(app), [TODAY]);
  assert.match(dayText(app), /^понедельник, 5 октября Сделано 2 из 5 /);
  assert.doesNotMatch(app.text("tab-today"), /Сводки пока нет/);
});

test("«Задачи»: сводка от ядра, которое о времени и третьей сфере ещё не знает, показывается как раньше", async () => {
  const old = JSON.parse(fixtureText);
  old.areas = old.areas.filter((a) => a.id !== "personal");
  old.tasks = old.tasks.filter((t) => t.area !== "personal").map(({ time, ...t }) => t);
  const { app } = await boot({ state: old });
  assert.match(dayText(app), /^понедельник, 5 октября Сделано 2 из 5 Главная задача дня Записать первый урок /);
  await app.click({ act: "day", date: TOMORROW });
  assert.equal(dayText(app), "вторник, 6 октября Сделано 0 из 2 " +
    "Онлайн-курс 0/1 Проверить оплату на сайте курса Сайт курса открыта " +
    "Канал 0/1 Созвониться с монтажёром Видео открыта");
});

test("запас отдал новый app.js с logic.js прошлого выпуска (без выбора дня): «Задачи» показывают сегодня, остальное работает", async () => {
  for (const name of DAYS) assert.ok(name in L, name + " — есть в нынешнем logic.js");
  const push = fakePush({ permission: "granted", endpoint: OLD });
  const session = new FakeStorage();
  const first = await boot({ push, session, oldLogic: "days", state: pushState() });
  assert.equal(first.app.reloads(), 1, "версии разошлись — одна перезагрузка");
  assert.deepEqual(first.gh.log, []);

  const { clock, gh, local } = first;
  const { app } = await boot({ push, session, clock, gh, local, oldLogic: "days", search: "?tab=tasks" });
  assert.equal(app.reloads(), 0, "по кругу не перезагружаемся");
  assert.equal(app.text("title"), "Задачи");
  assert.equal(app.el("tab-today").hidden, false);
  assert.deepEqual(chips(app), [], "полосы дней нет");
  assert.match(app.text("tab-today"), /^понедельник, 5 октября Сделано 2 из 5 Главная задача дня Записать первый урок /);
  assert.match(app.text("tab-today"), / Висят с прошлых дней 1 .* Ждут распределения 2 /);
  // напоминания в том выпуске уже были: подписка чинится, значок ставится
  assert.deepEqual(push.log, ["subscribe"]);
  assert.deepEqual(push.badges, [3]);
  await app.click({ act: "task", id: taskByText(gh.state, "Записать первый урок").id });
  await app.flushTaps();
  await app.say("купить домен");
  assert.deepEqual(gh.accepted.map((id) => gh.files.get(id).type), ["ops", "ops", "text"], "подписка, отметка и сообщение ушли");
  assert.deepEqual(push.badges, [3, 2]);
  // воркер зовёт вкладку по-старому — работает; по новому имени прежний logic.js её не знает, и ничего не ломается
  await app.swMessage({ type: "tab", tab: "say" });
  await app.swMessage({ type: "tab", tab: "tasks" });
  assert.equal(app.text("title"), "Сказать");
  await app.swMessage({ type: "tab", tab: "today" });
  assert.equal(app.text("title"), "Задачи");
});


// ---------- сервис-воркер ----------

const page = (body, status = 200) => ({ body, status, ok: status >= 200 && status < 300, clone() { return page(body, status); } });
const PENDING = Symbol("ответа ещё нет");
const peek = (promise) => Promise.race([promise, settle().then(() => PENDING)]);

test("воркер: сеть молчит — через три секунды отвечает запасом, а запас обновляет в фоне", async () => {
  let arrive;
  const worker = startWorker({
    cached: { "app.js": page("старый") },
    fetch: () => new Promise((resolve) => { arrive = resolve; }),
  });
  const event = worker.request("app.js");
  assert.equal(await peek(event.response), PENDING, "сначала ждём сеть");
  assert.deepEqual(worker.timers.filter((t) => t.on).map((t) => t.ms), [3000]);
  await worker.fire();
  assert.equal((await peek(event.response)).body, "старый");

  arrive(page("новый"));   // сеть всё-таки ответила — уже после того, как страница получила запас
  await Promise.all(event.waits);
  assert.equal(worker.stored("app.js").body, "новый");
});

test("воркер: сеть только что молчала — остальные файлы оболочки идут из запаса сразу, без новых трёх секунд", async () => {
  const worker = startWorker({
    cached: { "index.html": page("страница"), "logic.js": page("логика"), "app.js": page("экраны") },
    fetch: () => new Promise(() => {}),
  });
  const first = worker.request("index.html");
  await worker.fire();
  assert.equal((await peek(first.response)).body, "страница");

  // страница запрашивает скрипты один за другим: ждать по три секунды на каждый — это пустой экран на десятки секунд
  const second = worker.request("logic.js");
  await settle();
  assert.deepEqual(worker.timers.map((t) => t.ms), [3000, 0]);
  await worker.fire();
  assert.equal((await peek(second.response)).body, "логика");

  // через десять секунд снова даём сети её три секунды
  worker.clock.now += 10001;
  worker.request("app.js");
  await settle();
  assert.deepEqual(worker.timers.map((t) => t.ms), [3000, 0, 3000]);
});

test("воркер: сеть молчит, а запаса нет — ждёт сеть", async () => {
  let arrive;
  const worker = startWorker({ fetch: () => new Promise((resolve) => { arrive = resolve; }) });
  const event = worker.request("app.js");
  await worker.fire();
  assert.equal(await peek(event.response), PENDING);
  arrive(page("новый"));
  assert.equal((await event.response).body, "новый");
});

test("воркер: свежий ответ отдаётся, даже если положить его в запас не вышло", async () => {
  const worker = startWorker({ cached: { "app.js": page("старый") }, fetch: async () => page("новый") });
  worker.putFails = true;
  const event = worker.request("app.js");
  assert.equal((await event.response).body, "новый");
  assert.equal(worker.stored("app.js").body, "старый");
});

test("воркер: сеть ответила вовремя — свежий ответ, запас обновлён, таймер снят", async () => {
  const asked = [];
  const worker = startWorker({
    cached: { "app.js": page("старый") },
    fetch: async (url, init) => { asked.push([url, init.cache]); return page("новый"); },
  });
  const event = worker.request("app.js?v=2#top");
  assert.equal((await event.response).body, "новый");
  assert.equal(worker.stored("app.js").body, "новый");
  assert.deepEqual(asked, [[worker.base + "app.js", "no-cache"]]);
  assert.deepEqual(worker.timers.filter((t) => t.on), []);
});

test("воркер: сети нет или сервер ответил ошибкой — запас; чужие адреса не трогает", async () => {
  const offline = startWorker({ cached: { "app.js": page("старый") }, fetch: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal((await offline.request("app.js").response).body, "старый");
  assert.equal((await offline.request("style.css").response).body, "network error", "нет ни сети, ни запаса");

  const broken = startWorker({ cached: { "app.js": page("старый") }, fetch: async () => page("сбой", 503) });
  assert.equal((await broken.request("app.js").response).body, "старый");
  assert.equal((await broken.request("style.css").response).status, 503);
  assert.equal(broken.stored("style.css"), undefined, "ошибку в запас не кладём");

  const event = broken.request("https://api.github.com/repos/owner/brain/contents/data/state.json");
  assert.equal(event.response, null, "запросы к GitHub идут мимо воркера");
});

test("воркер: имя запаса новое, прежний запас удаляется при обновлении", async () => {
  const before = ["brain-shell-v1", "brain-shell-v2", "brain-shell-v3"];   // запасы прежних выпусков приложения
  const worker = startWorker({ oldCaches: before, fetch: async () => page("новый") });
  assert.ok(!before.includes(worker.cacheName), "оболочка другая — запас под новым именем, иначе установленное приложение не обновится");
  await worker.activate();
  assert.deepEqual(worker.cacheNames(), [worker.cacheName]);
});

// ---------- сервис-воркер: напоминания ----------

const APP_URL = "https://example.test/brain-app/";   // где поддельный воркер держит приложение
const pushed = (notification) => ({ web_push: 8030, notification });
const MORNING = pushed({
  title: "План на сегодня", body: "Главная: Записать первый урок. Всего задач: 5. Висят с прошлых дней: 1.",
  navigate: APP_URL + "?tab=say", app_badge: "3",
});
const PLAIN = { title: "Мозг", body: "Открой приложение", icon: "icons/icon-192.png", data: { url: APP_URL + "?tab=say" } };

test("воркер: пуш показывает уведомление с адресом для нажатия и ставит значок", async () => {
  const worker = startWorker({});
  await worker.push(MORNING);
  assert.deepEqual(worker.shown, [{
    title: "План на сегодня", body: "Главная: Записать первый урок. Всего задач: 5. Висят с прошлых дней: 1.",
    icon: "icons/icon-192.png", data: { url: APP_URL + "?tab=say" },
  }]);
  assert.deepEqual(worker.badges, [3]);

  await worker.push(pushed({ title: "Закроем день?", body: "Сделано 5 из 5. Расскажи, что успел.", navigate: APP_URL + "?tab=say", app_badge: "0" }));
  assert.deepEqual(worker.shown[1], {
    title: "Закроем день?", body: "Сделано 5 из 5. Расскажи, что успел.", icon: "icons/icon-192.png", data: { url: APP_URL + "?tab=say" },
  });
  assert.deepEqual(worker.badges, [3, 0], "«0» убирает значок");

  // числа для значка нет — значок не трогаем, уведомление показываем
  await worker.push(pushed({ title: "План на сегодня", body: "На сегодня пока пусто. Скажи, что сегодня главное." }));
  await worker.push(pushed({ title: "План на сегодня", body: "", app_badge: "много" }));
  assert.equal(worker.shown.length, 4);
  assert.deepEqual([worker.shown[2].body, worker.shown[3].body], ["На сегодня пока пусто. Скажи, что сегодня главное.", ""]);
  assert.deepEqual(worker.badges, [3, 0]);
});

test("воркер: пуш не разобрался — всё равно показывает простое уведомление", async () => {
  const broken = ["не json", "{\"notification\":", "", undefined, null, [], 5, { web_push: 8030 }, { notification: "строка" },
    { notification: null }, { notification: { body: "без заголовка", navigate: APP_URL + "?tab=today", app_badge: "7" } },
    { notification: { title: 7, body: "заголовок не строка" } }, { notification: { title: "" } }];
  for (const payload of broken) {
    const worker = startWorker({});
    await worker.push(payload);
    assert.deepEqual(worker.shown, [PLAIN], JSON.stringify(payload) ?? "пуш без данных");
    assert.deepEqual(worker.badges, [], "значок по непонятному пушу не меняем");
  }
});

test("воркер: значков на устройстве нет или значок не поставился — уведомление всё равно показано", async () => {
  const without = startWorker({ badge: false });
  await without.push(MORNING);
  assert.equal(without.shown.length, 1);

  const failing = startWorker({});
  failing.badgeFails = true;
  await failing.push(MORNING);
  assert.equal(failing.shown.length, 1);
  assert.equal(failing.shown[0].title, "План на сегодня");
});

test("воркер: уведомление ведёт только внутрь приложения", async () => {
  const worker = startWorker({});
  const urlFor = async (navigate) => {
    await worker.push(pushed({ title: "План на сегодня", body: "", navigate }));
    return worker.shown[worker.shown.length - 1].data.url;
  };
  assert.equal(await urlFor(APP_URL + "?tab=today"), APP_URL + "?tab=today");
  assert.equal(await urlFor("?tab=review"), APP_URL + "?tab=review", "адрес без сайта — внутри приложения");
  assert.equal(await urlFor(undefined), APP_URL + "?tab=say");
  assert.equal(await urlFor(""), APP_URL + "?tab=say");
  assert.equal(await urlFor(42), APP_URL + "?tab=say");
  assert.equal(await urlFor("https://evil.example/brain-app/?tab=say"), APP_URL + "?tab=say");
  assert.equal(await urlFor("https://example.test/another-site/"), APP_URL + "?tab=say", "соседний сайт того же адреса — тоже чужой");
  assert.equal(await urlFor(APP_URL + "../another-site/"), APP_URL + "?tab=say");
  assert.equal(await urlFor("javascript:alert(1)"), APP_URL + "?tab=say");
});

test("воркер: нажатие на уведомление выводит открытое приложение вперёд и просит вкладку «Сказать»", async () => {
  const neighbour = fakeWindow("https://example.test/another-site/");
  const mine = fakeWindow(APP_URL + "#review");
  const worker = startWorker({ windows: [neighbour, mine] });
  const note = await worker.click({ url: APP_URL + "?tab=say" });
  assert.equal(note.closed, true);
  assert.equal(mine.focused, 1);
  assert.deepEqual(mine.messages, [{ type: "tab", tab: "say" }]);
  assert.deepEqual(worker.opened, [], "второе окно не открываем");
  assert.deepEqual([neighbour.focused, neighbour.messages.length], [0, 0], "соседний сайт не трогаем");

  // вкладка берётся из адреса уведомления; адреса нет вовсе (простое уведомление) — «Сказать»
  await worker.click({ url: APP_URL + "?tab=today" });
  await worker.click(undefined);
  await worker.click({ url: "https://evil.example/" });
  assert.deepEqual(mine.messages.map((m) => m.tab), ["say", "today", "say", "say"]);
  assert.equal(mine.focused, 4);
  assert.deepEqual(worker.opened, []);
});

test("воркер: приложение закрыто — нажатие открывает его по адресу из уведомления", async () => {
  const worker = startWorker({ windows: [fakeWindow("https://example.test/another-site/")] });
  const note = await worker.click({ url: APP_URL + "?tab=say" });
  assert.equal(note.closed, true);
  assert.deepEqual(worker.opened, [APP_URL + "?tab=say"]);
  await worker.click(undefined);
  await worker.click({ url: "https://evil.example/" });
  assert.deepEqual(worker.opened, [APP_URL + "?tab=say", APP_URL + "?tab=say", APP_URL + "?tab=say"], "чужой адрес не открываем");

  // окно есть, но вывести его вперёд система не дала — открываем заново
  const stuck = fakeWindow(APP_URL, { focusFails: true });
  const second = startWorker({ windows: [stuck] });
  await second.click({ url: APP_URL + "?tab=say" });
  assert.deepEqual(second.opened, [APP_URL + "?tab=say"]);
  assert.deepEqual(stuck.messages, [{ type: "tab", tab: "say" }]);
});

test("воркер: уведомление, собранное по договорённости с ядром, ведёт на «Сказать» настоящего приложения", async () => {
  const live = "https://toqusif000-ui.github.io/brain-app/";
  const mine = fakeWindow(live);
  const worker = startWorker({ base: live, windows: [fakeWindow("https://toqusif000-ui.github.io/"), mine] });
  await worker.push({ web_push: 8030, notification: { title: "Закроем день?", body: "Задач на сегодня не было. Расскажи, что сделал за день.", navigate: live + "?tab=say", app_badge: "0" } });
  assert.deepEqual(worker.shown, [{
    title: "Закроем день?", body: "Задач на сегодня не было. Расскажи, что сделал за день.",
    icon: "icons/icon-192.png", data: { url: "https://toqusif000-ui.github.io/brain-app/?tab=say" },
  }]);
  assert.deepEqual(worker.badges, [0]);
  await worker.click(worker.shown[0].data);
  assert.deepEqual(mine.messages, [{ type: "tab", tab: "say" }]);
  assert.equal(L.startTab(new URL(worker.shown[0].data.url).search, ""), "say", "тот же адрес понимает и само приложение");
});

test("воркер: уведомление о событии ведёт на «Задачи» — и в открытом приложении, и в закрытом", async () => {
  const live = "https://toqusif000-ui.github.io/brain-app/";
  const event = { web_push: 8030, notification: { title: "Скоро: Стоматолог", body: "Сегодня в 15:30.", navigate: live + "?tab=tasks", app_badge: "3" } };
  const mine = fakeWindow(live + "?tab=say");
  const worker = startWorker({ base: live, windows: [mine] });
  await worker.push(event);
  assert.deepEqual(worker.shown, [{
    title: "Скоро: Стоматолог", body: "Сегодня в 15:30.", icon: "icons/icon-192.png",
    data: { url: "https://toqusif000-ui.github.io/brain-app/?tab=tasks" },
  }]);
  assert.deepEqual(worker.badges, [3]);
  await worker.click(worker.shown[0].data);
  assert.deepEqual(mine.messages, [{ type: "tab", tab: "tasks" }]);
  assert.equal(mine.focused, 1);
  assert.deepEqual(worker.opened, []);

  const closed = startWorker({ base: live });
  await closed.push(event);
  await closed.click(closed.shown[0].data);
  assert.deepEqual(closed.opened, [live + "?tab=tasks"]);
  assert.equal(L.startTab(new URL(closed.opened[0]).search, ""), "today", "этот адрес приложение открывает на «Задачах»");
  assert.equal(L.tabId(mine.messages[0].tab), "today", "и эту просьбу воркера понимает так же");
});
