const assert = require("assert").strict;
const fs = require("fs");
const vm = require("vm");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
  }
  attachShadow() { this.shadowRoot = new Element("shadow"); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
}

let Card;
let failLoad = false;
vm.runInNewContext(fs.readFileSync(`${__dirname}\\power-light-tile-card.js`, "utf8"), {
  HTMLElement: Element,
  document: { createElement: (tag) => new Element(tag) },
  customElements: { define: (_name, constructor) => { Card = constructor; } },
  window: {
    loadCardHelpers: async () => {
      if (failLoad) throw new Error("Test loader failure");
      return {
        createCardElement: (config) => {
          const tile = new Element("hui-tile-card");
          tile.config = config;
          tile.getCardSize = () => 1;
          tile.getGridOptions = () => ({ columns: 6, rows: 1 });
          return tile;
        },
      };
    },
  },
});

const config = {
  type: "custom:power-light-tile-card",
  entity: "switch.living",
  power_entity: "sensor.living_power",
  name: "Living",
  icon: "mdi:lightbulb",
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const hass = (light, power = "42.5", unit = "W") => ({
  states: {
    "switch.living": { state: light },
    "sensor.living_power": { state: power, attributes: { unit_of_measurement: unit } },
  },
  localize: (key) => ({ "state.default.unknown": "Unknown", "state.default.unavailable": "Unavailable" })[key],
});

(async () => {
  assert.throws(() => new Card().setConfig({}), /requires an entity/);
  const card = new Card();
  card.setConfig(config);
  const current = hass("on");
  card.hass = current;
  await flush();
  assert.equal(card._tile.config.type, "tile");
  assert.equal(card._tile.config.entity, config.entity);
  assert.equal(card._tile.config.name, config.name);
  assert.equal(card._tile.config.icon, config.icon);
  assert.equal(card._tile.config.power_entity, undefined);
  assert.equal(card._tile.config.tap_action, undefined, "Keep native tile actions");
  assert.equal(card._tile.hass, current);
  assert.equal(card._card.children[0], card._tile);
  assert.equal(card._card.children[1], card._power, "Power is on the right of the tile");
  assert.equal(card.getCardSize(), 1);
  assert.equal(card.getGridOptions().rows, 1);
  assert.equal(card.getGridOptions().columns, 6);
  assert.equal(card._power.hidden, false);
  assert.equal(card._power.textContent, "42.5 W");
  card.hass = hass("on", "0");
  assert.equal(card._power.textContent, "0 W");
  card.hass = hass("on", "0.12", "kW");
  assert.equal(card._power.textContent, "0.12 kW");
  for (const state of ["off", "unknown", "unavailable"]) {
    card.hass = hass(state);
    assert.equal(card._power.hidden, true);
    assert.equal(card._power.textContent, "");
  }
  card.hass = { ...hass("on"), states: {} };
  assert.equal(card._power.hidden, true);
  for (const state of ["unknown", "unavailable", "invalid", ""]) {
    card.hass = hass("on", state);
    assert.equal(card._power.hidden, false);
    assert.equal(card._power.className, "power error");
    assert.equal(card._power.textContent, state === "unknown" ? "Unknown" : "Unavailable");
  }
  const missing = hass("on");
  delete missing.states["sensor.living_power"];
  card.hass = missing;
  assert.equal(card._power.textContent, "Unavailable");
  assert.match(card._power.title, /missing/);
  card.hass = hass("on", "25");
  assert.equal(card._power.className, "power");
  assert.equal(card._power.textContent, "25 W");
  const noSensor = new Card();
  noSensor.setConfig({ entity: "switch.living" });
  noSensor.hass = hass("on");
  await flush();
  assert.equal(noSensor._power.hidden, true);
  assert.equal(noSensor._power.textContent, "");
  assert.equal(noSensor._tile.config.entity, "switch.living");
  noSensor.setConfig(config);
  noSensor.hass = hass("on");
  await flush();
  assert.equal(noSensor._power.hidden, false);
  assert.equal(noSensor._power.textContent, "42.5 W");
  const led = new Card();
  led.setConfig({
    type: "custom:power-light-tile-card",
    entity: "light.sonoff_100139f4f2",
    name: "Living LED",
    icon: "mdi:led-strip-variant",
    color: "amber",
  });
  for (const state of ["on", "off"]) {
    const current = {
      states: { "light.sonoff_100139f4f2": { state, attributes: {} } },
      localize: () => "",
    };
    led.hass = current;
    await flush();
    assert.equal(led._tile.config.type, "tile");
    assert.equal(led._tile.config.entity, "light.sonoff_100139f4f2");
    assert.equal(led._tile.config.icon, "mdi:led-strip-variant");
    assert.equal(led._tile.config.color, "amber");
    assert.equal(led._tile.hass, current);
    assert.equal(led._power.hidden, true);
    assert.equal(led._power.textContent, "");
    assert.equal(led._card.children.length, 2);
  }
  const independent = new Card();
  independent.setConfig({ ...config, entity: "switch.dining", power_entity: "sensor.dining_power" });
  independent.hass = {
    ...hass("on"),
    states: {
      "switch.dining": { state: "off" },
      "sensor.dining_power": { state: "9", attributes: { unit_of_measurement: "W" } },
    },
  };
  await flush();
  assert.equal(independent._power.hidden, true);
  assert.equal(card._power.textContent, "25 W");
  const reconfigured = new Card();
  reconfigured.setConfig(config);
  reconfigured.setConfig({ ...config, name: "Updated" });
  await flush();
  assert.equal(reconfigured._card.children.length, 2);
  assert.equal(reconfigured._tile.config.name, "Updated");
  failLoad = true;
  const failed = new Card();
  failed.setConfig(config);
  await flush();
  assert.equal(failed._card.children[0].tag, "ha-alert");
  assert.match(failed._card.children[0].textContent, /Test loader failure/);
  console.log("Passed: native compact tile, actions, right-side live power, optional sensor, on/off gating, units, zero, errors, independent switches and async loading.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
