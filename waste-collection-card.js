// Waste collection card for Home Assistant.
//   mode: upcoming -> pending events for today and tomorrow + "Calendar" button
//   mode: month    -> month grid + agenda of future events, Previous/Next month
// Past events are never shown. Event data comes from the calendar REST API
// (GET /api/calendars/<entity>?start=...&end=...) via hass.callApi.

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// Calendar API values are {date: "YYYY-MM-DD"} (all-day) or {dateTime: ISO}.
const parseMoment = (value) => {
  const raw = value && typeof value === "object" ? value.dateTime || value.date : value;
  if (typeof raw !== "string" || !raw) return undefined;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  // All-day dates are local calendar days, not UTC midnight.
  if (dateOnly) return { date: new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]), allDay: true };
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : { date, allDay: false };
};

const normalizeEvents = (items) => {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const events = [];
  for (const item of items) {
    if (!item) continue;
    const start = parseMoment(item.start);
    if (!start) continue;
    let end = parseMoment(item.end);
    let endDate = end ? end.date : undefined;
    if (!endDate || endDate <= start.date) {
      endDate = start.allDay ? addDays(start.date, 1) : start.date;
    }
    const summary = typeof item.summary === "string" && item.summary.trim() ? item.summary.trim() : "Waste collection";
    const id = `${item.uid || ""}|${item.recurrence_id || ""}|${start.date.getTime()}|${summary}`;
    if (seen.has(id)) continue;
    seen.add(id);
    events.push({ summary, start: start.date, end: endDate, allDay: start.allDay, location: item.location || "" });
  }
  return events.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
};

// Pending = not finished yet. An all-day event stays pending for its whole day.
const isPending = (event, now) => (event.end > event.start ? event.end > now : event.start >= now);

// Today's and tomorrow's pending events.
const upcomingEvents = (events, now) => {
  const limit = addDays(startOfDay(now), 2);
  return events.filter((event) => isPending(event, now) && event.start < limit);
};

// Future/pending events overlapping [monthStart, nextMonthStart).
const monthEvents = (events, now, monthStart) => {
  const next = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  return events.filter((event) => isPending(event, now) && event.start < next && event.end > monthStart);
};

// Days of an event within the month, ignoring days already in the past.
const eventDays = (event, now, monthStart) => {
  const next = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const today = startOfDay(now);
  const keys = [];
  let day = startOfDay(event.start);
  const last = event.end > event.start ? new Date(event.end.getTime() - 1) : event.start;
  for (; day <= last && day < next; day = addDays(day, 1)) {
    if (day >= monthStart && day >= today) keys.push(dayKey(day));
  }
  return keys;
};

const relativeDay = (date, now) => {
  const diff = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return undefined;
};

class WasteCollectionCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._monthOffset = 0;
    this._events = [];
  }

  static getStubConfig() {
    return { entity: "calendar.kauno_svara", mode: "upcoming", navigation_path: "main_calendar" };
  }

  setConfig(config) {
    if (!config || typeof config.entity !== "string" || !config.entity.startsWith("calendar.")) {
      throw new Error("Waste collection card requires a calendar entity.");
    }
    const mode = config.mode === undefined ? "upcoming" : config.mode;
    if (!["upcoming", "month"].includes(mode)) {
      throw new Error("mode must be 'upcoming' or 'month'.");
    }
    const refresh = config.refresh_interval === undefined ? 15 : config.refresh_interval;
    if (typeof refresh !== "number" || !(refresh >= 1)) {
      throw new Error("refresh_interval must be a number of minutes (>= 1).");
    }
    this._config = {
      entity: config.entity,
      mode,
      title: config.title === undefined
        ? (mode === "month" ? "Waste collection calendar" : "Waste collection")
        : config.title,
      navigation_path: config.navigation_path,
      hide_when_empty: config.hide_when_empty === true,
      refresh_interval: refresh,
    };
    this._monthOffset = 0;
    this._events = [];
    this._error = undefined;
    this._loaded = false;
    this._fetchKey = undefined;
    this._fetchedAt = 0;
    this._render();
    if (this._hass) this._maybeFetch(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._maybeFetch(false);
    // Drop events that have just become past without waiting for the fetch.
    if (this._signature() !== this._renderedSignature) this._render();
  }

  getCardSize() {
    return this._config && this._config.mode === "month" ? 9 : 3;
  }

  getGridOptions() {
    return this._config && this._config.mode === "month"
      ? { columns: "full", rows: "auto" }
      : { columns: 12, rows: "auto" };
  }

  _now() {
    return new Date();
  }

  _range(now) {
    const today = startOfDay(now);
    if (this._config.mode === "upcoming") return { start: now, end: addDays(today, 2) };
    const monthStart = new Date(now.getFullYear(), now.getMonth() + this._monthOffset, 1);
    return {
      start: monthStart > now ? monthStart : now,
      end: new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1),
      monthStart,
    };
  }

  _maybeFetch(force) {
    if (!this._hass || !this._config) return;
    const now = this._now();
    const state = this._hass.states[this._config.entity];
    const key = [this._config.entity, this._config.mode, this._monthOffset, dayKey(now),
      state ? state.last_updated || state.last_changed || state.state : "missing"].join("|");
    const stale = now.getTime() - this._fetchedAt >= this._config.refresh_interval * 60 * 1000;
    if (!force && key === this._fetchKey && !stale) return;
    this._fetchKey = key;
    this._fetchedAt = now.getTime();
    if (!state) {
      this._error = `Entity ${this._config.entity} is not available.`;
      this._render();
      return;
    }
    const { start, end } = this._range(now);
    const token = (this._token || 0) + 1;
    this._token = token;
    const path = `calendars/${this._config.entity}?start=${encodeURIComponent(start.toISOString())}`
      + `&end=${encodeURIComponent(end.toISOString())}`;
    Promise.resolve()
      .then(() => this._hass.callApi("GET", path))
      .then((items) => {
        if (token !== this._token) return;
        this._events = normalizeEvents(items);
        this._error = undefined;
        this._loaded = true;
        this._render();
      })
      .catch((error) => {
        if (token !== this._token) return;
        this._error = `Unable to load ${this._config.entity}: ${(error && (error.body && error.body.message || error.message)) || error}`;
        this._loaded = true;
        this._fetchedAt = 0; // retry on the next hass update after the interval
        this._render();
      });
    if (!this._loaded) this._render();
  }

  _visible(now) {
    if (this._config.mode === "upcoming") return upcomingEvents(this._events, now);
    return monthEvents(this._events, now, this._range(now).monthStart);
  }

  _signature() {
    const now = this._now();
    return `${dayKey(now)}|${this._visible(now).map((e) => e.start.getTime() + e.summary).join(",")}`;
  }

  _language() {
    const hass = this._hass;
    return (hass && ((hass.locale && hass.locale.language) || hass.language)) || undefined;
  }

  _element(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  _formatDate(date, options) {
    try {
      return date.toLocaleDateString(this._language(), options);
    } catch (_error) {
      return date.toLocaleDateString(undefined, options);
    }
  }

  _formatTime(date) {
    try {
      return date.toLocaleTimeString(this._language(), { hour: "2-digit", minute: "2-digit" });
    } catch (_error) {
      return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
  }

  _navigate() {
    let path = this._config.navigation_path;
    if (!path) return;
    if (!path.startsWith("/")) {
      // Relative path -> view of the current dashboard, e.g. /lovelace/main_calendar.
      const dashboard = window.location.pathname.split("/").filter(Boolean)[0] || "lovelace";
      path = `/${dashboard}/${path}`;
    }
    window.history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _eventRow(event, now, showRelative) {
    const row = this._element("li", undefined, "event");
    const when = this._element("span", undefined, "when");
    const relative = showRelative ? relativeDay(event.start, now) : undefined;
    const date = this._formatDate(event.start, { weekday: "short", month: "short", day: "numeric" });
    when.textContent = relative ? `${relative} · ${date}` : date;
    if (!event.allDay) when.textContent += ` ${this._formatTime(event.start)}`;
    if (relative === "Today") row.className = "event today";
    const icon = this._element("ha-icon");
    icon.setAttribute("icon", "mdi:trash-can-outline");
    const summary = this._element("span", event.summary, "summary");
    row.append(icon, summary, when);
    return row;
  }

  _render() {
    if (!this._config) return;
    const now = this._now();
    const style = this._element("style");
    style.textContent = `
      :host { display: block; }
      :host([hidden]) { display: none; }
      ha-card { padding: 16px; color: var(--primary-text-color); height: 100%; box-sizing: border-box; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
      h2 { margin: 0; font-size: 1.1em; font-weight: 500; }
      ul { list-style: none; margin: 0; padding: 0; }
      .event { display: flex; align-items: center; gap: 10px; padding: 8px 0;
        border-bottom: 1px solid var(--divider-color); }
      .event:last-child { border-bottom: none; }
      .event ha-icon { color: var(--secondary-text-color); flex-shrink: 0; }
      .event.today ha-icon, .event.today .when { color: var(--warning-color, #ff9800); }
      .summary { flex: 1; min-width: 0; }
      .when { white-space: nowrap; color: var(--secondary-text-color); font-size: 0.9em; }
      .empty { margin: 4px 0; color: var(--secondary-text-color); }
      .error { margin: 4px 0; color: var(--error-color, #db4437); }
      button { font: inherit; color: var(--primary-text-color); background: var(--card-background-color);
        border: 1px solid var(--divider-color); border-radius: 6px; padding: 6px 12px; cursor: pointer;
        display: inline-flex; align-items: center; gap: 6px; }
      button:disabled { opacity: 0.45; cursor: default; }
      .month-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; }
      .month-label { font-weight: 500; text-transform: capitalize; }
      .grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; margin-bottom: 12px; }
      .weekday { text-align: center; font-size: 0.8em; color: var(--secondary-text-color); padding: 4px 0; }
      .day { min-height: 44px; padding: 2px 4px; border-radius: 4px; font-size: 0.85em;
        background: var(--secondary-background-color); overflow: hidden; }
      .day.blank { background: none; }
      .day.past { opacity: 0.4; }
      .day.today { outline: 2px solid var(--primary-color); }
      .day.has-event { background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.2); }
      .chip { display: block; font-size: 0.75em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    `;
    const card = this._element("ha-card");
    this.shadowRoot.replaceChildren(style, card);
    const header = this._element("header");
    if (this._config.title) header.append(this._element("h2", this._config.title));
    card.append(header);

    const visible = this._error ? [] : this._visible(now);
    this._renderedSignature = this._signature();
    this.hidden = this._config.mode === "upcoming" && this._config.hide_when_empty
      && this._loaded && !this._error && visible.length === 0;

    if (this._config.mode === "upcoming") {
      if (this._config.navigation_path) {
        const button = this._element("button");
        button.type = "button";
        button.setAttribute("aria-label", "Open waste collection calendar");
        const icon = this._element("ha-icon");
        icon.setAttribute("icon", "mdi:calendar-month");
        button.append(icon, this._element("span", "Calendar"));
        button.addEventListener("click", () => this._navigate());
        header.append(button);
      }
      this._appendBody(card, visible, now, "No waste collection today or tomorrow.", true);
      return;
    }

    const { monthStart } = this._range(now);
    const nav = this._element("nav", undefined, "month-nav");
    nav.setAttribute("aria-label", "Month navigation");
    const previous = this._element("button", "Previous");
    previous.type = "button";
    previous.disabled = this._monthOffset <= 0; // earlier months contain only past events
    previous.addEventListener("click", () => this._changeMonth(-1));
    const label = this._element("span", this._formatDate(monthStart, { month: "long", year: "numeric" }), "month-label");
    label.setAttribute("aria-live", "polite");
    const next = this._element("button", "Next");
    next.type = "button";
    next.addEventListener("click", () => this._changeMonth(1));
    nav.append(previous, label, next);
    card.append(nav);
    if (this._monthOffset > 0) {
      const back = this._element("button", "This month");
      back.type = "button";
      back.addEventListener("click", () => this._changeMonth(-this._monthOffset));
      header.append(back);
    }
    card.append(this._grid(visible, now, monthStart));
    this._appendBody(card, visible, now, "No upcoming waste collection this month.", this._monthOffset === 0);
  }

  _appendBody(card, visible, now, emptyText, showRelative) {
    if (this._error) {
      const message = this._element("p", this._error, "error");
      message.setAttribute("role", "alert");
      card.append(message);
      return;
    }
    if (!this._loaded) {
      card.append(this._element("p", "Loading…", "empty"));
      return;
    }
    if (!visible.length) {
      card.append(this._element("p", emptyText, "empty"));
      return;
    }
    const list = this._element("ul");
    list.setAttribute("aria-label", "Waste collection events");
    for (const event of visible) list.append(this._eventRow(event, now, showRelative));
    card.append(list);
  }

  _grid(visible, now, monthStart) {
    const grid = this._element("div", undefined, "grid");
    // Monday-first week (Lithuania); weekday names from 2024-01-01 (a Monday).
    for (let i = 0; i < 7; i++) {
      grid.append(this._element("span", this._formatDate(new Date(2024, 0, 1 + i), { weekday: "short" }), "weekday"));
    }
    const byDay = new Map();
    for (const event of visible) {
      for (const key of eventDays(event, now, monthStart)) {
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(event);
      }
    }
    const blanks = (monthStart.getDay() + 6) % 7;
    for (let i = 0; i < blanks; i++) grid.append(this._element("span", undefined, "day blank"));
    const today = startOfDay(now);
    for (let day = monthStart; day.getMonth() === monthStart.getMonth(); day = addDays(day, 1)) {
      const events = byDay.get(dayKey(day)) || [];
      const classes = ["day"];
      if (day < today) classes.push("past");
      if (day.getTime() === today.getTime()) classes.push("today");
      if (events.length) classes.push("has-event");
      const cell = this._element("div", undefined, classes.join(" "));
      cell.setAttribute("data-date", dayKey(day));
      cell.append(this._element("span", String(day.getDate())));
      for (const event of events) {
        const chip = this._element("span", event.summary, "chip");
        chip.title = event.summary;
        cell.append(chip);
      }
      grid.append(cell);
    }
    return grid;
  }

  _changeMonth(delta) {
    this._monthOffset = Math.max(0, this._monthOffset + delta);
    this._events = [];
    this._loaded = false;
    this._error = undefined;
    this._maybeFetch(true);
  }
}

WasteCollectionCard.helpers = { parseMoment, normalizeEvents, isPending, upcomingEvents, monthEvents, eventDays, relativeDay, dayKey };

customElements.define("waste-collection-card", WasteCollectionCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "waste-collection-card",
  name: "Waste collection card",
  description: "Upcoming (today/tomorrow) waste collection events or a month calendar without past events.",
});
