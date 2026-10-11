class DoorbellRecordsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._page = 0;
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Doorbell records card requires an entity.");
    }
    const pageSize = config.page_size === undefined ? 10 : config.page_size;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error("page_size must be a positive integer.");
    }
    this._config = { entity: config.entity, page_size: pageSize };
    this._page = 0;
    this._state = undefined;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const state = hass.states[this._config.entity];
    if (this._state === state) return;
    this._state = state;
    this._render();
  }

  getCardSize() {
    return 5;
  }

  _element(tag, text) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  _link(filename) {
    const link = this._element("a");
    link.href = `/local/doorbell/${encodeURIComponent(filename)}`;
    // A same-origin link without a target can be intercepted by HA's router.
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  _render() {
    if (!this._config) return;
    const style = this._element("style");
    style.textContent = `
      :host { display: block; }
      ha-card { padding: 16px; color: var(--primary-text-color); }
      .clip { display: flex; align-items: center; gap: 12px; padding: 10px 0;
        border-bottom: 1px solid var(--divider-color); }
      .thumbnail { flex-shrink: 0; }
      img { display: block; width: 96px; height: 54px; object-fit: cover; border-radius: 4px; }
      time { display: block; margin-bottom: 6px; font-weight: 500; }
      a { color: var(--primary-color); }
      nav { display: flex; align-items: center; justify-content: space-between;
        flex-wrap: wrap; gap: 8px; margin-top: 16px; }
      button { font: inherit; color: var(--primary-text-color); background: var(--card-background-color);
        border: 1px solid var(--divider-color); border-radius: 6px; padding: 8px 12px; cursor: pointer; }
      button:disabled { opacity: 0.45; cursor: default; }
      .error { color: var(--error-color, #db4437); }
    `;
    const card = this._element("ha-card");
    this.shadowRoot.replaceChildren(style, card);
    const state = this._hass && this._hass.states[this._config.entity];
    let error;
    if (!state) error = `Entity ${this._config.entity} is not available.`;
    else if (["unknown", "unavailable"].includes(state.state)) {
      error = `Entity ${this._config.entity} is ${state.state}.`;
    } else if (state.attributes.error) {
      error = `Recording list error: ${state.attributes.error}`;
    } else if (!Array.isArray(state.attributes.records)) {
      error = `Entity ${this._config.entity} has no records list.`;
    }
    if (error) {
      const message = this._element("p", error);
      message.className = "error";
      message.setAttribute("role", "alert");
      card.append(message);
      return;
    }

    const filenames = new Set();
    for (const record of state.attributes.records) {
      const path = typeof record === "string" ? record : record && (
        record.video || record.file_name || record.file || record.filename || record.name || record.path
      );
      if (typeof path !== "string") continue;
      const filename = path.split("/").pop();
      if (/^doorbell_\d{8}_\d{6}\.mp4$/.test(filename)) filenames.add(filename);
    }
    const clips = [...filenames].sort().reverse();
    if (!clips.length) {
      this._page = 0;
      card.append(this._element("p", "No recordings found."));
      return;
    }

    const pageSize = this._config.page_size;
    const pages = Math.ceil(clips.length / pageSize);
    this._page = Math.max(0, Math.min(this._page, pages - 1));
    const start = this._page * pageSize;
    for (const filename of clips.slice(start, start + pageSize)) {
      const row = this._element("div");
      row.className = "clip";
      const timestamp = filename.slice(9, -4);
      const [date, time] = timestamp.split("_");
      const label = `${date.slice(6, 8)}/${date.slice(4, 6)}/${date.slice(0, 4)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
      const thumbnail = this._link(filename);
      thumbnail.className = "thumbnail";
      thumbnail.setAttribute("aria-label", `Play clip recorded ${label}`);
      const image = this._element("img");
      image.src = `/local/doorbell/thumb_${timestamp}.jpg`;
      image.alt = `Recording ${label}`;
      image.loading = "lazy";
      thumbnail.append(image);
      const details = this._element("div");
      const recorded = this._element("time", label);
      recorded.dateTime = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
      const play = this._link(filename);
      play.textContent = "Play clip";
      details.append(recorded, play);
      row.append(thumbnail, details);
      card.append(row);
    }

    const navigation = this._element("nav");
    navigation.setAttribute("aria-label", "Recorded clips pages");
    for (const [text, delta, disabled] of [
      ["Previous", -1, this._page === 0],
      ["Next", 1, this._page === pages - 1],
    ]) {
      const button = this._element("button", text);
      button.type = "button";
      button.disabled = disabled;
      button.addEventListener("click", () => {
        this._page += delta;
        this._render();
      });
      navigation.append(button);
      if (delta === -1) {
        const status = this._element("span", `Page ${this._page + 1} of ${pages} (${clips.length} clips)`);
        status.setAttribute("aria-live", "polite");
        navigation.append(status);
      }
    }
    card.append(navigation);
  }
}

customElements.define("doorbell-records-card", DoorbellRecordsCard);
