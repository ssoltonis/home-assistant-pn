const assert = require("assert").strict;
const fs = require("fs");
const vm = require("vm");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
  }
  attachShadow() {
    this.shadowRoot = new Element("shadow");
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }
  click() {
    if (!this.disabled) this.listeners.click();
  }
}

let Card;
vm.runInNewContext(fs.readFileSync(require("path").join(__dirname, "doorbell-records-card.js"), "utf8"), {
  HTMLElement: Element,
  document: { createElement: (tag) => new Element(tag) },
  customElements: { define: (_name, constructor) => { Card = constructor; } },
});

const records = Array.from({ length: 52 }, (_, i) =>
  `/local/doorbell/doorbell_20261011_1833${String(i).padStart(2, "0")}.mp4`
);
const state = (items, value = String(items.length), extra = {}) => ({
  states: { "sensor.doorbell_records": { state: value, attributes: { records: items, ...extra } } },
});
const makeCard = () => {
  const card = new Card();
  card.setConfig({ entity: "sensor.doorbell_records", page_size: 10 });
  return card;
};
const rows = (card) => card.shadowRoot.children[1].children.filter((e) => e.className === "clip");
const nav = (card) => card.shadowRoot.children[1].children.find((e) => e.tag === "nav").children;

const card = makeCard();
card.hass = state(records.map((video) => ({ video })));
assert.equal(rows(card).length, 10);
assert.equal(nav(card)[1].textContent, "Page 1 of 6 (52 clips)");
assert.equal(nav(card)[0].disabled, true);
const visited = [];
for (let page = 0; page < 6; page++) {
  assert.equal(rows(card).length, page === 5 ? 2 : 10);
  for (const row of rows(card)) {
    const thumbnail = row.children[0];
    const play = row.children[1].children[1];
    assert.equal(play.target, "_blank");
    assert.equal(play.rel, "noopener noreferrer");
    assert.equal(thumbnail.href, play.href);
    visited.push(play.href);
  }
  if (page < 5) nav(card)[2].click();
}
assert.equal(new Set(visited).size, 52);
assert.deepEqual(visited, [...records].sort().reverse());
assert.equal(nav(card)[2].disabled, true);
nav(card)[0].click();
assert.equal(nav(card)[1].textContent, "Page 5 of 6 (52 clips)");

const independent = makeCard();
independent.hass = state(records);
assert.equal(nav(independent)[1].textContent, "Page 1 of 6 (52 clips)");
card.hass = state(records.slice(0, 11));
assert.equal(nav(card)[1].textContent, "Page 2 of 2 (11 clips)");
assert.equal(rows(card).length, 1);
nav(card)[0].click();
assert.equal(rows(card).length, 10);
card.hass = state([]);
assert.equal(card._page, 0);
assert.equal(card.shadowRoot.children[1].children[0].textContent, "No recordings found.");
card.hass = state(records.slice(0, 10));
assert.equal(nav(card)[2].disabled, true);
card.hass = state([records[0], records[0], { file_name: records[1] }, "thumb_20261011_183300.jpg", null]);
assert.equal(rows(card).length, 2);
card.hass = state([], "unavailable");
assert.equal(card.shadowRoot.children[1].children[0].role, "alert");
card.hass = state([], "0", { error: "Unable to read directory" });
assert.match(card.shadowRoot.children[1].children[0].textContent, /Unable to read directory/);
card.hass = state([], "0", { records: undefined });
assert.match(card.shadowRoot.children[1].children[0].textContent, /no records list/);
card.hass = { states: {} };
assert.match(card.shadowRoot.children[1].children[0].textContent, /not available/);
assert.throws(() => card.setConfig({}), /requires an entity/);
assert.throws(() => card.setConfig({ entity: "sensor.doorbell_records", page_size: 0 }), /positive integer/);
console.log("Passed: ten-per-page boundaries, every clip reachable, sorting, independent pages, cleanup, links and errors.");
