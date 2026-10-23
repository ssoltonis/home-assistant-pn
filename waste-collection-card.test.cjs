process.env.TZ = "Europe/Vilnius";
const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
  }
  attachShadow() { this.shadowRoot = new Element("shadow"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  click() { if (!this.disabled) this.listeners.click(); }
}

let Card;
const pushed = [];
const dispatched = [];
const window = {
  location: { pathname: "/lovelace/home" },
  history: { pushState: (_state, _title, url) => pushed.push(url) },
  dispatchEvent: (event) => dispatched.push(event),
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "waste-collection-card.js"), "utf8"), {
  HTMLElement: Element,
  document: { createElement: (tag) => new Element(tag) },
  customElements: { define: (_name, constructor) => { Card = constructor; } },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  window,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const all = (node, predicate, found = []) => {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) all(child, predicate, found);
  return found;
};
const byClass = (card, name) => all(card.shadowRoot, (e) => typeof e.className === "string" && e.className.split(" ").includes(name));
const text = (card, name) => byClass(card, name).map((e) => e.textContent);
const allDay = (date, summary, uid = summary) => ({ start: { date }, end: { date: nextDay(date) }, summary, uid });
const nextDay = (date) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const makeHass = (events, calls, options = {}) => ({
  states: options.missing ? {} : { "calendar.kauno_svara": { state: "off", last_updated: options.updated || "1", attributes: {} } },
  locale: { language: "en-GB" },
  callApi: (method, url) => {
    calls.push({ method, url });
    if (options.fail) return Promise.reject(new Error("Calendar offline"));
    return Promise.resolve(typeof events === "function" ? events(url) : events);
  },
});
const makeCard = (config, now) => {
  const card = new Card();
  card._now = () => now.value;
  card.setConfig({ entity: "calendar.kauno_svara", ...config });
  return card;
};

