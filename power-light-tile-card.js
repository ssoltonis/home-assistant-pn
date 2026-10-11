class PowerLightTileCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Power light tile requires an entity.");
    }
    this._config = { ...config };
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      ha-card { display: flex; align-items: center; overflow: hidden; height: 100%; }
      .tile { flex: 1; min-width: 0; --ha-card-border-width: 0;
        --ha-card-box-shadow: none; --ha-card-background: transparent; }
      .power { padding: 0 12px 0 0; white-space: nowrap; flex-shrink: 0;
        font-size: 14px; color: var(--secondary-text-color); }
      .power[hidden] { display: none; }
      .power.error { color: var(--error-color, #db4437); }
    `;
    this._card = document.createElement("ha-card");
    this._power = document.createElement("span");
    this._power.className = "power";
    this._power.hidden = true;
    this._power.setAttribute("aria-live", "polite");
    this._card.append(this._power);
    this.shadowRoot.replaceChildren(style, this._card);
    this._tile = undefined;
    this._createTile(this._config);
    this._updatePower();
  }

  async _createTile(config) {
    try {
      const helpers = await window.loadCardHelpers();
      if (config !== this._config) return;
      const { power_entity, type, ...tileConfig } = config;
      this._tile = helpers.createCardElement({ ...tileConfig, type: "tile" });
      this._tile.className = "tile";
      if (this._hass) this._tile.hass = this._hass;
      this._card.prepend(this._tile);
    } catch (error) {
      if (config !== this._config) return;
      const alert = document.createElement("ha-alert");
      alert.setAttribute("alert-type", "error");
      alert.textContent = `Unable to load light tile: ${error.message}`;
      this._card.prepend(alert);
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._tile) this._tile.hass = hass;
    this._updatePower();
  }

  getCardSize() {
    return this._tile ? this._tile.getCardSize() : 1;
  }

  getGridOptions() {
    return this._tile && this._tile.getGridOptions
      ? this._tile.getGridOptions()
      : { columns: 6, rows: 1 };
  }

  _updatePower() {
    if (!this._config || !this._hass) return;
    const light = this._hass.states[this._config.entity];
    this._power.hidden = !this._config.power_entity || !light || light.state !== "on";
    if (this._power.hidden) {
      this._power.textContent = "";
      return;
    }
    const power = this._hass.states[this._config.power_entity];
    const invalid = !power || power.state.trim() === "" || !Number.isFinite(Number(power.state));
    this._power.className = invalid ? "power error" : "power";
    if (invalid) {
      const state = power && power.state === "unknown" ? "unknown" : "unavailable";
      this._power.textContent = this._hass.localize(`state.default.${state}`) || state;
      this._power.setAttribute("title", `${this._config.power_entity}: ${power ? power.state : "missing"}`);
      return;
    }
    const unit = power.attributes.unit_of_measurement || "";
    this._power.textContent = `${power.state}${unit ? ` ${unit}` : ""}`;
    this._power.setAttribute("title", `${power.attributes.friendly_name || this._config.power_entity}: ${this._power.textContent}`);
  }
}

customElements.define("power-light-tile-card", PowerLightTileCard);
