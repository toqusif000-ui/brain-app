// Тесты чистых функций и — в конце файла — app.js и sw.js целиком в поддельном окружении (harness.mjs).
// Запуск из папки приложения: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import L from "../logic.js";
import { FakeStorage, fakeGitHub, settle, startApp, startWorker } from "./harness.mjs";

const fixtureText = readFileSync(new URL("../mock/state.json", import.meta.url), "utf8");
const fixture = () => L.parseState(fixtureText);
const TODAY = "2026-10-05";
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
  assert.equal(fixture().tasks.length, 22);
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

  // две сферы с темами
  assert.equal(s.areas.length, 2);
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
    assert.deepEqual(Object.keys(t), ["id", "text", "area", "topic", "goal", "day", "days", "status", "created_at", "closed_at"]);
    assert.match(t.id, /^t-[0-9a-f]{8}$/);
    assert.ok(!ids.has(t.id), "повтор id " + t.id);
    ids.add(t.id);
    assert.ok(areas.has(t.area));
    assert.ok(t.topic === null || topics.has(t.topic));
    assert.ok(["open", "done", "fail"].includes(t.status));
    assert.equal(t.day, t.days.length ? t.days[t.days.length - 1] : null, "day — последний из days");
    assert.deepEqual([...t.days].sort(), t.days, "дни по порядку");
    for (const d of t.days) assert.match(d, date);
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

  // задачи на сегодня в обеих сферах, главная — одна из них
  const todays = s.tasks.filter((t) => t.day === TODAY);
  assert.deepEqual(new Set(todays.map((t) => t.area)), areas);
  assert.ok(todays.some((t) => t.id === s.main));
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
  // каждый день, на который что-то запланировано, есть в таблице
  for (const t of s.tasks) for (const d of t.days) assert.ok(s.days.some((x) => x.date === d), d);

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
  assert.equal(vm.total, 0);
  assert.deepEqual(vm.groups, []);
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
  assert.deepEqual(vm.map((a) => [a.title, a.goals.length]), [["Онлайн-курс", 1], ["Канал", 0]]);
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

// ---------- приложение целиком: отправка ----------

// Открывает приложение с уже вставленным ключом (key: false — без ключа, на экране настройки).
// По умолчанию оно установлено на экран «Домой»; home: false — обычная вкладка браузера.
async function boot(options = {}) {
  const clock = options.clock || { now: at("2026-10-05T12:20:00+03:00") };
  const gh = options.gh || fakeGitHub(clock, { ...JSON.parse(fixtureText), ...options.state });
  const local = options.local || new FakeStorage();
  const session = options.session || new FakeStorage();
  const home = options.home !== false;
  const disk = home || options.ios ? local : session;   // где приложение должно держать своё
  if (options.key !== false) disk.setItem("brain:token", JSON.stringify("KEY"));
  const app = startApp({ clock, gh, local, session, home, ios: options.ios });
  await settle();
  return { app, gh, clock, local, session, disk };
}
const queued = (disk) => disk.read("outbox").filter((e) => e.state === "queued");

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
  const worker = startWorker({ oldCaches: ["brain-shell-v1"], fetch: async () => page("новый") });
  assert.notEqual(worker.cacheName, "brain-shell-v1");
  await worker.activate();
  assert.deepEqual(worker.cacheNames(), [worker.cacheName]);
});