(async () => {
  const { parseMoment, normalizeEvents } = Card.helpers;
  // All-day dates are local midnight, not UTC midnight.
  assert.equal(parseMoment({ date: "2026-10-24" }).date.getTime(), new Date(2026, 9, 24).getTime());
  assert.equal(parseMoment({ dateTime: "2026-10-24T06:00:00+03:00" }).allDay, false);
  assert.equal(parseMoment({}), undefined);
  const normalized = normalizeEvents([
    allDay("2026-10-25", "Plastikas"), allDay("2026-10-24", "Mišrios"), allDay("2026-10-24", "Mišrios"),
    { start: { date: "2026-10-26" }, summary: "" }, null, { summary: "no start" },
  ]);
  assert.deepEqual(Array.from(normalized, (e) => e.summary), ["Mišrios", "Plastikas", "Waste collection"]);
  assert.equal(normalized[2].end.getTime(), new Date(2026, 9, 27).getTime());

  // --- Upcoming mode: today + tomorrow only, past events hidden ---
  const now = { value: new Date(2026, 9, 23, 20, 0) };
  const calls = [];
  const events = [
    allDay("2026-10-22", "Yesterday"),
    allDay("2026-10-23", "Mišrios atliekos"),
    { start: { dateTime: "2026-10-23T08:00:00+03:00" }, end: { dateTime: "2026-10-23T10:00:00+03:00" }, summary: "Finished" },
    allDay("2026-10-24", "Plastikas"),
    allDay("2026-10-24", "Stiklas"),
    allDay("2026-10-25", "Day after tomorrow"),
  ];
  const card = makeCard({ navigation_path: "main_calendar" }, now);
  card.hass = makeHass(events, calls);
  assert.deepEqual(text(card, "empty"), ["Loading…"]);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `calendars/calendar.kauno_svara?start=${encodeURIComponent(now.value.toISOString())}`
    + `&end=${encodeURIComponent(new Date(2026, 9, 25).toISOString())}`);
  assert.deepEqual(text(card, "summary"), ["Mišrios atliekos", "Plastikas", "Stiklas"]);
  const when = text(card, "when");
  assert.match(when[0], /^Today · /);
  assert.match(when[1], /^Tomorrow · /);
  assert.equal(byClass(card, "today").length, 1);
  assert.equal(card.hidden, false);

  // Repeated hass updates do not refetch until the calendar or day changes.
  card.hass = makeHass(events, calls);
  assert.equal(calls.length, 1);
  card.hass = makeHass(events, calls, { updated: "2" });
  await flush();
  assert.equal(calls.length, 2);

  // Calendar button navigates within the current dashboard.
  const button = all(card.shadowRoot, (e) => e.tag === "button")[0];
  assert.equal(button["aria-label"], "Open waste collection calendar");
  button.click();
  assert.deepEqual(pushed, ["/lovelace/main_calendar"]);
  assert.equal(dispatched[0].type, "location-changed");
  const absolute = makeCard({ navigation_path: "/dashboard-home/main_calendar" }, now);
  absolute.hass = makeHass(events, []);
  await flush();
  all(absolute.shadowRoot, (e) => e.tag === "button")[0].click();
  assert.equal(pushed[1], "/dashboard-home/main_calendar");
  const noButton = makeCard({}, now);
  noButton.hass = makeHass([], []);
  await flush();
  assert.equal(all(noButton.shadowRoot, (e) => e.tag === "button").length, 0);

  // Nothing pending: message by default, hidden with hide_when_empty.
  assert.deepEqual(text(noButton, "empty"), ["No waste collection today or tomorrow."]);
  assert.equal(noButton.hidden, false);
  const hiding = makeCard({ hide_when_empty: true }, now);
  hiding.hass = makeHass([allDay("2026-10-22", "Past")], []);
  await flush();
  assert.equal(hiding.hidden, true);

  // A timed event that ends drops out on the next hass update without refetching.
  const timedNow = { value: new Date(2026, 9, 23, 6, 0) };
  const timedCalls = [];
  const timed = makeCard({ refresh_interval: 120 }, timedNow);
  timed.hass = makeHass([{ start: { dateTime: "2026-10-23T06:00:00+03:00" }, end: { dateTime: "2026-10-23T07:00:00+03:00" }, summary: "Truck" }], timedCalls);
  await flush();
  assert.deepEqual(text(timed, "summary"), ["Truck"]);
  assert.match(text(timed, "when")[0], /Today .* 06:00$/);
  timedNow.value = new Date(2026, 9, 23, 7, 30);
  timed.hass = makeHass([], timedCalls);
  assert.equal(timedCalls.length, 1);
  assert.deepEqual(text(timed, "summary"), []);

  // Errors are reported, not thrown.
  const failing = makeCard({}, now);
  failing.hass = makeHass([], [], { fail: true });
  await flush();
  assert.equal(byClass(failing, "error")[0].role, "alert");
  assert.match(byClass(failing, "error")[0].textContent, /Calendar offline/);
  const missing = makeCard({}, now);
  missing.hass = makeHass([], [], { missing: true });
  assert.match(byClass(missing, "error")[0].textContent, /not available/);

  // Stale responses are ignored.
  let release;
  const slowCard = makeCard({}, now);
  const slowCalls = [];
  slowCard.hass = { ...makeHass([], slowCalls), callApi: () => new Promise((resolve) => { release = resolve; }) };
  const firstRelease = await flush().then(() => release);
  slowCard.hass = makeHass([allDay("2026-10-24", "Fresh")], slowCalls, { updated: "new" });
  await flush();
  firstRelease([allDay("2026-10-24", "Stale")]);
  await flush();
  assert.deepEqual(text(slowCard, "summary"), ["Fresh"]);

  // --- Month mode: grid + agenda without past events, month navigation ---
  const monthCalls = [];
  const monthEvents = (url) => {
    const start = new Date(decodeURIComponent(/start=([^&]+)/.exec(url)[1]));
    return start.getMonth() === 9
      ? [allDay("2026-10-05", "Past"), allDay("2026-10-23", "Mišrios"), allDay("2026-10-30", "Plastikas"),
        { start: { date: "2026-10-31" }, end: { date: "2026-11-02" }, summary: "Two days" }]
      : [allDay("2026-11-06", "Stiklas")];
  };
  const month = makeCard({ mode: "month" }, now);
  month.hass = makeHass(monthEvents, monthCalls);
  await flush();
  assert.equal(monthCalls[0].url, `calendars/calendar.kauno_svara?start=${encodeURIComponent(now.value.toISOString())}`
    + `&end=${encodeURIComponent(new Date(2026, 10, 1).toISOString())}`);
  assert.deepEqual(text(month, "summary"), ["Mišrios", "Plastikas", "Two days"]);
  assert.deepEqual(text(month, "month-label"), ["October 2026"]);
  assert.equal(byClass(month, "blank").length, 3); // 1 Oct 2026 is a Thursday
  const days = byClass(month, "day").filter((e) => !e.className.includes("blank"));
  assert.equal(days.length, 31);
  assert.deepEqual(byClass(month, "has-event").map((e) => e["data-date"]), ["2026-10-23", "2026-10-30", "2026-10-31"]);
  assert.equal(byClass(month, "past").length, 22);
  assert.deepEqual(byClass(month, "today").filter((e) => e.tag === "div").map((e) => e["data-date"]), ["2026-10-23"]);
  assert.deepEqual(text(month, "chip"), ["Mišrios", "Plastikas", "Two days"]);
  let [previous, , next] = byClass(month, "month-nav")[0].children;
  assert.equal(previous.disabled, true);
  next.click();
  assert.deepEqual(text(month, "empty"), ["Loading…"]);
  await flush();
  assert.equal(monthCalls[1].url, `calendars/calendar.kauno_svara?start=${encodeURIComponent(new Date(2026, 10, 1).toISOString())}`
    + `&end=${encodeURIComponent(new Date(2026, 11, 1).toISOString())}`);
  assert.deepEqual(text(month, "month-label"), ["November 2026"]);
  assert.deepEqual(text(month, "summary"), ["Stiklas"]);
  assert.equal(byClass(month, "blank").length, 6); // 1 Nov 2026 is a Sunday
  assert.equal(byClass(month, "past").length, 0);
  [previous, , next] = byClass(month, "month-nav")[0].children;
  assert.equal(previous.disabled, false);
  const thisMonth = all(month.shadowRoot, (e) => e.tag === "button" && e.textContent === "This month")[0];
  thisMonth.click();
  await flush();
  assert.deepEqual(text(month, "month-label"), ["October 2026"]);
  const empty = makeCard({ mode: "month" }, now);
  empty.hass = makeHass([allDay("2026-10-05", "Past")], []);
  await flush();
  assert.deepEqual(text(empty, "empty"), ["No upcoming waste collection this month."]);

  // Config validation.
  assert.throws(() => new Card().setConfig({}), /requires a calendar entity/);
  assert.throws(() => new Card().setConfig({ entity: "sensor.x" }), /requires a calendar entity/);
  assert.throws(() => new Card().setConfig({ entity: "calendar.kauno_svara", mode: "week" }), /mode must be/);
  assert.throws(() => new Card().setConfig({ entity: "calendar.kauno_svara", refresh_interval: 0 }), /refresh_interval/);
  console.log("Passed: today/tomorrow filtering, past events hidden, refetch rules, navigation, month grid and paging, errors.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
