const VERSION = "2.8.9";
class OfflineDevicePanel extends HTMLElement {
  static getConfigElement() {
    return document.createElement("offline-device-panel-editor");
  }

  static getStubConfig() {
    return {
      title: "Device Status",
      show_online: true,
      display_mode: "detailed",
      offline_states: ["unavailable", "unknown"],
      domains: [],
      integrations: [],
      areas: [],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._filters = this._defaultFilters();
    this._openMulti = null;
    this._alertExpanded = false;
    this._registriesLoaded = false;
    this._entities = [];
    this._devices = [];
    this._areas = [];
    this._history = [];
    this._activeTab = "devices";
    this._historyFilters = { status: "both", area: "all", range: "1d" };
    this._hass = null;
    this._boundOutsideClick = (event) => this._handleOutsideClick(event);
  }

  setConfig(config) {
    const nextConfig = {
      title: "Offline Devices",
      show_online: true,
      display_mode: "detailed",
      offline_states: ["unavailable", "unknown"],
      columns: "auto",
      domains: [],
      integrations: [],
      areas: [],
      excluded_entities: [],
      show_history_chart: true,
      history_max_points: 96,
      history_sample_interval_minutes: 1440,
      domain_labels: {},
      integration_labels: {},
      force_simple: false,
      persist_filters: true,
      ...config,
    };
    this._config = nextConfig;
    this._history = this._loadHistory();
    this._filters = this._normalizedFilters({
      ...this._defaultFilters(),
      ...this._loadFilters(),
    });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadRegistries(hass);
    if (this._isControlActive()) return;
    this._render({ preserveScroll: true });
  }

  getCardSize() {
    return 6;
  }

  connectedCallback() {
    document.addEventListener("click", this._boundOutsideClick);
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._boundOutsideClick);
  }

  _defaultFilters() {
    return {
      status: "offline",
      displayMode: this._config?.force_simple || this._config?.display_mode === "simple" ? "simple" : "detailed",
      domains: [],
      integrations: [],
      areas: [],
      search: "",
    };
  }

  _storageKey() {
    const path = window.location?.pathname || "dashboard";
    const cardKey = this._config.storage_key || this._config.title || "offline-device-panel";
    return `offline-device-panel:filters:${path}:${cardKey}`;
  }

  _historyStorageKey() {
    const path = window.location?.pathname || "dashboard";
    const cardKey = this._config.storage_key || this._config.title || "offline-device-panel";
    return `offline-device-panel:history:${path}:${cardKey}`;
  }

  _loadFilters() {
    if (this._config.persist_filters === false) return {};

    try {
      const value = localStorage.getItem(this._storageKey());
      return value ? JSON.parse(value) : {};
    } catch (error) {
      console.warn("offline-device-panel: saved filters could not be loaded", error);
      return {};
    }
  }

  _saveFilters() {
    if (this._config.persist_filters === false) return;

    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(this._normalizedFilters(this._filters)));
    } catch (error) {
      console.warn("offline-device-panel: filters could not be saved", error);
    }
  }

  _loadHistory() {
    try {
      const value = localStorage.getItem(this._historyStorageKey());
      const history = value ? JSON.parse(value) : [];
      return Array.isArray(history) ? history.filter((entry) => entry && typeof entry === "object") : [];
    } catch (error) {
      console.warn("offline-device-panel: saved history could not be loaded", error);
      return [];
    }
  }

  _saveHistory() {
    try {
      localStorage.setItem(this._historyStorageKey(), JSON.stringify(this._history));
    } catch (error) {
      console.warn("offline-device-panel: history could not be saved", error);
    }
  }

  _historyLimit() {
    const limit = Number(this._config.history_max_points);
    return Number.isFinite(limit) ? Math.max(6, Math.min(288, Math.round(limit))) : 96;
  }

  _historyIntervalMs() {
    const minutes = Number(this._config.history_sample_interval_minutes);
    return (Number.isFinite(minutes) ? Math.max(1, Math.min(1440, minutes)) : 1440) * 60 * 1000;
  }

  _recordHistory(rows) {
    if (this._config.show_history_chart === false || !rows.length) return;

    const snapshot = this._historySnapshot(rows);
    const last = this._history[this._history.length - 1];
    const changed = !last || last.signature !== snapshot.signature;
    const due = !last || snapshot.ts - Number(last.ts || 0) >= this._historyIntervalMs();
    if (!changed && !due) return;

    this._history = [...this._history, snapshot].slice(-this._historyLimit());
    this._saveHistory();
  }

  _historySnapshot(rows) {
    const areas = {};
    rows.forEach((row) => {
      const area = row.areaName || "No area";
      if (!areas[area]) areas[area] = { total: 0, offline: 0, online: 0 };
      areas[area].total += 1;
      if (row.offline) areas[area].offline += 1;
      else areas[area].online += 1;
    });

    const total = rows.length;
    const offline = rows.filter((row) => row.offline).length;
    const online = total - offline;
    const signature = JSON.stringify({
      total,
      offline,
      areas: Object.entries(areas)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([area, counts]) => [area, counts.total, counts.offline]),
    });

    return {
      ts: Date.now(),
      total,
      offline,
      online,
      areas,
      signature,
    };
  }

  _normalizedFilters(filters) {
    const status = ["offline", "online", "all"].includes(filters.status) ? filters.status : "offline";
    const displayMode = this._config.force_simple || filters.displayMode === "simple" ? "simple" : "detailed";
    const arrayOrEmpty = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

    return {
      status: this._config.show_online === false && status !== "offline" ? "offline" : status,
      displayMode,
      domains: arrayOrEmpty(filters.domains),
      integrations: arrayOrEmpty(filters.integrations),
      areas: arrayOrEmpty(filters.areas),
      search: typeof filters.search === "string" ? filters.search : "",
    };
  }

  async _loadRegistries(hass) {
    if (this._registriesLoaded || !hass?.callWS) return;
    this._registriesLoaded = true;

    try {
      const [entities, devices, areas] = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/device_registry/list" }),
        hass.callWS({ type: "config/area_registry/list" }),
      ]);
      this._entities = entities || [];
      this._devices = devices || [];
      this._areas = areas || [];
      if (this._isControlActive()) return;
      this._render({ preserveScroll: true });
    } catch (error) {
      console.warn("offline-device-panel: registry lookup failed", error);
    }
  }

  _isControlActive() {
    const active = this.shadowRoot?.activeElement || document.activeElement;
    return Boolean(this._openMulti) || ["INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(active?.tagName);
  }

  _deviceRows() {
    if (!this._hass?.states) return [];

    const entityRegistry = new Map(this._entities.map((entity) => [entity.entity_id, entity]));
    const deviceRegistry = new Map(this._devices.map((device) => [device.id, device]));
    const areaRegistry = new Map(this._areas.map((area) => [area.area_id || area.id, area]));
    const excludedEntities = new Set((this._config.excluded_entities || []).map((entityId) => String(entityId).trim()).filter(Boolean));
    const grouped = new Map();

    for (const [entityId, stateObj] of Object.entries(this._hass.states)) {
      if (excludedEntities.has(entityId)) continue;
      const domain = entityId.split(".")[0];
      if (this._config.domains.length && !this._config.domains.includes(domain)) continue;

      const entity = entityRegistry.get(entityId);
      const device = entity?.device_id ? deviceRegistry.get(entity.device_id) : null;
      const integration = this._integration(entity, stateObj);
      if (this._config.integrations.length && !this._config.integrations.includes(integration)) continue;

      const areaId = entity?.area_id || device?.area_id || stateObj.attributes?.area_id || "unknown";
      const area = areaRegistry.get(areaId);
      const areaName = area?.name || stateObj.attributes?.area || (areaId === "unknown" ? "No area" : areaId);
      if (this._config.areas.length && !this._config.areas.includes(areaName) && !this._config.areas.includes(areaId)) continue;

      const key = entity?.device_id || entityId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          entityId,
          name: device?.name_by_user || device?.name || stateObj.attributes?.friendly_name || entityId,
          offline: false,
          domains: new Set(),
          integrations: new Set(),
          states: new Set(),
          icons: new Set(),
          deviceClasses: new Set(),
          offlineEntities: [],
          entityCount: 0,
          areaId,
          areaName,
          lastChanged: stateObj.last_changed,
        });
      }

      const row = grouped.get(key);
      const isOffline = this._isOffline(stateObj.state);
      row.offline = row.offline || isOffline;
      row.domains.add(domain);
      row.integrations.add(integration);
      row.states.add(stateObj.state);
      if (stateObj.attributes?.icon) row.icons.add(stateObj.attributes.icon);
      if (stateObj.attributes?.device_class) row.deviceClasses.add(stateObj.attributes.device_class);
      row.entityCount += 1;
      if (isOffline) {
        row.offlineEntities.push({
          entityId,
          name: stateObj.attributes?.friendly_name || entity?.name || entityId,
          uniqueId: entity?.unique_id || "",
        });
      }
      if (isOffline || !row.lastChanged || new Date(stateObj.last_changed) > new Date(row.lastChanged)) {
        row.lastChanged = stateObj.last_changed;
      }
    }

    const rows = [...grouped.values()].map((row) => {
      const domains = [...row.domains].sort((a, b) => a.localeCompare(b));
      const integrations = [...row.integrations].sort((a, b) => a.localeCompare(b));
      const states = [...row.states].sort((a, b) => a.localeCompare(b));
      return {
        ...row,
        entityId: row.offlineEntities[0]?.entityId || row.entityId,
        domain: domains.join(", "),
        integration: integrations.join(", "),
        displayDomain: domains.map((domain) => this._domainLabel(domain)).join(", "),
        displayIntegration: integrations.map((integration) => this._integrationLabel(integration)).join(", "),
        state: states.join(", "),
        domains,
        integrations,
        states,
        icons: [...row.icons],
        deviceClasses: [...row.deviceClasses],
      };
    });

    return rows.sort((a, b) => {
      if (a.offline !== b.offline) return a.offline ? -1 : 1;
      return a.areaName.localeCompare(b.areaName) || a.name.localeCompare(b.name);
    });
  }

  _integration(entity, stateObj) {
    if (entity?.platform) return entity.platform;
    const attr = stateObj.attributes || {};
    return attr.integration || attr.platform || "unknown";
  }

  _domainLabel(domain) {
    return this._config.domain_labels?.[domain] || domain;
  }

  _integrationLabel(integration) {
    return this._config.integration_labels?.[integration] || integration;
  }

  _isOffline(state) {
    return this._config.offline_states.includes(String(state).toLowerCase());
  }

  _deviceIcon(row) {
    const deviceClass = row.deviceClasses?.[0];
    if (deviceClass) {
      const classIcons = {
        motion: "mdi:motion-sensor",
        occupancy: "mdi:motion-sensor",
        door: "mdi:door",
        window: "mdi:window-closed",
        garage_door: "mdi:garage",
        opening: "mdi:door-open",
        smoke: "mdi:smoke-detector",
        gas: "mdi:gas-cylinder",
        moisture: "mdi:water-alert",
        temperature: "mdi:thermometer",
        humidity: "mdi:water-percent",
        illuminance: "mdi:brightness-5",
        battery: "mdi:battery",
        power: "mdi:flash",
        energy: "mdi:lightning-bolt",
        voltage: "mdi:sine-wave",
        current: "mdi:current-ac",
        plug: "mdi:power-plug",
        lock: "mdi:lock",
      };
      if (classIcons[deviceClass]) return classIcons[deviceClass];
    }

    if (row.icons?.[0]) return row.icons[0];

    const domainIcons = {
      light: "mdi:lightbulb",
      switch: "mdi:toggle-switch",
      sensor: "mdi:eye",
      binary_sensor: "mdi:checkbox-marked-circle-outline",
      climate: "mdi:thermostat",
      cover: "mdi:blinds",
      lock: "mdi:lock",
      camera: "mdi:cctv",
      media_player: "mdi:speaker",
      fan: "mdi:fan",
      vacuum: "mdi:robot-vacuum",
      alarm_control_panel: "mdi:shield-home",
      device_tracker: "mdi:map-marker",
      person: "mdi:account",
      button: "mdi:gesture-tap-button",
      scene: "mdi:palette",
      script: "mdi:script-text",
      automation: "mdi:home-automation",
    };

    return domainIcons[row.domains?.[0]] || "mdi:devices";
  }

  _filteredRows() {
    const search = this._filters.search.trim().toLowerCase();

    return this._deviceRows().filter((row) => {
      if (this._filters.status === "offline" && !row.offline) return false;
      if (this._filters.status === "online" && row.offline) return false;
      if (this._filters.domains.length && !this._hasAny(row.domains, this._filters.domains)) return false;
      if (this._filters.integrations.length && !this._hasAny(row.integrations, this._filters.integrations)) return false;
      if (this._filters.areas.length && !this._filters.areas.includes(row.areaName)) return false;
      if (!search) return true;

      const offlineText = row.offlineEntities.map((entity) => `${entity.name} ${entity.entityId} ${entity.uniqueId}`).join(" ");
      const haystack = `${row.name} ${row.entityId} ${offlineText} ${row.areaName} ${row.integration} ${row.domain} ${row.displayIntegration} ${row.displayDomain}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  _hasAny(values, selected) {
    return selected.some((value) => values.includes(value));
  }

  _options(rows, key) {
    const values = rows.flatMap((row) => {
      const value = row[key];
      return Array.isArray(value) ? value : [value];
    });
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _labeledOptions(rows, key) {
    return this._options(rows, key)
      .map((value) => [value, key === "domains" ? this._domainLabel(value) : key === "integrations" ? this._integrationLabel(value) : value])
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }

  _groupByArea(rows) {
    return rows.reduce((groups, row) => {
      const key = row.areaName || "No area";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
      return groups;
    }, new Map());
  }

  _offlineAreaSummary(rows) {
    return [...this._groupByArea(rows.filter((row) => row.offline)).entries()]
      .map(([area, areaRows]) => ({ area, count: areaRows.length }))
      .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
  }

  _render(options = {}) {
    if (!this.shadowRoot) return;

    const preserveScroll = options.preserveScroll || Boolean(this._openMulti);
    const scrollSnapshots = preserveScroll ? this._scrollSnapshots() : [];
    const openMenu = preserveScroll && this._openMulti ? this.shadowRoot.querySelector(`[data-multi-menu="${this._openMulti}"]`) : null;
    const menuScrollTop = openMenu ? openMenu.scrollTop : 0;
    const menuScrollLeft = openMenu ? openMenu.scrollLeft : 0;
    const activeElement = this.shadowRoot.activeElement;
    const activeFilter = activeElement?.dataset?.filter || "";
    const selectionStart = typeof activeElement?.selectionStart === "number" ? activeElement.selectionStart : null;
    const selectionEnd = typeof activeElement?.selectionEnd === "number" ? activeElement.selectionEnd : null;

    const allRows = this._deviceRows();
    this._recordHistory(allRows);
    const rows = this._filteredRows();
    const offlineCount = allRows.filter((row) => row.offline).length;
    const onlineCount = allRows.length - offlineCount;
    const totalCount = allRows.length;
    const statusText = `${offlineCount} offline / ${onlineCount} online / ${totalCount} total`;
    const offlineAreas = this._offlineAreaSummary(allRows);
    const activeTab = this._config.show_history_chart === false ? "devices" : this._activeTab;

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="panel">
          <header>
            <div>
              <h2>${this._escape(this._config.title)}</h2>
              <p>${this._escape(statusText)}</p>
            </div>
            ${this._tabsTemplate(activeTab)}
            <span class="${offlineCount ? "badge bad" : "badge good"}">
              ${offlineCount ? "Attention needed" : "All clear"}
            </span>
          </header>
          ${offlineCount ? this._alertTemplate(offlineCount, offlineAreas) : ""}
          ${
            activeTab === "history"
              ? this._historyTemplate(allRows)
              : `
                <section class="filters">
                  ${this._singleChoice("status", "Status", this._statusOptions())}
                  ${
                    this._config.force_simple
                      ? ""
                      : this._singleChoice("displayMode", "Card style", [
                          ["detailed", "Detailed"],
                          ["simple", "Simple"],
                        ])
                  }
                  ${this._multiChoice("domains", "Type", "All types", this._labeledOptions(allRows, "domains"))}
                  ${this._multiChoice("integrations", "Integrations", "All integrations", this._labeledOptions(allRows, "integrations"))}
                  ${this._multiChoice("areas", "Areas", "All areas", this._options(allRows, "areaName"))}
                  <label class="search">
                    <span>Search</span>
                    <input data-filter="search" value="${this._escape(this._filters.search)}" placeholder="Device, entity, area..." />
                  </label>
                </section>

                ${rows.length ? this._areasTemplate(rows) : this._emptyTemplate(allRows.length)}
              `
          }
        </div>
      </ha-card>
      ${this._styles()}
    `;

    this.shadowRoot.querySelectorAll("[data-panel-tab]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._activeTab = event.currentTarget.dataset.panelTab;
        this._openMulti = null;
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-history-filter]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.currentTarget.dataset.historyFilter;
        this._historyFilters = { ...this._historyFilters, [key]: event.currentTarget.value };
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-filter]").forEach((element) => {
      element.addEventListener("input", (event) => {
        this._filters[event.target.dataset.filter] = event.target.value;
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-filter-multi]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.target.dataset.filterMulti;
        this._openMulti = key;
        const value = event.target.value;
        const selected = new Set(this._filters[key]);
        if (event.target.checked) selected.add(value);
        else selected.delete(value);
        this._filters[key] = [...selected].sort((a, b) => a.localeCompare(b));
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-single-filter]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        const key = event.currentTarget.dataset.singleFilter;
        this._filters[key] = event.currentTarget.dataset.singleValue;
        this._openMulti = null;
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-clear-multi]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        const key = event.currentTarget.dataset.clearMulti;
        this._openMulti = key;
        this._filters[key] = [];
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-alert-area]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._filters.status = "offline";
        this._filters.areas = [event.currentTarget.dataset.alertArea];
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-alert-more]").forEach((element) => {
      element.addEventListener("click", () => {
        this._alertExpanded = !this._alertExpanded;
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-multi-details]").forEach((element) => {
      element.addEventListener("toggle", (event) => {
        const key = event.currentTarget.dataset.multiDetails;
        if (event.currentTarget.open) {
          this._openMulti = key;
          this.shadowRoot.querySelectorAll("[data-multi-details]").forEach((details) => {
            if (details !== event.currentTarget) details.open = false;
          });
        } else if (this._openMulti === key) {
          this._openMulti = null;
        }
      });
    });

    this.shadowRoot.querySelectorAll("[data-entity]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const entityId = event.currentTarget.dataset.entity;
        const moreInfoEvent = new Event("hass-more-info", { bubbles: true, composed: true });
        moreInfoEvent.detail = { entityId };
        this.dispatchEvent(moreInfoEvent);
      });
    });

    if (preserveScroll || activeFilter) {
      requestAnimationFrame(() => {
        if (preserveScroll) this._restoreScrollSoon(scrollSnapshots);
        if (activeFilter) {
          const restoredInput = this.shadowRoot.querySelector(`[data-filter="${this._cssEscape(activeFilter)}"]`);
          restoredInput?.focus();
          if (selectionStart !== null && selectionEnd !== null) {
            restoredInput?.setSelectionRange?.(selectionStart, selectionEnd);
          }
        }
        if (this._openMulti) this._restoreOpenMultiSoon(menuScrollLeft, menuScrollTop);
      });
    }
  }

  _handleOutsideClick(event) {
    if (!this._openMulti || !this.shadowRoot) return;

    const openDetails = this.shadowRoot.querySelector(`[data-multi-details="${this._cssEscape(this._openMulti)}"]`);
    if (!openDetails) {
      this._openMulti = null;
      return;
    }

    const path = event.composedPath();
    if (path.includes(openDetails) || path.some((node) => node?.dataset?.multiDetails === this._openMulti)) return;

    this._openMulti = null;
    this._render({ preserveScroll: true });
  }

  _scrollSnapshots() {
    const snapshots = [];
    const seen = new Set();
    const add = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      snapshots.push({
        element,
        left: element.scrollLeft,
        top: element.scrollTop,
      });
    };

    add(document.scrollingElement || document.documentElement);

    let node = this;
    while (node) {
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
        if (canScrollY || canScrollX) add(node);
      }

      const root = node.getRootNode?.();
      node = node.parentElement || root?.host || null;
    }

    return snapshots;
  }

  _restoreScroll(snapshots) {
    for (const snapshot of snapshots) {
      snapshot.element.scrollTo(snapshot.left, snapshot.top);
    }
  }

  _restoreScrollSoon(snapshots) {
    this._restoreScroll(snapshots);
    requestAnimationFrame(() => this._restoreScroll(snapshots));
    window.setTimeout(() => this._restoreScroll(snapshots), 80);
  }

  _restoreOpenMulti(scrollLeft = 0, scrollTop = 0) {
    if (!this._openMulti || !this.shadowRoot) return;
    const details = this.shadowRoot.querySelector(`[data-multi-details="${this._cssEscape(this._openMulti)}"]`);
    if (details) details.open = true;
    const menu = this.shadowRoot.querySelector(`[data-multi-menu="${this._cssEscape(this._openMulti)}"]`);
    if (menu) menu.scrollTo(scrollLeft, scrollTop);
  }

  _restoreOpenMultiSoon(scrollLeft = 0, scrollTop = 0) {
    this._restoreOpenMulti(scrollLeft, scrollTop);
    requestAnimationFrame(() => this._restoreOpenMulti(scrollLeft, scrollTop));
    window.setTimeout(() => this._restoreOpenMulti(scrollLeft, scrollTop), 80);
    window.setTimeout(() => this._restoreOpenMulti(scrollLeft, scrollTop), 250);
  }

  _statusOptions() {
    const options = [["offline", "Offline"]];
    if (this._config.show_online !== false) {
      options.push(["online", "Online"], ["all", "All"]);
    }
    return options;
  }

  _select(key, label, options) {
    const optionHtml = options
      .map(([value, text]) => `<option value="${this._escape(value)}" ${this._filters[key] === value ? "selected" : ""}>${this._escape(text)}</option>`)
      .join("");

    return `
      <label>
        <span>${this._escape(label)}</span>
        <select data-filter="${this._escape(key)}">${optionHtml}</select>
      </label>
    `;
  }

  _singleChoice(key, label, options) {
    const currentValue = this._filters[key];
    const selected = options.find(([value]) => value === currentValue) || options[0] || ["", ""];
    const optionHtml = options
      .map(
        ([value, text]) => `
          <button
            type="button"
            class="single-option ${value === currentValue ? "active" : ""}"
            data-single-filter="${this._escape(key)}"
            data-single-value="${this._escape(value)}"
          >
            ${this._escape(text)}
          </button>
        `
      )
      .join("");

    return `
      <div class="multi">
        <span class="filter-label">${this._escape(label)}</span>
        <details data-multi-details="${this._escape(key)}" ${this._openMulti === key ? "open" : ""}>
          <summary>${this._escape(selected[1])}</summary>
          <div class="multi-menu" data-multi-menu="${this._escape(key)}">
            ${optionHtml}
          </div>
        </details>
      </div>
    `;
  }

  _multiChoice(key, label, allText, options) {
    const selected = this._filters[key] || [];
    const summary = selected.length ? `${selected.length} selected` : allText;
    const optionHtml = options.length
      ? options
          .map(
            (option) => {
              const [value, text] = Array.isArray(option) ? option : [option, option];
              return `
              <label class="check-row">
                <input
                  type="checkbox"
                  data-filter-multi="${this._escape(key)}"
                  value="${this._escape(value)}"
                  ${selected.includes(value) ? "checked" : ""}
                />
                <span>${this._escape(text)}</span>
              </label>
            `
            }
          )
          .join("")
      : `<div class="no-options">No options</div>`;

    return `
      <div class="multi">
        <span class="filter-label">${this._escape(label)}</span>
        <details data-multi-details="${this._escape(key)}" ${this._openMulti === key ? "open" : ""}>
          <summary>${this._escape(summary)}</summary>
          <div class="multi-menu" data-multi-menu="${this._escape(key)}">
            <button type="button" class="clear" data-clear-multi="${this._escape(key)}">${this._escape(allText)}</button>
            ${optionHtml}
          </div>
        </details>
      </div>
    `;
  }

  _tabsTemplate(activeTab) {
    if (this._config.show_history_chart === false) return "";

    return `
      <nav class="panel-tabs" aria-label="Device panel views">
        <button type="button" data-panel-tab="devices" class="${activeTab === "devices" ? "active" : ""}">
          Devices List
        </button>
        <button type="button" data-panel-tab="history" class="${activeTab === "history" ? "active" : ""}">
          History Charts
        </button>
      </nav>
    `;
  }

  _historyTemplate(rows) {
    if (this._config.show_history_chart === false || !rows.length || !this._history.length) return "";

    const rawHistory = this._history.slice(-this._historyLimit());
    const range = this._historyRangeOptions().some(([value]) => value === this._historyFilters.range) ? this._historyFilters.range : "1d";
    const history = this._historyForRange(rawHistory, range);
    const currentAreas = [...this._groupByArea(rows).keys()];
    const historicalAreas = rawHistory.flatMap((entry) => Object.keys(entry.areas || {}));
    const areas = [...new Set([...currentAreas, ...historicalAreas])].sort((a, b) => a.localeCompare(b));
    const selectedArea = areas.includes(this._historyFilters.area) ? this._historyFilters.area : "all";
    const metric = ["both", "online", "offline"].includes(this._historyFilters.status) ? this._historyFilters.status : "both";
    this._historyFilters = { status: metric, area: selectedArea, range };
    const visibleAreas = selectedArea === "all" ? areas : areas.filter((area) => area === selectedArea);
    const series = [
      {
        label: "Total",
        featured: true,
        current: { total: rows.length, offline: rows.filter((row) => row.offline).length },
        samples: history.map((entry) => ({ total: entry.total || 0, offline: entry.offline || 0, online: entry.online || 0, ts: entry.ts })),
      },
      ...visibleAreas.map((area) => {
        const areaRows = rows.filter((row) => (row.areaName || "No area") === area);
        return {
          label: area,
          current: { total: areaRows.length, offline: areaRows.filter((row) => row.offline).length },
          samples: history.map((entry) => {
            const counts = entry.areas?.[area];
            if (!counts) return { total: null, offline: null, online: null, ts: entry.ts };
            return { ...counts, ts: entry.ts };
          }),
        };
      }),
    ];

    return `
      <section class="history-panel" aria-label="Device availability history">
        <div class="history-head">
          <h3>Availability History</h3>
          ${this._historyLegendTemplate(metric)}
        </div>
        ${this._historyControlsTemplate(areas)}
        <div class="history-grid">
          ${series.map((item) => this._historySeriesTemplate(item, metric)).join("")}
        </div>
      </section>
    `;
  }

  _historyRangeOptions() {
    return [
      ["10m", "10 min"],
      ["30m", "30 mins"],
      ["1h", "1 hour"],
      ["3h", "3 hours"],
      ["6h", "6 hours"],
      ["12h", "12 hours"],
      ["1d", "1 day"],
      ["1w", "1 week"],
      ["1mo", "1 month"],
    ];
  }

  _historyRangeMs(range) {
    const ranges = {
      "10m": 10 * 60 * 1000,
      "30m": 30 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "3h": 3 * 60 * 60 * 1000,
      "6h": 6 * 60 * 60 * 1000,
      "12h": 12 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
      "1w": 7 * 24 * 60 * 60 * 1000,
      "1mo": 30 * 24 * 60 * 60 * 1000,
    };
    return ranges[range] || ranges["1d"];
  }

  _historyForRange(history, range) {
    const cutoff = Date.now() - this._historyRangeMs(range);
    const filtered = history.filter((entry) => Number(entry.ts) >= cutoff);
    return filtered.length ? filtered : history.slice(-1);
  }

  _historyControlsTemplate(areas) {
    const areaOptions = [
      `<option value="all" ${this._historyFilters.area === "all" ? "selected" : ""}>All areas</option>`,
      ...areas.map((area) => `<option value="${this._escape(area)}" ${this._historyFilters.area === area ? "selected" : ""}>${this._escape(area)}</option>`),
    ].join("");
    const rangeOptions = this._historyRangeOptions()
      .map(([value, label]) => `<option value="${this._escape(value)}" ${this._historyFilters.range === value ? "selected" : ""}>${this._escape(label)}</option>`)
      .join("");

    return `
      <div class="history-controls">
        <label>
          <span>Show</span>
          <select data-history-filter="status">
            <option value="both" ${this._historyFilters.status === "both" ? "selected" : ""}>Online and offline</option>
            <option value="online" ${this._historyFilters.status === "online" ? "selected" : ""}>Online only</option>
            <option value="offline" ${this._historyFilters.status === "offline" ? "selected" : ""}>Offline only</option>
          </select>
        </label>
        <label>
          <span>Area</span>
          <select data-history-filter="area">${areaOptions}</select>
        </label>
        <label>
          <span>Time frame</span>
          <select data-history-filter="range">${rangeOptions}</select>
        </label>
      </div>
    `;
  }

  _historyLegendTemplate(metric) {
    const online = metric === "both" || metric === "online" ? `<span><i class="online-key"></i>Online</span>` : "";
    const offline = metric === "both" || metric === "offline" ? `<span><i class="offline-key"></i>Offline</span>` : "";
    return `<div class="history-legend">${online}${offline}</div>`;
  }

  _historySeriesTemplate(series, metric = "both") {
    const currentOnline = Math.max(0, series.current.total - series.current.offline);
    const chart = this._historyLineChart(series, metric);
    const valueLabel =
      metric === "online"
        ? `${currentOnline} online`
        : metric === "offline"
          ? `${series.current.offline} offline`
          : `${series.current.offline} offline / ${currentOnline} online`;

    return `
      <div class="history-row ${series.featured ? "featured" : ""}">
        <div class="history-label">
          <strong>${this._escape(series.label)}</strong>
          <span>${this._escape(valueLabel)}</span>
        </div>
        ${chart}
      </div>
    `;
  }

  _historyLineChart(series, metric = "both") {
    const width = 640;
    const height = series.featured ? 180 : 92;
    const padX = 10;
    const padY = 10;
    const validSamples = series.samples.filter((sample) => sample.total !== null);
    if (!validSamples.length) {
      return `<div class="history-empty-line">No area history yet</div>`;
    }

    const valuesForScale = validSamples.flatMap((sample) => {
      if (metric === "online") return [Number(sample.online) || 0];
      if (metric === "offline") return [Number(sample.offline) || 0];
      return [Number(sample.online) || 0, Number(sample.offline) || 0];
    });
    const maxValue = Math.max(1, ...valuesForScale);
    const point = (sample, index) => {
      const x = series.samples.length === 1 ? width / 2 : padX + (index / (series.samples.length - 1)) * (width - padX * 2);
      const scaleY = (value) => height - padY - (Math.max(0, Number(value) || 0) / maxValue) * (height - padY * 2);
      return { x, onlineY: scaleY(sample.online), offlineY: scaleY(sample.offline) };
    };
    const onlinePoints = [];
    const offlinePoints = [];
    const onlineDots = [];
    const offlineDots = [];
    const markers = [];

    series.samples.forEach((sample, index) => {
      if (sample.total === null) return;
      const p = point(sample, index);
      onlinePoints.push(`${p.x.toFixed(2)},${p.onlineY.toFixed(2)}`);
      offlinePoints.push(`${p.x.toFixed(2)},${p.offlineY.toFixed(2)}`);
      onlineDots.push(`<circle class="history-dot online-dot" cx="${p.x.toFixed(2)}" cy="${p.onlineY.toFixed(2)}" r="3"></circle>`);
      offlineDots.push(`<circle class="history-dot offline-dot" cx="${p.x.toFixed(2)}" cy="${p.offlineY.toFixed(2)}" r="3"></circle>`);
      const offline = Math.max(0, Number(sample.offline) || 0);
      const online = Math.max(0, Number(sample.online) || 0);
      markers.push(`
        <span
          class="history-hit"
          style="left: ${this._escape(((p.x / width) * 100).toFixed(2))}%"
          title="${this._escape(`${this._formatHistoryTime(sample.ts)} - ${offline} offline / ${online} online`)}"
        ></span>
      `);
    });

    const showOnline = metric === "both" || metric === "online";
    const showOffline = metric === "both" || metric === "offline";
    const startLabel = this._formatHistoryTime(validSamples[0].ts);
    const endLabel = this._formatHistoryTime(validSamples[validSamples.length - 1].ts);

    return `
      <div class="history-chart">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${this._escape(series.label)} ${metric} trend">
          <line class="history-grid-line" x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}"></line>
          <line class="history-grid-line" x1="${padX}" y1="${padY}" x2="${width - padX}" y2="${padY}"></line>
          ${showOnline ? `<polyline class="history-line online-line" points="${this._escape(onlinePoints.join(" "))}"></polyline>` : ""}
          ${showOffline ? `<polyline class="history-line offline-line" points="${this._escape(offlinePoints.join(" "))}"></polyline>` : ""}
          ${showOnline ? onlineDots.join("") : ""}
          ${showOffline ? offlineDots.join("") : ""}
        </svg>
        <div class="history-hit-layer">${markers.join("")}</div>
        <div class="history-axis">
          <span>${this._escape(startLabel)}</span>
          <span>Max ${this._escape(maxValue)}</span>
          <span>${this._escape(endLabel)}</span>
        </div>
      </div>
    `;
  }

  _formatHistoryTime(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  _alertTemplate(offlineCount, offlineAreas) {
    const visibleAreas = this._alertExpanded ? offlineAreas : offlineAreas.slice(0, 8);
    const hiddenAreaCount = Math.max(0, offlineAreas.length - visibleAreas.length);
    return `
      <section class="alert-panel" aria-label="Offline device alert">
        <span class="alert-icon">!</span>
        <div class="alert-copy">
          <strong>${this._escape(offlineCount)} offline ${offlineCount === 1 ? "device" : "devices"}</strong>
          <span>${this._escape(offlineAreas.length)} affected ${offlineAreas.length === 1 ? "area" : "areas"}</span>
        </div>
        <div class="alert-areas">
          ${visibleAreas
            .map(
              ({ area, count }) => `
          <button type="button" data-alert-area="${this._escape(area)}">
            ${this._escape(area)} <span>${this._escape(count)}</span>
          </button>
          `
            )
            .join("")}
          ${
            hiddenAreaCount
              ? `<button type="button" class="more-areas" data-alert-more>+${this._escape(hiddenAreaCount)} more</button>`
              : this._alertExpanded && offlineAreas.length > 8
                ? `<button type="button" class="more-areas" data-alert-more>Show less</button>`
                : ""
          }
        </div>
      </section>
    `;
  }

  _areasTemplate(rows) {
    return [...this._groupByArea(rows).entries()]
      .map(([area, areaRows]) => {
        const offline = areaRows.filter((row) => row.offline).length;
        return `
          <section class="area">
            <div class="area-title">
              <h3>${this._escape(area)}</h3>
              <span>${offline} offline / ${areaRows.length} shown</span>
            </div>
            <div class="grid">
              ${areaRows.map((row) => this._deviceTemplate(row)).join("")}
            </div>
          </section>
        `;
      })
      .join("");
  }

  _deviceTemplate(row) {
    const changed = row.lastChanged ? new Date(row.lastChanged).toLocaleString() : "Unknown";
    const stateLabel = row.offline ? "Offline" : "Online";
    const simple = this._filters.displayMode === "simple";
    const icon = this._deviceIcon(row);

    return `
      <button class="device ${simple ? "simple" : "detailed"} ${row.offline ? "offline" : "online"}" data-entity="${this._escape(row.entityId)}">
        <span class="frame"></span>
        <span class="topline">
          <span class="identity">
            <span class="device-icon"><ha-icon icon="${this._escape(icon)}"></ha-icon></span>
            <span class="name">${this._escape(row.name)}</span>
          </span>
          <span class="pill">${this._escape(stateLabel)}</span>
        </span>
        ${
          simple
            ? `<span class="simple-meta">${this._escape(row.displayDomain || row.displayIntegration)}</span>`
            : `
        <span class="meta">${row.offlineEntities.length ? this._offlineEntityDetails(row.offlineEntities) : this._escape(`${row.entityCount} entities`)}</span>
              <span class="details">
                <span>${this._escape(row.displayDomain)}</span>
                <span>${this._escape(row.displayIntegration)}</span>
                <span>${this._escape(row.offlineEntities.length ? `${row.offlineEntities.length} offline` : row.state)}</span>
              </span>
              <span class="changed">Changed: ${this._escape(changed)}</span>
            `
        }
      </button>
    `;
  }

  _offlineEntityDetails(entities) {
    return entities
      .map((entity) => {
        const unique = entity.uniqueId ? ` (${entity.uniqueId})` : "";
        return `<span class="entity-detail">${this._escape(entity.name)}${this._escape(unique)}</span>`;
      })
      .join("");
  }

  _emptyTemplate(total) {
    const text = total ? "No devices match the current filters." : "No entities are available yet.";
    return `<div class="empty">${this._escape(text)}</div>`;
  }


  _escape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  _styles() {
    return `
      <style>
        :host {
          display: block;
          --odp-good: #1d8f5f;
          --odp-good-soft: rgba(29, 143, 95, 0.12);
          --odp-bad: #d43636;
          --odp-bad-soft: rgba(212, 54, 54, 0.14);
          --odp-border: var(--divider-color, rgba(127, 127, 127, 0.24));
          --odp-card: var(--card-background-color, #fff);
          --odp-muted: var(--secondary-text-color, #667085);
        }

        .panel {
          padding: 18px;
        }

        header {
          display: grid;
          grid-template-columns: minmax(180px, 1fr) auto minmax(140px, 1fr);
          align-items: center;
          gap: 16px;
          margin-bottom: 16px;
        }

        header > div {
          min-width: 0;
        }

        h2, h3, p {
          margin: 0;
        }

        h2 {
          color: var(--primary-text-color);
          font-size: 22px;
          font-weight: 650;
          line-height: 1.2;
        }

        p, .area-title span, .meta, .details, .changed, label span, .filter-label, .simple-meta {
          color: var(--odp-muted);
        }

        .badge {
          justify-self: end;
          border: 1px solid currentColor;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 650;
          padding: 7px 11px;
          white-space: nowrap;
        }

        .badge.good {
          color: var(--odp-good);
          background: var(--odp-good-soft);
        }

        .badge.bad {
          color: var(--odp-bad);
          background: var(--odp-bad-soft);
        }

        .alert-panel {
          display: grid;
          grid-template-columns: auto minmax(160px, auto) 1fr;
          align-items: center;
          gap: 12px;
          margin: -4px 0 16px;
          border: 1px solid rgba(212, 54, 54, 0.45);
          border-radius: 8px;
          background: linear-gradient(90deg, rgba(212, 54, 54, 0.18), rgba(212, 54, 54, 0.07));
          padding: 10px 12px;
        }

        .alert-icon {
          display: grid;
          place-items: center;
          width: 28px;
          height: 28px;
          border-radius: 999px;
          background: var(--odp-bad);
          color: #fff;
          font-size: 18px;
          font-weight: 900;
          box-shadow: 0 0 0 0 rgba(212, 54, 54, 0.45);
          animation: alert-pulse 1.8s ease-out infinite;
        }

        .alert-copy {
          display: grid;
          gap: 2px;
        }

        .alert-copy strong {
          color: var(--primary-text-color);
          font-size: 14px;
        }

        .alert-copy span,
        .more-areas {
          color: var(--odp-muted);
          font-size: 12px;
          font-weight: 650;
        }

        .alert-areas {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 6px;
          min-width: 0;
        }

        .alert-areas button {
          min-height: 28px;
          border-radius: 999px;
          padding: 0 9px;
        }

        .alert-areas button {
          border: 1px solid rgba(212, 54, 54, 0.45);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
        }

        .alert-areas button:hover {
          border-color: var(--odp-bad);
          color: var(--odp-bad);
        }

        .alert-areas button span {
          color: var(--odp-bad);
          margin-left: 4px;
        }

        .more-areas {
          border-color: var(--odp-border);
          color: var(--odp-muted);
          font-weight: 800;
        }

        .more-areas:hover {
          border: 1px solid var(--odp-border);
          color: var(--primary-text-color);
        }

        @keyframes alert-pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(212, 54, 54, 0.45);
          }
          70% {
            box-shadow: 0 0 0 9px rgba(212, 54, 54, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(212, 54, 54, 0);
          }
        }

        .panel-tabs {
          display: inline-flex;
          gap: 4px;
          justify-self: center;
          border: 1px solid var(--odp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          padding: 4px;
        }

        .panel-tabs button {
          min-height: 34px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--odp-muted);
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          font-weight: 800;
          padding: 0 14px;
        }

        .panel-tabs button.active {
          background: var(--odp-card);
          color: var(--primary-text-color);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
        }

        .history-panel {
          display: grid;
          gap: 12px;
          margin: 0 0 18px;
          border: 1px solid var(--odp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          padding: 12px;
        }

        .history-head,
        .history-legend,
        .history-row,
        .history-label {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .history-head {
          justify-content: space-between;
        }

        .history-legend span {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: var(--odp-muted);
          font-size: 12px;
          font-weight: 700;
        }

        .history-legend i {
          display: inline-block;
          width: 10px;
          height: 10px;
          border-radius: 3px;
        }

        .online-key {
          background: var(--odp-good);
        }

        .offline-key {
          background: var(--odp-bad);
        }

        .history-controls {
          display: grid;
          grid-template-columns: repeat(3, minmax(160px, 240px));
          gap: 10px;
          align-items: end;
        }

        .history-controls label {
          display: grid;
          gap: 5px;
        }

        .history-controls span {
          color: var(--odp-muted);
          font-size: 12px;
          font-weight: 700;
        }

        .history-grid {
          display: grid;
          gap: 14px;
        }

        .history-row {
          min-width: 0;
          border: 1px solid var(--odp-border);
          border-left: 4px solid rgba(127, 127, 127, 0.42);
          border-radius: 8px;
          background: var(--odp-card);
          padding: 12px;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
        }

        .history-row.featured {
          border-left-color: var(--primary-color, #03a9f4);
        }

        .history-label {
          flex: 0 0 clamp(220px, 18vw, 320px);
          justify-content: space-between;
          min-width: 0;
          align-self: stretch;
          border-right: 1px solid var(--odp-border);
          padding-right: 12px;
        }

        .history-label strong {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .history-label span {
          flex: 0 0 auto;
          color: var(--odp-muted);
          font-size: 11px;
          font-weight: 700;
          white-space: nowrap;
        }

        .history-chart {
          position: relative;
          display: grid;
          gap: 4px;
          width: 100%;
          min-width: 0;
        }

        .history-chart svg {
          display: block;
          width: 100%;
          height: 92px;
          border-radius: 6px;
          background: rgba(127, 127, 127, 0.07);
        }

        .history-row.featured .history-chart svg {
          height: 180px;
        }

        .history-grid-line {
          stroke: var(--odp-border);
          stroke-width: 1;
          vector-effect: non-scaling-stroke;
        }

        .history-line {
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 2.5;
          vector-effect: non-scaling-stroke;
        }

        .online-line {
          stroke: var(--odp-good);
        }

        .offline-line {
          stroke: var(--odp-bad);
        }

        .history-dot {
          stroke: var(--odp-card);
          stroke-width: 1.5;
          vector-effect: non-scaling-stroke;
        }

        .online-dot {
          fill: var(--odp-good);
        }

        .offline-dot {
          fill: var(--odp-bad);
        }

        .history-row.featured .history-line {
          stroke-width: 3;
        }

        .history-hit-layer {
          position: absolute;
          inset: 0 0 18px 0;
        }

        .history-hit {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 16px;
          transform: translateX(-50%);
        }

        .history-axis {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          color: var(--odp-muted);
          font-size: 10px;
          font-weight: 700;
        }

        .history-empty-line {
          display: grid;
          place-items: center;
          min-height: 56px;
          border: 1px dashed var(--odp-border);
          border-radius: 6px;
          color: var(--odp-muted);
          font-size: 12px;
        }

        .filters {
          display: grid;
          grid-template-columns: repeat(6, minmax(130px, 1fr));
          gap: 10px;
          margin-bottom: 18px;
        }

        label, .multi {
          display: grid;
          gap: 5px;
          min-width: 0;
        }

        label span, .filter-label {
          font-size: 12px;
          font-weight: 650;
        }

        select, input, summary {
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          border: 1px solid var(--odp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          font: inherit;
          min-height: 40px;
          padding: 0 10px;
        }

        details {
          position: relative;
        }

        summary {
          display: flex;
          align-items: center;
          cursor: pointer;
          list-style: none;
        }

        summary::-webkit-details-marker {
          display: none;
        }

        summary::after {
          content: "v";
          margin-left: auto;
          font-size: 18px;
          line-height: 1;
        }

        details[open] summary {
          border-color: var(--primary-color, #03a9f4);
        }

        .multi-menu {
          position: absolute;
          z-index: 3;
          inset: calc(100% + 5px) 0 auto 0;
          display: grid;
          gap: 2px;
          max-height: 260px;
          overflow: auto;
          border: 1px solid var(--odp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 14px 28px rgba(0, 0, 0, 0.22);
          padding: 6px;
        }

        .check-row {
          display: flex;
          align-items: center;
          gap: 8px;
          border-radius: 6px;
          cursor: pointer;
          min-height: 34px;
          padding: 0 8px;
        }

        .check-row:hover, .clear:hover, .single-option:hover {
          background: var(--secondary-background-color, #f7f8fa);
        }

        .check-row input {
          width: 16px;
          min-height: 16px;
          padding: 0;
        }

        .check-row span {
          min-width: 0;
          overflow-wrap: anywhere;
          color: var(--primary-text-color);
          font-size: 13px;
          font-weight: 500;
        }

        .clear {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          font-weight: 700;
          min-height: 34px;
          padding: 0 8px;
          text-align: left;
        }

        .single-option {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          min-height: 34px;
          padding: 0 8px;
          text-align: left;
          width: 100%;
        }

        .single-option.active {
          color: var(--primary-color, #03a9f4);
          font-weight: 800;
        }

        .no-options {
          color: var(--odp-muted);
          font-size: 13px;
          padding: 8px;
        }

        .area + .area {
          margin-top: 20px;
        }

        .area-title {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 10px;
        }

        h3 {
          color: var(--primary-text-color);
          font-size: 16px;
          font-weight: 700;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
          gap: 10px;
        }

        .device {
          position: relative;
          display: grid;
          gap: 8px;
          min-height: 138px;
          text-align: left;
          border: 2px solid var(--odp-border);
          border-radius: 8px;
          padding: 13px;
          background: var(--odp-card);
          color: var(--primary-text-color);
          cursor: pointer;
          overflow: hidden;
        }

        .device.simple {
          align-content: center;
          gap: 7px;
          min-height: 88px;
        }

        .device.offline {
          border-color: var(--odp-bad);
          box-shadow: inset 0 0 0 1px rgba(212, 54, 54, 0.2);
        }

        .device.online {
          border-color: var(--odp-good);
          box-shadow: inset 0 0 0 1px rgba(29, 143, 95, 0.18);
        }

        .frame {
          position: absolute;
          inset: 0 auto 0 0;
          width: 7px;
          background: var(--odp-good);
        }

        .offline .frame {
          background: var(--odp-bad);
        }

        .topline, .details {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .topline {
          justify-content: space-between;
        }

        .identity {
          display: grid;
          grid-template-columns: 32px minmax(0, 1fr);
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .device-icon {
          display: grid;
          place-items: center;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          color: var(--odp-good);
          background: var(--odp-good-soft);
        }

        .offline .device-icon {
          color: var(--odp-bad);
          background: var(--odp-bad-soft);
        }

        .device-icon ha-icon {
          --mdc-icon-size: 20px;
        }

        .name {
          min-width: 0;
          overflow-wrap: anywhere;
          font-size: 15px;
          font-weight: 700;
          line-height: 1.25;
        }

        .pill {
          flex: 0 0 auto;
          border-radius: 999px;
          padding: 4px 8px;
          font-size: 12px;
          font-weight: 700;
          color: #fff;
          background: var(--odp-good);
        }

        .offline .pill {
          background: var(--odp-bad);
        }

        .meta {
          display: grid;
          gap: 3px;
          overflow-wrap: anywhere;
          font-size: 12px;
        }

        .entity-detail {
          display: block;
        }

        .details {
          flex-wrap: wrap;
          font-size: 12px;
        }

        .details span {
          border: 1px solid var(--odp-border);
          border-radius: 999px;
          padding: 3px 7px;
        }

        .changed {
          align-self: end;
          font-size: 12px;
        }

        .simple-meta {
          overflow-wrap: anywhere;
          font-size: 12px;
        }

        .empty {
          border: 1px dashed var(--odp-border);
          border-radius: 8px;
          color: var(--odp-muted);
          padding: 28px;
          text-align: center;
        }

        @media (max-width: 760px) {
          .panel {
            padding: 14px;
          }

          header {
            grid-template-columns: 1fr;
          }

          .panel-tabs,
          .badge {
            justify-self: start;
          }

          .area-title {
            align-items: flex-start;
            flex-direction: column;
          }

          .alert-panel {
            grid-template-columns: auto 1fr;
          }

          .alert-areas {
            grid-column: 1 / -1;
            justify-content: flex-start;
          }

          .history-head,
          .history-row {
            align-items: stretch;
            flex-direction: column;
          }

          .history-label {
            flex: none;
            border-right: 0;
            border-bottom: 1px solid var(--odp-border);
            padding: 0 0 10px;
          }

          .history-controls {
            grid-template-columns: 1fr;
          }

          .filters {
            grid-template-columns: 1fr;
          }

          .grid {
            grid-template-columns: 1fr;
          }
        }
      </style>
    `;
  }
}

customElements.define("offline-device-panel", OfflineDevicePanel);
class AreaOfflineAlarmButton extends HTMLElement {
  static getConfigElement() {
    return document.createElement("area-offline-alarm-button-editor");
  }

  static getStubConfig() {
    return {
      area: "Studio Building Floor 1",
      floor_id: "sb_f1",
      map_path: "/dashboard-main/maps",
      offline_states: ["unavailable", "unknown"],
      show_when_clear: true,
      show_count: true,
      show_name: true,
      button_height: 52,
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._registriesLoaded = false;
    this._entities = [];
    this._devices = [];
    this._areas = [];
  }

  setConfig(config) {
    this._config = {
      area: "",
      area_id: "",
      floor_id: "",
      map_path: "/dashboard-main/maps",
      offline_states: ["unavailable", "unknown"],
      domains: [],
      integrations: [],
      excluded_entities: [],
      show_when_clear: false,
      show_count: true,
      show_name: true,
      button_height: 52,
      icon: "mdi:alert-circle",
      clear_icon: "mdi:check-circle-outline",
      name: "Offline devices",
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadRegistries(hass);
    this._render();
  }

  getCardSize() {
    const summary = this._summary();
    return summary.offline || this._config.show_when_clear ? 1 : 0;
  }

  async _loadRegistries(hass) {
    if (this._registriesLoaded || !hass?.callWS) return;
    this._registriesLoaded = true;

    try {
      const [entities, devices, areas] = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/device_registry/list" }),
        hass.callWS({ type: "config/area_registry/list" }),
      ]);
      this._entities = entities || [];
      this._devices = devices || [];
      this._areas = areas || [];
      this._render();
    } catch (error) {
      console.warn("area-offline-alarm-button: registry lookup failed", error);
    }
  }

  _summary() {
    const rows = this._areaRows();
    const offlineRows = rows.filter((row) => row.offline);
    return {
      rows,
      offlineRows,
      total: rows.length,
      offline: offlineRows.length,
    };
  }

  _areaRows() {
    if (!this._hass?.states) return [];

    const areaFilter = String(this._config.area_id || this._config.area || "").trim();
    if (!areaFilter) return [];

    const entityRegistry = new Map(this._entities.map((entity) => [entity.entity_id, entity]));
    const deviceRegistry = new Map(this._devices.map((device) => [device.id, device]));
    const areaRegistry = new Map(this._areas.map((area) => [area.area_id || area.id, area]));
    const excludedEntities = new Set((this._config.excluded_entities || []).map((entityId) => String(entityId).trim()).filter(Boolean));
    const grouped = new Map();

    for (const [entityId, stateObj] of Object.entries(this._hass.states)) {
      if (excludedEntities.has(entityId)) continue;
      const domain = entityId.split(".")[0];
      if (this._config.domains.length && !this._config.domains.includes(domain)) continue;

      const entity = entityRegistry.get(entityId);
      const device = entity?.device_id ? deviceRegistry.get(entity.device_id) : null;
      const integration = this._integration(entity, stateObj);
      if (this._config.integrations.length && !this._config.integrations.includes(integration)) continue;

      const areaId = entity?.area_id || device?.area_id || stateObj.attributes?.area_id || "unknown";
      const area = areaRegistry.get(areaId);
      const areaName = area?.name || stateObj.attributes?.area || (areaId === "unknown" ? "No area" : areaId);
      if (!this._areaMatches(areaFilter, areaId, areaName)) continue;

      const key = entity?.device_id || entityId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          entityId,
          name: device?.name_by_user || device?.name || stateObj.attributes?.friendly_name || entityId,
          offline: false,
          offlineEntities: [],
        });
      }

      const row = grouped.get(key);
      const offline = this._isOffline(stateObj.state);
      row.offline = row.offline || offline;
      if (offline) {
        row.offlineEntities.push({
          entityId,
          name: stateObj.attributes?.friendly_name || entity?.name || entityId,
        });
      }
    }

    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  _areaMatches(filter, areaId, areaName) {
    const normalizedFilter = this._normalizeAreaValue(filter);
    return [areaId, areaName].some((value) => value && (value === filter || this._normalizeAreaValue(value) === normalizedFilter));
  }

  _normalizeAreaValue(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  _integration(entity, stateObj) {
    if (entity?.platform) return entity.platform;
    const attr = stateObj.attributes || {};
    return attr.integration || attr.platform || "unknown";
  }

  _isOffline(state) {
    return (this._config.offline_states || []).map((value) => String(value).toLowerCase()).includes(String(state).toLowerCase());
  }

  _navigationPath() {
    const mapPath = String(this._config.map_path || "/dashboard-main/maps").trim();
    const floorId = String(this._config.floor_id || this._config.floor || this._config.area_id || this._config.area || "").trim();
    const joiner = mapPath.includes("?") ? "&" : "?";
    return `${mapPath}${joiner}dmp_floor=${encodeURIComponent(floorId)}&dmp_offline=1`;
  }

  _navigate() {
    const path = this._navigationPath();
    if (/^https?:\/\//i.test(path)) {
      window.location.assign(path);
      return;
    }
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _render() {
    if (!this.shadowRoot) return;
    const summary = this._summary();
    const offline = summary.offline > 0;
    const emptyArea = !offline && summary.total === 0;
    const visible = offline || this._config.show_when_clear;
    const icon = offline ? this._config.icon : emptyArea ? "mdi:map-marker-question" : this._config.clear_icon;
    const buttonHeight = this._buttonHeight();
    const showName = this._config.show_name !== false;
    const areaLabel = this._config.area || this._config.area_id || "area";
    const title = offline
      ? `${summary.offline} offline ${summary.offline === 1 ? "device" : "devices"} in ${areaLabel} (${summary.total} matched)`
      : emptyArea
        ? `No entities matched ${areaLabel}. Check the area id/name or dashboard user permissions.`
        : `No offline devices in ${areaLabel} (${summary.total} matched)`;
    const label = this._config.name || (offline ? "Offline devices" : emptyArea ? "No area entities" : "Clear");

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: ${visible ? "block" : "none"};
        }

        ha-card {
          border: 0;
          background: transparent;
          box-shadow: none;
        }

        button {
          position: relative;
          display: inline-grid;
          grid-auto-flow: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-width: 44px;
          min-height: ${buttonHeight}px;
          width: 100%;
          border: 1px solid rgba(255, 255, 255, 0.24);
          border-radius: 12px;
          background: ${offline ? "var(--error-color, #db4437)" : emptyArea ? "var(--warning-color, #f59e0b)" : "var(--success-color, #1d8f5f)"};
          color: #fff;
          cursor: pointer;
          font: inherit;
          font-weight: 800;
          padding: ${showName ? "10px 12px" : "10px"};
          transition: transform 120ms ease, filter 120ms ease, box-shadow 120ms ease;
        }

        button:hover {
          filter: brightness(1.06);
          transform: translateY(-1px);
          box-shadow: ${offline ? "0 6px 18px rgba(219, 68, 55, 0.36)" : "0 4px 12px rgba(0, 0, 0, 0.14)"};
        }

        ha-icon {
          --mdc-icon-size: 22px;
        }

        .name {
          font-size: 13px;
          line-height: 1.2;
          white-space: nowrap;
        }

        .count {
          position: absolute;
          top: -7px;
          right: -7px;
          display: ${this._config.show_count && (offline || emptyArea) ? "grid" : "none"};
          place-items: center;
          min-width: 20px;
          height: 20px;
          border: 2px solid var(--card-background-color, #fff);
          border-radius: 999px;
          background: #fff;
          color: var(--error-color, #db4437);
          font-size: 11px;
          font-weight: 900;
          line-height: 1;
          padding: 0 5px;
        }
      </style>
      <ha-card>
        <button type="button" title="${this._escape(title)}" aria-label="${this._escape(title)}">
          <ha-icon icon="${this._escape(icon)}"></ha-icon>
          ${showName ? `<span class="name">${this._escape(label)}</span>` : ""}
          <span class="count">${this._escape(offline ? summary.offline : summary.total)}</span>
        </button>
      </ha-card>
    `;

    this.shadowRoot.querySelector("button")?.addEventListener("click", () => this._navigate());
  }

  _buttonHeight() {
    const value = Number(this._config.button_height);
    if (!Number.isFinite(value)) return 52;
    return Math.min(Math.max(value, 44), 96);
  }

  _escape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

customElements.define("area-offline-alarm-button", AreaOfflineAlarmButton);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "area-offline-alarm-button",
  name: "Area Offline Alarm Button",
  description: "Shows a red alarm button when any device in a Home Assistant area is offline and links to the matching map floor.",
});

class DevicePanelConfigEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
  }

  set hass(hass) {
    this._hass = hass;
    this._handleHassChanged?.(hass);
  }


  _escape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _arrayText(value) {
    return Array.isArray(value) ? value.join("\n") : "";
  }

  _arrayFromText(value) {
    return String(value || "")
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  _field(key, label, options = {}) {
    const type = options.type || "text";
    const value = this._config?.[key] ?? options.defaultValue ?? "";
    return `
      <label>
        <span>${this._escape(label)}</span>
        <input data-config-key="${this._escape(key)}" type="${this._escape(type)}" value="${this._escape(value)}" ${options.min !== undefined ? `min="${this._escape(options.min)}"` : ""} ${options.max !== undefined ? `max="${this._escape(options.max)}"` : ""} ${options.step !== undefined ? `step="${this._escape(options.step)}"` : ""} />
      </label>
    `;
  }

  _textarea(key, label, options = {}) {
    const value = options.value !== undefined ? options.value : this._arrayText(this._config?.[key]);
    return `
      <label>
        <span>${this._escape(label)}</span>
        <textarea data-config-key="${this._escape(key)}" rows="${this._escape(options.rows || 4)}">${this._escape(value)}</textarea>
      </label>
    `;
  }

  _checkbox(key, label, options = {}) {
    const checked = this._config?.[key] ?? options.defaultValue;
    return `
      <label class="check-row">
        <input data-config-key="${this._escape(key)}" type="checkbox" ${checked ? "checked" : ""} />
        <span>${this._escape(label)}</span>
      </label>
    `;
  }

  _select(key, label, options) {
    const value = this._config?.[key] ?? options[0]?.[0] ?? "";
    return `
      <label>
        <span>${this._escape(label)}</span>
        <select data-config-key="${this._escape(key)}">
          ${options.map(([optionValue, text]) => `<option value="${this._escape(optionValue)}" ${value === optionValue ? "selected" : ""}>${this._escape(text)}</option>`).join("")}
        </select>
      </label>
    `;
  }

  _multiPicker(key, label, options, config = {}) {
    const selected = new Set(Array.isArray(this._config?.[key]) ? this._config[key] : []);
    const optionMap = new Map();
    (options || []).forEach((option) => {
      const [value, text] = Array.isArray(option) ? option : [option, option];
      if (value) optionMap.set(String(value), String(text || value));
    });
    selected.forEach((value) => {
      if (value && !optionMap.has(value)) optionMap.set(value, value);
    });
    const mergedOptions = [...optionMap.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
    const labels = config.labelKey ? this._config?.[config.labelKey] || {} : {};
    const choices = mergedOptions.length
      ? mergedOptions
          .map(
            ([value, text]) => `
              <div class="choice ${config.labelKey ? "with-alias" : ""}" data-picker-choice="${this._escape(key)}" data-search-text="${this._escape(`${value} ${text}`.toLowerCase())}">
                <label>
                  <input type="checkbox" data-config-multi="${this._escape(key)}" value="${this._escape(value)}" ${selected.has(value) ? "checked" : ""} />
                  <span title="${this._escape(value)}">${this._escape(text)}</span>
                </label>
                ${
                  config.labelKey
                    ? `<input class="alias-input" data-config-label="${this._escape(config.labelKey)}" data-label-value="${this._escape(value)}" value="${this._escape(labels[value] || "")}" placeholder="${this._escape(config.placeholder || "Custom name")}" />`
                    : ""
                }
              </div>
            `
          )
          .join("")
      : `<div class="empty-options">No options found yet</div>`;

    return `
      <div class="picker" data-picker="${this._escape(key)}">
        <div class="picker-head">
          <span>${this._escape(label)}</span>
          <button type="button" data-clear-multi="${this._escape(key)}">All</button>
        </div>
        ${config.search ? `<input class="picker-search" data-picker-search="${this._escape(key)}" placeholder="${this._escape(config.searchPlaceholder || "Search...")}" />` : ""}
        <div class="choice-grid">${choices}</div>
      </div>
    `;
  }

  _editorStyle() {
    return `
      <style>
        .editor {
          display: grid;
          gap: 16px;
          padding: 12px;
          color: var(--primary-text-color);
        }

        fieldset {
          border: 1px solid var(--divider-color, #d8dde6);
          border-radius: 8px;
          display: grid;
          gap: 12px;
          margin: 0;
          padding: 12px;
        }

        legend {
          color: var(--secondary-text-color);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        label {
          display: grid;
          gap: 6px;
        }

        label span {
          color: var(--secondary-text-color);
          font-size: 12px;
          font-weight: 700;
        }

        input, select, textarea {
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #d8dde6);
          border-radius: 6px;
          box-sizing: border-box;
          color: var(--primary-text-color);
          font: inherit;
          min-height: 40px;
          padding: 8px 10px;
          width: 100%;
        }

        textarea {
          font-family: var(--code-font-family, Consolas, Monaco, monospace);
          min-height: 96px;
          resize: vertical;
        }

        .check-row {
          align-items: center;
          display: flex;
          gap: 10px;
        }

        .check-row input {
          min-height: auto;
          width: auto;
        }

        .picker {
          display: grid;
          gap: 8px;
        }

        .picker-head {
          align-items: center;
          display: flex;
          justify-content: space-between;
          gap: 8px;
        }

        .picker-head span {
          color: var(--secondary-text-color);
          font-size: 12px;
          font-weight: 700;
        }

        .picker-head button {
          background: transparent;
          border: 1px solid var(--divider-color, #d8dde6);
          color: var(--primary-color, #03a9f4);
          min-height: 30px;
          padding: 4px 10px;
        }

        .choice-grid {
          border: 1px solid var(--divider-color, #d8dde6);
          border-radius: 6px;
          display: grid;
          gap: 2px;
          max-height: 190px;
          overflow: auto;
          padding: 6px;
        }

        .picker-search {
          min-height: 36px;
        }

        .choice {
          align-items: center;
          border-radius: 4px;
          display: grid;
          gap: 8px;
          grid-template-columns: 1fr;
          min-height: 30px;
          padding: 3px 6px;
        }

        .choice.with-alias {
          grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr);
        }

        .choice:hover {
          background: var(--secondary-background-color, #f5f7fa);
        }

        .choice label {
          align-items: center;
          display: flex;
          gap: 8px;
          min-width: 0;
        }

        .choice input {
          min-height: auto;
          width: auto;
        }

        .choice .alias-input {
          min-height: 32px;
          width: 100%;
        }

        .choice span {
          color: var(--primary-text-color);
          font-size: 13px;
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .empty-options {
          color: var(--secondary-text-color);
          font-size: 12px;
          padding: 8px;
        }

        .selected-list {
          border: 1px solid var(--divider-color, #d8dde6);
          border-radius: 6px;
          display: grid;
          gap: 6px;
          padding: 8px;
        }

        .selected-row {
          align-items: center;
          display: grid;
          gap: 8px;
          grid-template-columns: 1fr auto;
        }

        .selected-row span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .remove-chip {
          background: transparent;
          border: 1px solid var(--divider-color, #d8dde6);
          color: var(--primary-text-color);
          min-height: 30px;
          padding: 4px 10px;
        }

        .modal-backdrop {
          align-items: center;
          background: rgba(0, 0, 0, 0.42);
          display: flex;
          inset: 0;
          justify-content: center;
          padding: 18px;
          position: fixed;
          z-index: 1000;
        }

        .modal {
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #d8dde6);
          border-radius: 8px;
          box-shadow: 0 18px 42px rgba(0, 0, 0, 0.32);
          display: grid;
          gap: 12px;
          max-height: min(720px, 86vh);
          max-width: 720px;
          padding: 14px;
          width: min(720px, 100%);
        }

        .modal .choice-grid {
          max-height: min(560px, 58vh);
        }

        .modal-head {
          align-items: center;
          display: flex;
          gap: 10px;
          justify-content: space-between;
        }

        .modal-head strong {
          font-size: 16px;
        }

        button {
          align-self: start;
          background: var(--primary-color, #03a9f4);
          border: 0;
          border-radius: 6px;
          color: var(--text-primary-color, #fff);
          cursor: pointer;
          font-weight: 700;
          min-height: 38px;
          padding: 8px 12px;
        }

        .error {
          color: var(--error-color, #db4437);
          font-size: 12px;
          font-weight: 700;
        }
      </style>
    `;
  }

  _wireBasicInputs(arrayKeys = []) {
    this.shadowRoot.querySelectorAll("[data-config-key]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.currentTarget.dataset.configKey;
        let value;
        if (event.currentTarget.type === "checkbox") {
          value = event.currentTarget.checked;
        } else if (event.currentTarget.type === "number") {
          value = Number(event.currentTarget.value);
        } else if (arrayKeys.includes(key)) {
          value = this._arrayFromText(event.currentTarget.value);
        } else {
          value = event.currentTarget.value;
        }
        this._emitConfig({ ...this._config, [key]: value });
      });
    });
  }

  _wireMultiPickers() {
    this.shadowRoot.querySelectorAll("[data-config-multi]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.currentTarget.dataset.configMulti;
        const values = [...this.shadowRoot.querySelectorAll(`[data-config-multi="${this._cssEscape(key)}"]:checked`)].map((input) => input.value);
        this._emitConfig({ ...this._config, [key]: values });
      });
    });

    this.shadowRoot.querySelectorAll("[data-clear-multi]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const key = event.currentTarget.dataset.clearMulti;
        this.shadowRoot.querySelectorAll(`[data-config-multi="${this._cssEscape(key)}"]`).forEach((input) => {
          input.checked = false;
        });
        this._emitConfig({ ...this._config, [key]: [] });
      });
    });
  }

  _wirePickerSearch() {
    this.shadowRoot.querySelectorAll("[data-picker-search]").forEach((element) => {
      element.addEventListener("input", (event) => {
        const key = event.currentTarget.dataset.pickerSearch;
        const query = event.currentTarget.value.trim().toLowerCase();
        this.shadowRoot.querySelectorAll(`[data-picker-choice="${this._cssEscape(key)}"]`).forEach((choice) => {
          choice.style.display = query && !String(choice.dataset.searchText || "").includes(query) ? "none" : "";
        });
      });
    });
  }

  _wireLabelInputs() {
    this.shadowRoot.querySelectorAll("[data-config-label]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.currentTarget.dataset.configLabel;
        const valueKey = event.currentTarget.dataset.labelValue;
        const label = event.currentTarget.value.trim();
        const labels = { ...(this._config?.[key] || {}) };
        if (label) {
          labels[valueKey] = label;
        } else {
          delete labels[valueKey];
        }
        this._emitConfig({ ...this._config, [key]: labels });
      });
    });
  }

  _cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  _emitConfig(config) {
    this._config = config;
    this._skipNextSetConfigRender = true;
    window.setTimeout(() => {
      this._skipNextSetConfigRender = false;
    }, 500);
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        bubbles: true,
        composed: true,
        detail: { config },
      })
    );
  }
}

class AreaOfflineAlarmButtonEditor extends DevicePanelConfigEditor {
  constructor() {
    super();
    this._entities = [];
    this._areas = [];
    this._registriesLoaded = false;
    this._optionsSignature = "";
  }

  setConfig(config) {
    const nextConfig = {
      area: "",
      area_id: "",
      floor_id: "",
      map_path: "/dashboard-main/maps",
      offline_states: ["unavailable", "unknown"],
      domains: [],
      integrations: [],
      excluded_entities: [],
      show_when_clear: true,
      show_count: true,
      show_name: true,
      button_height: 52,
      icon: "mdi:alert-circle",
      clear_icon: "mdi:check-circle-outline",
      name: "Offline devices",
      ...config,
    };
    if (!nextConfig.area && nextConfig.area_id) nextConfig.area = nextConfig.area_id;
    this._config = nextConfig;
    if (this._skipNextSetConfigRender) {
      this._skipNextSetConfigRender = false;
      return;
    }
    this._renderEditor();
  }

  _handleHassChanged(hass) {
    this._loadEditorRegistries(hass);
    this._renderEditorIfOptionsChanged();
  }

  async _loadEditorRegistries(hass) {
    if (this._registriesLoaded || !hass?.callWS) return;
    this._registriesLoaded = true;
    try {
      const [entities, areas] = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/area_registry/list" }),
      ]);
      this._entities = entities || [];
      this._areas = areas || [];
      this._renderEditorIfOptionsChanged();
    } catch (error) {
      console.warn("area-offline-alarm-button-editor: registry lookup failed", error);
    }
  }

  _renderEditor() {
    if (!this._config) return;
    this._optionsSignature = this._currentOptionsSignature();
    this.shadowRoot.innerHTML = `
      ${this._editorStyle()}
      <div class="editor">
        <fieldset>
          <legend>Navigation</legend>
          ${this._areaSelector()}
          ${this._field("floor_id", "Map floor id")}
          ${this._field("map_path", "Map dashboard path")}
        </fieldset>
        <fieldset>
          <legend>Display</legend>
          ${this._field("name", "Button label")}
          ${this._field("button_height", "Button height", { type: "number", min: 44, max: 96, step: 1, defaultValue: 52 })}
          ${this._checkbox("show_when_clear", "Show green button when clear", { defaultValue: true })}
          ${this._checkbox("show_name", "Show text label", { defaultValue: true })}
          ${this._checkbox("show_count", "Show count badge", { defaultValue: true })}
          ${this._field("icon", "Offline icon")}
          ${this._field("clear_icon", "Clear icon")}
        </fieldset>
        <fieldset>
          <legend>Filters</legend>
          ${this._textarea("offline_states", "Offline states", { rows: 3 })}
          ${this._multiPicker("domains", "Domains to include", this._domainOptions())}
          ${this._multiPicker("integrations", "Integrations to include", this._integrationOptions())}
          ${this._textarea("excluded_entities", "Excluded entities", { rows: 3 })}
        </fieldset>
      </div>
    `;
    this._wireAreaSelector();
    this._wireBasicInputs(["offline_states", "excluded_entities"]);
    this._wireMultiPickers();
    this._wirePickerSearch();
  }

  _renderEditorIfOptionsChanged() {
    if (!this._config) return;
    const signature = this._currentOptionsSignature();
    if (signature === this._optionsSignature) return;
    this._renderEditor();
  }

  _currentOptionsSignature() {
    return JSON.stringify({
      areas: this._areaOptions(),
      domains: this._domainOptions(),
      integrations: this._integrationOptions(),
    });
  }

  _areaSelector() {
    const selected = String(this._config.area || this._config.area_id || "");
    const options = this._areaOptions();
    if (!options.length) {
      return `
        <label>
          <span>Home Assistant area</span>
          <input data-config-area type="text" value="${this._escape(selected)}" />
        </label>
      `;
    }

    const optionMap = new Map([["", "Select an area"]]);
    options.forEach(([value, text]) => optionMap.set(value, text));
    if (selected && !optionMap.has(selected)) optionMap.set(selected, selected);

    return `
      <label>
        <span>Home Assistant area</span>
        <select data-config-area>
          ${[...optionMap.entries()].map(([value, text]) => `<option value="${this._escape(value)}" ${value === selected ? "selected" : ""}>${this._escape(text)}</option>`).join("")}
        </select>
      </label>
    `;
  }

  _wireAreaSelector() {
    this.shadowRoot.querySelectorAll("[data-config-area]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const nextConfig = { ...this._config, area: event.currentTarget.value };
        delete nextConfig.area_id;
        this._emitConfig(nextConfig);
      });
    });
  }

  _areaOptions() {
    const optionMap = new Map();
    this._areas.forEach((area) => {
      const areaId = String(area.area_id || area.id || "").trim();
      const name = String(area.name || areaId).trim();
      const value = areaId || name;
      if (!value) return;
      optionMap.set(value, name && name !== value ? `${name} (${value})` : value);
    });

    const states = this._hass?.states || {};
    Object.values(states).forEach((stateObj) => {
      [stateObj.attributes?.area_id, stateObj.attributes?.area].filter(Boolean).forEach((value) => {
        const text = String(value);
        if (!optionMap.has(text)) optionMap.set(text, text);
      });
    });

    return [...optionMap.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }

  _domainOptions() {
    const states = this._hass?.states || {};
    return [...new Set(Object.keys(states).map((entityId) => entityId.split(".")[0]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _integrationOptions() {
    const states = this._hass?.states || {};
    const fromRegistry = this._entities.map((entity) => entity.platform).filter(Boolean);
    const fromStates = Object.values(states)
      .flatMap((stateObj) => [stateObj.attributes?.integration, stateObj.attributes?.platform])
      .filter(Boolean);
    return [...new Set([...fromRegistry, ...fromStates])].sort((a, b) => a.localeCompare(b));
  }
}

customElements.define("area-offline-alarm-button-editor", AreaOfflineAlarmButtonEditor);

class OfflineDevicePanelEditor extends DevicePanelConfigEditor {
  constructor() {
    super();
    this._entities = [];
    this._areas = [];
    this._registriesLoaded = false;
    this._optionsSignature = "";
    this._excludedPickerOpen = false;
  }

  setConfig(config) {
    const nextConfig = {
      title: "Offline Devices",
      show_online: true,
      display_mode: "detailed",
      offline_states: ["unavailable", "unknown"],
      columns: "auto",
      domains: [],
      integrations: [],
      areas: [],
      excluded_entities: [],
      show_history_chart: true,
      history_max_points: 96,
      history_sample_interval_minutes: 1440,
      domain_labels: {},
      integration_labels: {},
      force_simple: false,
      persist_filters: true,
      ...config,
    };
    this._config = nextConfig;
    if (this._skipNextSetConfigRender) {
      this._skipNextSetConfigRender = false;
      return;
    }
    this._renderEditor();
  }

  _handleHassChanged(hass) {
    this._loadEditorRegistries(hass);
    this._renderEditorIfOptionsChanged();
  }

  async _loadEditorRegistries(hass) {
    if (this._registriesLoaded || !hass?.callWS) return;
    this._registriesLoaded = true;
    try {
      const [entities, areas] = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/area_registry/list" }),
      ]);
      this._entities = entities || [];
      this._areas = areas || [];
      this._renderEditorIfOptionsChanged();
    } catch (error) {
      console.warn("offline-device-panel-editor: registry lookup failed", error);
    }
  }

  _renderEditor() {
    if (!this._config) return;
    this._optionsSignature = this._currentOptionsSignature();
    this.shadowRoot.innerHTML = `
      ${this._editorStyle()}
      <div class="editor">
        <fieldset>
          <legend>General</legend>
          ${this._field("title", "Title")}
          ${this._select("display_mode", "Card style", [
            ["detailed", "Detailed"],
            ["simple", "Simple"],
          ])}
          ${this._checkbox("show_online", "Allow online devices", { defaultValue: true })}
          ${this._checkbox("force_simple", "Force simple mode", { defaultValue: false })}
          ${this._checkbox("persist_filters", "Remember filters in this browser", { defaultValue: true })}
          ${this._checkbox("show_history_chart", "Show availability history", { defaultValue: true })}
          ${this._field("history_max_points", "History samples", { type: "number", min: 6, max: 288, step: 1, defaultValue: 96 })}
          ${this._field("history_sample_interval_minutes", "History interval minutes", { type: "number", min: 1, max: 1440, step: 1, defaultValue: 1440 })}
          ${this._field("columns", "Columns")}
        </fieldset>
        <fieldset>
          <legend>Filters</legend>
          ${this._textarea("offline_states", "Offline states", { rows: 3 })}
          ${this._multiPicker("domains", "Domains to include", this._domainOptions(), { labelKey: "domain_labels", placeholder: "Custom domain name" })}
          ${this._multiPicker("integrations", "Integrations to include", this._integrationOptions(), { labelKey: "integration_labels", placeholder: "Custom integration name" })}
          ${this._multiPicker("areas", "Areas to include", this._areaOptions())}
        </fieldset>
        <fieldset>
          <legend>Excluded Entities</legend>
          ${this._excludedEntitiesTemplate()}
        </fieldset>
        ${this._excludedPickerOpen ? this._excludedEntityModal() : ""}
      </div>
    `;
    this._wireBasicInputs(["offline_states"]);
    this._wireMultiPickers();
    this._wirePickerSearch();
    this._wireLabelInputs();
    this._wireExcludedEntityPicker();
  }

  _renderEditorIfOptionsChanged() {
    if (!this._config) return;
    const signature = this._currentOptionsSignature();
    if (signature === this._optionsSignature) return;
    this._renderEditor();
  }

  _currentOptionsSignature() {
    return JSON.stringify({
      domains: this._domainOptions(),
      integrations: this._integrationOptions(),
      areas: this._areaOptions(),
      entities: this._entityOptions(),
    });
  }

  _domainOptions() {
    const states = this._hass?.states || {};
    return [...new Set(Object.keys(states).map((entityId) => entityId.split(".")[0]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _integrationOptions() {
    const states = this._hass?.states || {};
    const fromRegistry = this._entities.map((entity) => entity.platform).filter(Boolean);
    const fromStates = Object.values(states)
      .flatMap((stateObj) => [stateObj.attributes?.integration, stateObj.attributes?.platform])
      .filter(Boolean);
    return [...new Set([...fromRegistry, ...fromStates])].sort((a, b) => a.localeCompare(b));
  }

  _areaOptions() {
    const states = this._hass?.states || {};
    const fromRegistry = this._areas.map((area) => area.name || area.area_id || area.id).filter(Boolean);
    const fromStates = Object.values(states)
      .flatMap((stateObj) => [stateObj.attributes?.area, stateObj.attributes?.area_id])
      .filter(Boolean);
    return [...new Set([...fromRegistry, ...fromStates])].sort((a, b) => a.localeCompare(b));
  }

  _entityOptions() {
    const states = this._hass?.states || {};
    const registryNames = new Map(this._entities.map((entity) => [entity.entity_id, entity.name || entity.original_name || ""]));
    return Object.entries(states)
      .map(([entityId, stateObj]) => {
        const name = stateObj.attributes?.friendly_name || registryNames.get(entityId) || entityId;
        return [entityId, `${name} (${entityId})`];
      })
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }

  _excludedEntitiesTemplate() {
    const selected = Array.isArray(this._config.excluded_entities) ? this._config.excluded_entities : [];
    const labels = new Map(this._entityOptions());
    const rows = selected.length
      ? selected
          .map(
            (entityId) => `
              <div class="selected-row">
                <span title="${this._escape(entityId)}">${this._escape(labels.get(entityId) || entityId)}</span>
                <button type="button" class="remove-chip" data-remove-excluded="${this._escape(entityId)}">Remove</button>
              </div>
            `
          )
          .join("")
      : `<div class="empty-options">No excluded entities selected</div>`;

    return `
      <div class="selected-list">${rows}</div>
      <button type="button" data-open-excluded-picker>Add entities</button>
    `;
  }

  _excludedEntityModal() {
    return `
      <div class="modal-backdrop" data-close-excluded-picker>
        <div class="modal" role="dialog" aria-modal="true" aria-label="Add excluded entities" data-excluded-modal>
          <div class="modal-head">
            <strong>Add excluded entities</strong>
            <button type="button" data-close-excluded-picker>Done</button>
          </div>
          ${this._multiPicker("excluded_entities", "Entities", this._entityOptions(), { search: true, searchPlaceholder: "Search entities..." })}
        </div>
      </div>
    `;
  }

  _wireExcludedEntityPicker() {
    this.shadowRoot.querySelectorAll("[data-open-excluded-picker]").forEach((element) => {
      element.addEventListener("click", () => {
        this._excludedPickerOpen = true;
        this._renderEditor();
      });
    });

    this.shadowRoot.querySelectorAll("[data-close-excluded-picker]").forEach((element) => {
      element.addEventListener("click", (event) => {
        if (event.target.closest?.("[data-excluded-modal]") && !event.target.matches("[data-close-excluded-picker]")) return;
        this._excludedPickerOpen = false;
        this._renderEditor();
      });
    });

    this.shadowRoot.querySelectorAll("[data-remove-excluded]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const entityId = event.currentTarget.dataset.removeExcluded;
        const excluded = (this._config.excluded_entities || []).filter((value) => value !== entityId);
        this._emitConfig({ ...this._config, excluded_entities: excluded });
        this._renderEditor();
      });
    });
  }
}

customElements.define("offline-device-panel-editor", OfflineDevicePanelEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "offline-device-panel",
  name: "Offline Device Panel",
  description: "Filterable Home Assistant device status panel grouped by area.",
});

class DeviceMapPanel extends HTMLElement {
  static getConfigElement() {
    return document.createElement("device-map-panel-editor");
  }

  static getStubConfig() {
    return {
      title: "Device Map",
      image: "/local/floorplan.png",
      offline_states: ["unavailable", "unknown"],
      markers: [],
      floors: [],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._registriesLoaded = false;
    this._entities = [];
    this._devices = [];
    this._areas = [];
    this._floors = [];
    this._activeFloorId = "";
    this._floorMarkers = {};
    this._markers = {};
    this._filters = {
      status: "all",
      placementStatus: "all",
      connectionStatus: "all",
      domain: "all",
      integration: "all",
      area: "all",
      search: "",
    };
    this._mode = "user";
    this._sidebarCollapsed = false;
    this._zoom = 1;
    this._exportOpen = false;
    this._display = {
      markerSize: 18,
      showLabels: true,
      nudgeStep: 1,
      mapViewports: {},
    };
    this._mapScroll = {
      left: 0,
      top: 0,
      leftRatio: 0,
      topRatio: 0,
      centerX: 0.5,
      centerY: 0.5,
      zoom: 1,
    };
    this._mapScrollByFloor = {};
    this._mapViewportVersion = 0;
    this._isRestoringMapScroll = false;
    this._viewportSaveTimer = null;
    this._hasRenderedWithHass = false;
    this._registryRenderComplete = false;
    this._mapAlertScrollLeft = 0;
    this._deviceListScrollTop = 0;
    this._isPanning = false;
    this._isSelecting = false;
    this._isJumping = false;
    this._suppressMapRestoreUntil = 0;
    this._selectedMarkers = new Set();
    this._dragMarkerKey = null;
    this._selectionBox = null;
    this._selectionBoxElement = null;
    this._pendingMarkerFocus = null;
    this._lastExternalMapTargetKey = "";
    this._history = {};
    this._historyLimit = 30;
    this._boundKeydown = (event) => this._handleKeydown(event);
    this._boundExternalMapNavigation = () => this._handleExternalMapNavigation();
  }

  setConfig(config) {
    const nextConfig = {
      title: "Device Map",
      offline_states: ["unavailable", "unknown"],
      domains: [],
      integrations: [],
      areas: [],
      domain_labels: {},
      integration_labels: {},
      markers: [],
      floors: [],
      persist_layout: true,
      marker_size: 18,
      show_labels: true,
      show_entity_state: false,
      nudge_step: 1,
      ...config,
    };
    this._config = nextConfig;
    this._floors = this._normalizedFloors(this._config);
    if (!this._floors.some((floor) => floor.id === this._activeFloorId)) {
      this._activeFloorId = this._floors[0]?.id || "default";
    }
    this._display = this._normalizedDisplay({
      markerSize: this._config.marker_size,
      showLabels: this._config.show_labels,
      nudgeStep: this._config.nudge_step,
      ...this._loadDisplay(),
    });
    this._applyStoredViewportForFloor(this._activeFloorId);
    this._floorMarkers = this._mergedFloorMarkers(this._configFloorMarkers(), this._loadMarkers());
    this._markers = this._floorMarkers[this._activeFloorId] || {};
    this._lastExternalMapTargetKey = "";
    this._applyExternalMapTarget();
    this._hasRenderedWithHass = false;
    this._registryRenderComplete = false;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadRegistries(hass);
    if (this._isControlActive()) return;
    const externalTargetChanged = this._applyExternalMapTarget();
    if (!this._hasRenderedWithHass || (this._registriesLoaded && !this._registryRenderComplete)) {
      this._render({ preservePageScroll: true, preserveMapViewport: true });
      this._hasRenderedWithHass = true;
      if (this._registriesLoaded) this._registryRenderComplete = true;
      return;
    }
    if (externalTargetChanged) {
      this._render({ preservePageScroll: true, preserveMapViewport: true });
      return;
    }
    this._updateLiveMapState();
  }

  getCardSize() {
    return 8;
  }

  connectedCallback() {
    window.addEventListener("keydown", this._boundKeydown);
    window.addEventListener("location-changed", this._boundExternalMapNavigation);
    window.addEventListener("popstate", this._boundExternalMapNavigation);
    window.addEventListener("hashchange", this._boundExternalMapNavigation);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this._boundKeydown);
    window.removeEventListener("location-changed", this._boundExternalMapNavigation);
    window.removeEventListener("popstate", this._boundExternalMapNavigation);
    window.removeEventListener("hashchange", this._boundExternalMapNavigation);
  }

  _canEdit() {
    return this._hass?.user?.is_admin === true;
  }

  _isControlActive() {
    const active = this.shadowRoot?.activeElement;
    return this._isPanning || this._isSelecting || this._isJumping || ["INPUT", "SELECT", "TEXTAREA"].includes(active?.tagName);
  }

  _handleKeydown(event) {
    if (!(this._canEdit() && this._mode === "edit")) return;
    const active = this.shadowRoot?.activeElement || document.activeElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(active?.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      this._undoLastMarkerChange();
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (!this._selectedMarkers.size) return;

    event.preventDefault();
    this._pushMarkerHistory();
    for (const key of this._selectedMarkers) {
      delete this._markers[key];
    }
    this._selectedMarkers.clear();
    this._saveMarkers();
    this._render();
  }

  async _loadRegistries(hass) {
    if (this._registriesLoaded || !hass?.callWS) return;
    this._registriesLoaded = true;

    try {
      const [entities, devices, areas] = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/device_registry/list" }),
        hass.callWS({ type: "config/area_registry/list" }),
      ]);
      this._entities = entities || [];
      this._devices = devices || [];
      this._areas = areas || [];
      if (this._isControlActive()) return;
      this._render({ preserveMapViewport: true });
      this._hasRenderedWithHass = true;
      this._registryRenderComplete = true;
    } catch (error) {
      console.warn("device-map-panel: registry lookup failed", error);
    }
  }

  _deviceRows() {
    if (!this._hass?.states) return [];

    const entityRegistry = new Map(this._entities.map((entity) => [entity.entity_id, entity]));
    const deviceRegistry = new Map(this._devices.map((device) => [device.id, device]));
    const areaRegistry = new Map(this._areas.map((area) => [area.area_id || area.id, area]));
    const rows = [];

    for (const [entityId, stateObj] of Object.entries(this._hass.states)) {
      const domain = entityId.split(".")[0];
      if (this._config.domains.length && !this._config.domains.includes(domain)) continue;

      const entity = entityRegistry.get(entityId);
      const device = entity?.device_id ? deviceRegistry.get(entity.device_id) : null;
      const integration = this._integration(entity, stateObj);
      if (this._config.integrations.length && !this._config.integrations.includes(integration)) continue;

      const areaId = entity?.area_id || device?.area_id || stateObj.attributes?.area_id || "unknown";
      const area = areaRegistry.get(areaId);
      const areaName = area?.name || stateObj.attributes?.area || (areaId === "unknown" ? "No area" : areaId);
      if (this._config.areas.length && !this._config.areas.includes(areaName) && !this._config.areas.includes(areaId)) continue;

      const isOffline = this._isOffline(stateObj.state);
      const deviceName = this._deviceDisplayName(device);
      const parentDeviceId = this._deviceParentId(device);
      const parentDevice = parentDeviceId ? deviceRegistry.get(parentDeviceId) : null;
      const parentDeviceName =
        parentDeviceId && parentDeviceId !== device?.id ? this._deviceDisplayName(parentDevice, parentDeviceId) : "";
      const name = stateObj.attributes?.friendly_name || entity?.name || entity?.original_name || entityId;
      const icon = stateObj.attributes?.icon || "";
      const deviceClass = stateObj.attributes?.device_class || "";

      rows.push({
        key: entityId,
        entityId,
        name,
        deviceName,
        parentDeviceId,
        parentDeviceName,
        offline: isOffline,
        domain,
        integration,
        displayDomain: this._domainLabel(domain),
        displayIntegration: this._integrationLabel(integration),
        state: stateObj.state,
        domains: [domain],
        integrations: [integration],
        states: [stateObj.state],
        icons: icon ? [icon] : [],
        deviceClasses: deviceClass ? [deviceClass] : [],
        primaryState: stateObj.state,
        primaryDomain: domain,
        primaryDeviceClass: deviceClass,
        offlineEntities: isOffline ? [{ entityId, name }] : [],
        entityCount: 1,
        areaId,
        areaName,
        lastChanged: stateObj.last_changed,
      });
    }

    return rows.sort((a, b) => a.areaName.localeCompare(b.areaName) || a.name.localeCompare(b.name));
  }

  _deviceDisplayName(device, fallback = "") {
    if (!device) return fallback;
    return device.name_by_user || device.name || fallback;
  }

  _deviceParentId(device) {
    const parent = device?.via_device_id || device?.parent_device_id || device?.hub_device_id || "";
    if (Array.isArray(parent)) return parent[0] ? String(parent[0]) : "";
    if (parent && typeof parent === "object") return String(parent.id || parent.device_id || "");
    return parent ? String(parent) : "";
  }

  _integration(entity, stateObj) {
    if (entity?.platform) return entity.platform;
    const attr = stateObj.attributes || {};
    return attr.integration || attr.platform || "unknown";
  }

  _domainLabel(domain) {
    return this._config.domain_labels?.[domain] || domain;
  }

  _integrationLabel(integration) {
    return this._config.integration_labels?.[integration] || integration;
  }

  _isOffline(state) {
    return this._config.offline_states.includes(String(state).toLowerCase());
  }

  _stateClass(row) {
    if (!this._config.show_entity_state) return "";
    const state = String(row.primaryState || "").toLowerCase();
    const activeStates = ["on", "open", "opening", "unlocked", "detected", "motion", "home", "playing", "heat", "cool"];
    const inactiveStates = ["off", "closed", "closing", "locked", "clear", "none", "not_home", "idle", "standby"];

    if (activeStates.includes(state)) return "state-active";
    if (inactiveStates.includes(state)) return "state-inactive";
    if (row.primaryDomain === "binary_sensor") return state === "on" ? "state-active" : "state-inactive";
    if (row.primaryDomain === "light" || row.primaryDomain === "switch") return state === "on" ? "state-active" : "state-inactive";
    return "state-neutral";
  }

  _iconOptions() {
    return [
      ["auto", "Auto"],
      ["mdi:lightbulb", "Light"],
      ["mdi:motion-sensor", "Motion"],
      ["mdi:door", "Door"],
      ["mdi:window-closed", "Window"],
      ["mdi:power-socket", "Switch/Plug"],
      ["mdi:thermostat", "Climate"],
      ["mdi:thermometer", "Temperature"],
      ["mdi:water-percent", "Humidity"],
      ["mdi:smoke-detector", "Smoke"],
      ["mdi:cctv", "Camera"],
      ["mdi:lock", "Lock"],
      ["mdi:garage", "Garage"],
      ["mdi:blinds", "Cover"],
      ["mdi:speaker", "Media"],
      ["mdi:wifi", "Network"],
      ["mdi:battery", "Battery"],
      ["mdi:home-alert", "Alert"],
      ["mdi:devices", "Device"],
    ];
  }

  _markerIcon(row) {
    const markerIcon = this._markers[row.key]?.icon;
    if (markerIcon) return markerIcon;
    return this._defaultIcon(row);
  }

  _defaultIcon(row) {
    const deviceClass = row.deviceClasses[0];
    if (deviceClass) {
      const classIcons = {
        motion: "mdi:motion-sensor",
        occupancy: "mdi:motion-sensor",
        door: "mdi:door",
        window: "mdi:window-closed",
        garage_door: "mdi:garage",
        opening: "mdi:door-open",
        smoke: "mdi:smoke-detector",
        gas: "mdi:gas-cylinder",
        moisture: "mdi:water-alert",
        temperature: "mdi:thermometer",
        humidity: "mdi:water-percent",
        illuminance: "mdi:brightness-5",
        battery: "mdi:battery",
        power: "mdi:flash",
        energy: "mdi:lightning-bolt",
        voltage: "mdi:sine-wave",
        current: "mdi:current-ac",
        plug: "mdi:power-plug",
        lock: "mdi:lock",
      };
      if (classIcons[deviceClass]) return classIcons[deviceClass];
    }

    if (row.icons[0]) return row.icons[0];

    const domainIcons = {
      light: "mdi:lightbulb",
      switch: "mdi:toggle-switch",
      sensor: "mdi:eye",
      binary_sensor: "mdi:checkbox-marked-circle-outline",
      climate: "mdi:thermostat",
      cover: "mdi:blinds",
      lock: "mdi:lock",
      camera: "mdi:cctv",
      media_player: "mdi:speaker",
      fan: "mdi:fan",
      vacuum: "mdi:robot-vacuum",
      alarm_control_panel: "mdi:shield-home",
      device_tracker: "mdi:map-marker",
      person: "mdi:account",
      button: "mdi:gesture-tap-button",
      scene: "mdi:palette",
      script: "mdi:script-text",
      automation: "mdi:home-automation",
    };

    return domainIcons[row.domains[0]] || "mdi:devices";
  }

  _filteredRows(rows) {
    const search = this._filters.search.trim().toLowerCase();
    const placementStatus = this._filters.placementStatus || (["placed", "unplaced"].includes(this._filters.status) ? this._filters.status : "all");
    const connectionStatus = this._filters.connectionStatus || (["offline", "online"].includes(this._filters.status) ? this._filters.status : "all");

    return rows.filter((row) => {
      if (placementStatus === "placed" && !this._markers[row.key]) return false;
      if (placementStatus === "unplaced" && this._markers[row.key]) return false;
      if (connectionStatus === "offline" && !row.offline) return false;
      if (connectionStatus === "online" && row.offline) return false;
      if (this._filters.domain !== "all" && !row.domains.includes(this._filters.domain)) return false;
      if (this._filters.integration !== "all" && !row.integrations.includes(this._filters.integration)) return false;
      if (this._filters.area !== "all" && row.areaName !== this._filters.area) return false;
      if (!search) return true;

      const haystack =
        `${row.name} ${row.entityId} ${row.areaName} ${row.domain} ${row.integration} ${row.displayDomain} ${row.displayIntegration} ${row.parentDeviceName} ${row.parentDeviceId}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  _normalizedFloors(config) {
    const configuredFloors = Array.isArray(config.floors) ? config.floors : [];
    const source = configuredFloors.length
      ? configuredFloors
      : [
          {
            id: "default",
            name: config.title || "Floor",
            image: config.image || "",
            markers: config.markers || [],
          },
        ];
    const seen = new Set();

    return source.map((floor, index) => {
      const fallback = `floor-${index + 1}`;
      const rawId = floor.id || floor.name || fallback;
      let id = String(rawId)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || fallback;
      while (seen.has(id)) id = `${id}-${index + 1}`;
      seen.add(id);
      return {
        id,
        name: floor.name || floor.title || rawId || `Floor ${index + 1}`,
        image: floor.image || "",
        markers: Array.isArray(floor.markers) ? floor.markers : [],
      };
    });
  }

  _hasMultipleFloors() {
    return Array.isArray(this._config.floors) && this._config.floors.length > 0;
  }

  _activeFloor() {
    return this._floors.find((floor) => floor.id === this._activeFloorId) || this._floors[0] || { id: "default", name: this._config.title, image: this._config.image };
  }

  _options(rows, key) {
    const values = rows.flatMap((row) => {
      const value = row[key];
      return Array.isArray(value) ? value : [value];
    });
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _labeledOptions(rows, key) {
    return this._options(rows, key)
      .map((value) => [value, key === "domains" ? this._domainLabel(value) : key === "integrations" ? this._integrationLabel(value) : value])
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }

  _scrollSnapshots() {
    const snapshots = [];
    const seen = new Set();
    const add = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      snapshots.push({
        element,
        left: element.scrollLeft,
        top: element.scrollTop,
      });
    };

    add(document.scrollingElement || document.documentElement);

    let node = this;
    while (node) {
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
        if (canScrollY || canScrollX) add(node);
      }

      const root = node.getRootNode?.();
      node = node.parentElement || root?.host || null;
    }

    return snapshots;
  }

  _restoreScroll(snapshots) {
    for (const snapshot of snapshots) {
      snapshot.element.scrollTo(snapshot.left, snapshot.top);
    }
  }

  _restoreScrollSoon(snapshots) {
    this._restoreScroll(snapshots);
    requestAnimationFrame(() => this._restoreScroll(snapshots));
    window.setTimeout(() => this._restoreScroll(snapshots), 80);
  }

  _configMarkers() {
    return this._markersFromList(this._config.markers || []);
  }

  _configFloorMarkers() {
    if (!this._hasMultipleFloors()) {
      return { [this._activeFloorId || "default"]: this._configMarkers() };
    }

    return this._floors.reduce((result, floor) => {
      result[floor.id] = this._markersFromList(floor.markers || []);
      return result;
    }, {});
  }

  _markersFromList(markersList) {
    return (markersList || []).reduce((markers, marker) => {
      const key = marker.entity || marker.key || marker.device;
      if (!key) return markers;
      markers[key] = {
        key,
        entityId: marker.entity || key,
        name: marker.name || "",
        icon: marker.icon || "",
        x: Number(marker.x),
        y: Number(marker.y),
      };
      return markers;
    }, {});
  }

  _normalizedMarkers(markers) {
    return Object.entries(markers || {}).reduce((result, [key, marker]) => {
      const x = Number(marker.x);
      const y = Number(marker.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return result;
      const entityId = marker.entityId || marker.entity || key;
      const markerKey = entityId || key;
      result[markerKey] = {
        key: markerKey,
        entityId,
        name: marker.name || "",
        icon: marker.icon || "",
        x: Math.max(0, Math.min(100, x)),
        y: Math.max(0, Math.min(100, y)),
      };
      return result;
    }, {});
  }

  _storageKey() {
    const path = window.location?.pathname || "dashboard";
    const cardKey = this._config.storage_key || this._config.title || "device-map-panel";
    return `device-map-panel:${this._hasMultipleFloors() ? "floors" : "markers"}:${path}:${cardKey}`;
  }

  _displayStorageKey() {
    const path = window.location?.pathname || "dashboard";
    const cardKey = this._config.storage_key || this._config.title || "device-map-panel";
    return `device-map-panel:display:${path}:${cardKey}`;
  }

  _loadMarkers() {
    if (this._config.persist_layout === false) return {};

    try {
      const value = localStorage.getItem(this._storageKey());
      return value ? JSON.parse(value) : {};
    } catch (error) {
      console.warn("device-map-panel: saved marker layout could not be loaded", error);
      return {};
    }
  }

  _saveMarkers() {
    if (this._config.persist_layout === false) return;

    try {
      this._floorMarkers[this._activeFloorId] = this._markers;
      localStorage.setItem(this._storageKey(), JSON.stringify(this._hasMultipleFloors() ? this._floorMarkers : this._markers));
    } catch (error) {
      console.warn("device-map-panel: marker layout could not be saved", error);
    }
  }

  _cloneMarkers(markers = this._markers) {
    return JSON.parse(JSON.stringify(markers || {}));
  }

  _pushMarkerHistory() {
    const floorId = this._activeFloorId || "default";
    const history = this._history[floorId] || [];
    history.push(this._cloneMarkers());
    if (history.length > this._historyLimit) history.shift();
    this._history[floorId] = history;
  }

  _undoLastMarkerChange() {
    const floorId = this._activeFloorId || "default";
    const history = this._history[floorId] || [];
    const previousMarkers = history.pop();
    if (!previousMarkers) return;

    this._markers = this._normalizedMarkers(previousMarkers);
    this._floorMarkers[floorId] = this._markers;
    this._selectedMarkers.clear();
    this._selectionBox = null;
    this._saveMarkers();
    this._render();
  }

  _mergedFloorMarkers(configMarkers, savedMarkers) {
    const result = {};
    for (const floor of this._floors) {
      result[floor.id] = this._normalizedMarkers(configMarkers[floor.id] || {});
    }

    if (this._hasMultipleFloors()) {
      const savedByFloor = this._looksLikeFloorMarkers(savedMarkers)
        ? savedMarkers
        : { [this._activeFloorId || this._floors[0]?.id || "default"]: savedMarkers };
      for (const floor of this._floors) {
        result[floor.id] = this._normalizedMarkers({
          ...result[floor.id],
          ...(savedByFloor[floor.id] || {}),
        });
      }
      return result;
    }

    const floorId = this._floors[0]?.id || "default";
    result[floorId] = this._normalizedMarkers({
      ...(result[floorId] || {}),
      ...(this._looksLikeFloorMarkers(savedMarkers) ? savedMarkers[floorId] || {} : savedMarkers || {}),
    });
    return result;
  }

  _looksLikeFloorMarkers(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.values(value).some((entry) => entry && typeof entry === "object" && !("x" in entry) && !("y" in entry));
  }

  _loadDisplay() {
    if (this._config.persist_layout === false) return {};

    try {
      const value = localStorage.getItem(this._displayStorageKey());
      return value ? JSON.parse(value) : {};
    } catch (error) {
      console.warn("device-map-panel: display settings could not be loaded", error);
      return {};
    }
  }

  _saveDisplay() {
    if (this._config.persist_layout === false) return;

    try {
      localStorage.setItem(this._displayStorageKey(), JSON.stringify(this._display));
    } catch (error) {
      console.warn("device-map-panel: display settings could not be saved", error);
    }
  }

  _normalizedDisplay(display) {
    const markerSize = Number(display.markerSize);
    const nudgeStep = Number(display.nudgeStep);
    return {
      markerSize: Number.isFinite(markerSize) ? Math.max(12, Math.min(48, markerSize)) : 18,
      nudgeStep: Number.isFinite(nudgeStep) ? Math.max(0.05, Math.min(10, nudgeStep)) : 1,
      showLabels: display.showLabels !== false && display.showLabels !== "false",
      mapViewports: display.mapViewports && typeof display.mapViewports === "object" && !Array.isArray(display.mapViewports) ? display.mapViewports : {},
    };
  }

  _storedViewportForFloor(floorId = this._activeFloorId || "default") {
    const viewport = this._display.mapViewports?.[floorId];
    if (!viewport || typeof viewport !== "object") return null;
    const zoom = Number(viewport.zoom);
    const centerX = Number(viewport.centerX);
    const centerY = Number(viewport.centerY);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return null;
    return {
      centerX: Math.max(0, Math.min(1, centerX)),
      centerY: Math.max(0, Math.min(1, centerY)),
      zoom: Number.isFinite(zoom) ? Math.max(0.5, Math.min(4, zoom)) : this._zoom,
    };
  }

  _applyStoredViewportForFloor(floorId = this._activeFloorId || "default") {
    const viewport = this._storedViewportForFloor(floorId);
    if (!viewport) return;
    this._zoom = viewport.zoom;
    this._mapScroll = {
      left: 0,
      top: 0,
      leftRatio: 0,
      topRatio: 0,
      centerX: viewport.centerX,
      centerY: viewport.centerY,
      zoom: viewport.zoom,
    };
    this._mapScrollByFloor[floorId] = { ...this._mapScroll };
  }

  _rememberMapViewport({ save = false } = {}) {
    const floorId = this._activeFloorId || "default";
    const centerX = Number.isFinite(this._mapScroll.centerX) ? Math.max(0, Math.min(1, this._mapScroll.centerX)) : 0.5;
    const centerY = Number.isFinite(this._mapScroll.centerY) ? Math.max(0, Math.min(1, this._mapScroll.centerY)) : 0.5;
    this._display.mapViewports = {
      ...(this._display.mapViewports || {}),
      [floorId]: {
        centerX,
        centerY,
        zoom: this._zoom,
      },
    };
    if (save) this._saveDisplay();
    else this._scheduleViewportSave();
  }

  _scheduleViewportSave() {
    if (this._config.persist_layout === false) return;
    if (this._viewportSaveTimer) window.clearTimeout(this._viewportSaveTimer);
    this._viewportSaveTimer = window.setTimeout(() => {
      this._viewportSaveTimer = null;
      this._saveDisplay();
    }, 250);
  }

  _render(options = {}) {
    if (!this.shadowRoot) return;

    const pageScrollSnapshots = options.preservePageScroll ? this._scrollSnapshots() : [];
    if (options.preserveMapViewport) {
      this._applyStoredViewportForFloor(this._activeFloorId);
    } else {
      this._captureMapScroll();
    }
    this._captureMapAlertScroll();
    this._captureDeviceListScroll();
    const activeElement = this.shadowRoot.activeElement;
    const activeFilter = activeElement?.dataset?.filter || "";
    const activeDisplay = activeElement?.dataset?.display || "";
    const selectionStart = typeof activeElement?.selectionStart === "number" ? activeElement.selectionStart : null;
    const selectionEnd = typeof activeElement?.selectionEnd === "number" ? activeElement.selectionEnd : null;

    const rows = this._deviceRows();
    const filteredRows = this._filteredRows(rows);
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    const activeFloor = this._activeFloor();
    const floorTitle = this._hasMultipleFloors() ? `${this._config.title} - ${activeFloor.name}` : this._config.title;
    const offlineMarkers = this._offlineMarkersByFloor(rowByKey);
    const placedRows = Object.keys(this._markers)
      .map((key) => rowByKey.get(key))
      .filter(Boolean);
    const offlineCount = placedRows.filter((row) => row.offline).length;
    const canEdit = this._canEdit();
    const isEditing = canEdit && this._mode === "edit";
    const modeLabel = isEditing ? "Edit Mode" : "User Mode";

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="panel ${isEditing ? "editing" : "viewing"} ${isEditing && this._sidebarCollapsed ? "sidebar-collapsed" : ""}">
          ${
            isEditing && !this._sidebarCollapsed
              ? `
          <aside>
            <div class="sidebar-status">${this._escape(modeLabel)} - v${this._escape(VERSION)} - ${placedRows.length} placed / ${offlineCount} offline</div>
            <section class="filters">
              ${this._select("placementStatus", "Placement", [
                ["all", "All placements"],
                ["placed", "Placed"],
                ["unplaced", "Unplaced"],
              ])}
              ${this._select("connectionStatus", "Status", [
                ["all", "All statuses"],
                ["offline", "Offline"],
                ["online", "Online"],
              ])}
              ${this._select("domain", "Domain", [["all", "All domains"], ...this._labeledOptions(rows, "domains")])}
              ${this._select("integration", "Integration", [["all", "All integrations"], ...this._labeledOptions(rows, "integrations")])}
              ${this._select("area", "Area", [["all", "All areas"], ...this._options(rows, "areaName").map((value) => [value, value])])}
              <label>
                <span>Search</span>
                <input data-filter="search" value="${this._escape(this._filters.search)}" placeholder="Device, entity, area..." />
              </label>
            </section>
            <section class="bulk-actions">
              <button type="button" data-auto-place="filtered">Add visible unplaced</button>
            </section>
            <section class="devices">
              ${filteredRows.map((row) => this._deviceListItem(row)).join("") || `<div class="empty-list">No devices match</div>`}
            </section>
            <details class="export" data-export ${this._exportOpen ? "open" : ""}>
              <summary>Export YAML</summary>
              <textarea readonly>${this._escape(this._yamlExport(rows))}</textarea>
            </details>
          </aside>
          `
              : ""
          }
          <main>
            <div class="map-toolbar">
              <div class="toolbar-title">${this._escape(floorTitle)}</div>
              ${
                this._hasMultipleFloors()
                  ? `
              <label class="floor-switch" title="Floor">
                <span>Floor</span>
                <select data-floor>
                  ${this._floors
                    .map((floor) => `<option value="${this._escape(floor.id)}" ${floor.id === this._activeFloorId ? "selected" : ""}>${this._escape(floor.name)}</option>`)
                    .join("")}
                </select>
              </label>
              `
                  : ""
              }
              <div class="zoom-controls" aria-label="Map zoom">
                <span>Zoom</span>
                <input data-zoom-slider type="range" min="50" max="400" step="10" value="${this._escape(Math.round(this._zoom * 100))}" title="Map zoom" />
                <output data-zoom-output>${Math.round(this._zoom * 100)}%</output>
                <button type="button" data-zoom="reset" title="Reset zoom">Reset</button>
              </div>
              <div class="display-controls" aria-label="Marker display">
                <div class="marker-size-stepper" title="Marker size">
                  <span>Size</span>
                  <button type="button" data-marker-size="down" title="Smaller markers" aria-label="Smaller markers">-</button>
                  <output>${this._escape(this._display.markerSize)}</output>
                  <button type="button" data-marker-size="up" title="Bigger markers" aria-label="Bigger markers">+</button>
                </div>
                <label class="toolbar-toggle" title="Show marker names">
                  <input data-display="showLabels" type="checkbox" ${this._display.showLabels ? "checked" : ""} />
                  <span>Names</span>
                </label>
              </div>
              ${
                canEdit
                  ? `
              ${
                isEditing
                  ? `<button type="button" class="sidebar-toggle" data-sidebar-toggle title="${this._sidebarCollapsed ? "Show device sidebar" : "Hide device sidebar"}">
                ${this._sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar"}
              </button>`
                  : ""
              }
              <div class="align-controls" aria-label="Marker alignment">
                <span>${this._selectedMarkers.size} selected</span>
                <button type="button" class="tool-icon" data-align="left" title="Align selected left" aria-label="Align selected left" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-left"></span>
                </button>
                <button type="button" class="tool-icon" data-align="right" title="Align selected right" aria-label="Align selected right" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-right"></span>
                </button>
                <button type="button" class="tool-icon" data-align="top" title="Align selected top" aria-label="Align selected top" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-top"></span>
                </button>
                <button type="button" class="tool-icon" data-align="bottom" title="Align selected bottom" aria-label="Align selected bottom" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-bottom"></span>
                </button>
                <button type="button" class="tool-icon" data-distribute="horizontal" title="Distribute selected evenly left to right" aria-label="Distribute selected horizontally" ${this._selectedMarkers.size < 3 ? "disabled" : ""}>
                  <span class="align-icon distribute-horizontal"></span>
                </button>
                <button type="button" class="tool-icon" data-distribute="vertical" title="Distribute selected evenly top to bottom" aria-label="Distribute selected vertically" ${this._selectedMarkers.size < 3 ? "disabled" : ""}>
                  <span class="align-icon distribute-vertical"></span>
                </button>
                <button type="button" data-clear-selection title="Clear selection" ${this._selectedMarkers.size ? "" : "disabled"}>Clear</button>
              </div>
              <div class="mode-switch" aria-label="Map mode">
                <button type="button" data-mode="user" class="${!isEditing ? "active" : ""}">User Mode</button>
                <button type="button" data-mode="edit" class="${isEditing ? "active" : ""}">Edit Mode</button>
              </div>
              `
                  : ""
              }
            </div>
            ${offlineMarkers.length ? this._offlineMarkerAlertTemplate(offlineMarkers) : ""}
            ${
              activeFloor.image
                ? `
            <div class="map ${isEditing ? "editable" : ""} ${this._zoom < 1 ? "zoomed-out" : ""}" data-map>
              <div class="map-content" style="width: ${this._escape(this._zoom * 100)}%;">
                <img src="${this._escape(activeFloor.image)}" alt="" />
                <div class="image-error">Image could not be loaded: ${this._escape(activeFloor.image)}</div>
                ${placedRows.map((row) => this._markerTemplate(row, isEditing)).join("")}
                ${isEditing && this._selectionBox ? this._selectionBoxTemplate() : ""}
              </div>
              ${
                isEditing
                  ? `
              <div class="nudge-pad" aria-label="Move selected markers">
                <button type="button" class="nudge-up" data-nudge="up" title="Move selected markers up" aria-label="Move selected markers up" ${this._selectedMarkers.size ? "" : "disabled"}>▲</button>
                <button type="button" class="nudge-left" data-nudge="left" title="Move selected markers left" aria-label="Move selected markers left" ${this._selectedMarkers.size ? "" : "disabled"}>◀</button>
                <button type="button" class="nudge-right" data-nudge="right" title="Move selected markers right" aria-label="Move selected markers right" ${this._selectedMarkers.size ? "" : "disabled"}>▶</button>
                <button type="button" class="nudge-down" data-nudge="down" title="Move selected markers down" aria-label="Move selected markers down" ${this._selectedMarkers.size ? "" : "disabled"}>▼</button>
                <label class="nudge-step" title="Arrow move step">
                  <span>Step</span>
                  <input data-display="nudgeStep" type="number" min="0.05" max="10" step="0.05" value="${this._escape(this._display.nudgeStep)}" />
                </label>
              </div>
              `
                  : ""
              }
            </div>
            `
                : `<div class="missing-image">Add an image URL in the card YAML.</div>`
            }
          </main>
        </div>
      </ha-card>
      ${this._styles()}
    `;

    this._attachEvents();
    requestAnimationFrame(() => {
      if (options.preservePageScroll) this._restoreScrollSoon(pageScrollSnapshots);
      if (this._pendingMarkerFocus) {
        this._focusMarker(this._pendingMarkerFocus);
        this._pendingMarkerFocus = null;
      } else {
        this._restoreMapScrollSoon();
      }
      this._restoreMapAlertScroll();
      this._restoreDeviceListScroll();
      const activeSelector = activeFilter
        ? `[data-filter="${this._cssEscape(activeFilter)}"]`
        : activeDisplay
          ? `[data-display="${this._cssEscape(activeDisplay)}"]`
          : "";
      if (activeSelector) {
        const restoredInput = this.shadowRoot.querySelector(activeSelector);
        restoredInput?.focus();
        if (selectionStart !== null && selectionEnd !== null) {
          restoredInput?.setSelectionRange?.(selectionStart, selectionEnd);
        }
      }
    });
  }

  _attachEvents() {
    const isEditing = this._canEdit() && this._mode === "edit";

    this.shadowRoot.querySelectorAll("[data-mode]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._mode = event.currentTarget.dataset.mode === "edit" ? "edit" : "user";
        if (this._mode !== "edit") {
          this._selectedMarkers.clear();
          this._sidebarCollapsed = false;
        }
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-floor]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const floorId = event.currentTarget.value;
        if (this._switchToFloor(floorId)) this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-sidebar-toggle]").forEach((element) => {
      element.addEventListener("click", () => {
        this._sidebarCollapsed = !this._sidebarCollapsed;
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-jump-marker]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const floorId = event.currentTarget.dataset.jumpFloor;
        const markerKey = event.currentTarget.dataset.jumpMarker;
        this._jumpToMarker(floorId, markerKey);
      });
    });

    this.shadowRoot.querySelectorAll("[data-zoom]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const action = event.currentTarget.dataset.zoom;
        if (action === "reset") this._zoom = 1;
        this._mapViewportVersion += 1;
        this._applyZoomToDom();
      });
    });

    this.shadowRoot.querySelectorAll("[data-zoom-slider]").forEach((element) => {
      element.addEventListener("input", (event) => {
        const value = Number(event.currentTarget.value);
        this._zoom = Math.max(0.5, Math.min(4, value / 100));
        this._mapViewportVersion += 1;
        this._applyZoomToDom();
      });
    });

    this.shadowRoot.querySelectorAll("[data-marker-size]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const direction = event.currentTarget.dataset.markerSize === "up" ? 2 : -2;
        this._display.markerSize = Number(this._display.markerSize || 18) + direction;
        this._display = this._normalizedDisplay(this._display);
        this._saveDisplay();
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-display]").forEach((element) => {
      element.addEventListener("input", (event) => {
        const key = event.currentTarget.dataset.display;
        if (key === "showLabels") this._display.showLabels = event.currentTarget.checked;
        if (key === "nudgeStep") this._display.nudgeStep = Number(event.currentTarget.value);
        this._display = this._normalizedDisplay(this._display);
        this._saveDisplay();
        this._render();
      });
    });

    const map = this.shadowRoot.querySelector("[data-map]");
    if (map) {
      map.addEventListener("scroll", () => {
        if (!this._isRestoringMapScroll) this._mapViewportVersion += 1;
        this._captureMapScroll();
        this._positionNudgePad();
      });
      const image = map.querySelector("img");
      if (image) {
        image.addEventListener("error", () => {
          map.classList.add("image-failed");
        });
        image.addEventListener("load", () => {
          map.classList.remove("image-failed");
          this._restoreMapScrollSoon();
        });
      }
      this._attachPanEvents(map);
      requestAnimationFrame(() => this._positionNudgePad());
    }

    const mapAlertList = this.shadowRoot.querySelector(".map-alert-list");
    if (mapAlertList) {
      mapAlertList.addEventListener("scroll", () => this._captureMapAlertScroll());
    }

    const deviceList = this.shadowRoot.querySelector(".devices");
    if (deviceList) {
      deviceList.addEventListener("scroll", () => this._captureDeviceListScroll());
    }

    if (!isEditing) {
      this.shadowRoot.querySelectorAll("[data-marker]").forEach((element) => {
        element.addEventListener("click", (event) => {
          const entityId = event.currentTarget.dataset.entity;
          if (!entityId) return;
          const moreInfoEvent = new Event("hass-more-info", { bubbles: true, composed: true });
          moreInfoEvent.detail = { entityId };
          this.dispatchEvent(moreInfoEvent);
        });
      });
      return;
    }

    this.shadowRoot.querySelectorAll("[data-filter]").forEach((element) => {
      element.addEventListener("input", (event) => {
        this._filters[event.target.dataset.filter] = event.target.value;
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-device]").forEach((element) => {
      element.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", event.currentTarget.dataset.device);
        event.dataTransfer.effectAllowed = "copyMove";
      });
    });

    this.shadowRoot.querySelectorAll("[data-remove]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        const key = event.currentTarget.dataset.remove;
        this._pushMarkerHistory();
        delete this._markers[key];
        this._selectedMarkers.delete(key);
        this._saveMarkers();
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-export]").forEach((element) => {
      element.addEventListener("toggle", (event) => {
        this._exportOpen = event.currentTarget.open;
      });
    });

    this.shadowRoot.querySelectorAll("[data-icon]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.currentTarget.dataset.icon;
        if (!this._markers[key]) return;
        const value = event.currentTarget.value;
        if ((this._markers[key].icon || "") === (value === "auto" ? "" : value)) return;
        this._pushMarkerHistory();
        this._markers[key].icon = value === "auto" ? "" : value;
        this._saveMarkers();
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-auto-place]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._autoPlaceMarkers(event.currentTarget.dataset.autoPlace);
      });
    });

    this.shadowRoot.querySelectorAll("[data-align]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._alignSelectedMarkers(event.currentTarget.dataset.align);
      });
    });

    this.shadowRoot.querySelectorAll("[data-distribute]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._distributeSelectedMarkers(event.currentTarget.dataset.distribute);
      });
    });

    this.shadowRoot.querySelectorAll("[data-nudge]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._nudgeSelectedMarkers(event.currentTarget.dataset.nudge);
      });
      element.addEventListener("pointerdown", (event) => event.stopPropagation());
      element.addEventListener("pointerup", (event) => event.stopPropagation());
    });

    this.shadowRoot.querySelectorAll("[data-clear-selection]").forEach((element) => {
      element.addEventListener("click", () => {
        this._selectedMarkers.clear();
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-marker]").forEach((element) => {
      element.addEventListener("dragstart", (event) => {
        const key = event.currentTarget.dataset.marker;
        this._dragMarkerKey = key;
        event.dataTransfer.setData("text/plain", key);
        event.dataTransfer.effectAllowed = "move";
        if ((event.ctrlKey || event.metaKey) && key) this._selectedMarkers.add(key);
      });
      element.addEventListener("dragend", () => {
        this._dragMarkerKey = null;
      });
      element.addEventListener("click", (event) => {
        const key = event.currentTarget.dataset.marker;
        if (key) {
          event.preventDefault();
          event.stopPropagation();
          if (event.ctrlKey || event.metaKey) {
            if (this._selectedMarkers.has(key)) this._selectedMarkers.delete(key);
            else this._selectedMarkers.add(key);
          } else {
            this._selectedMarkers.clear();
            this._selectedMarkers.add(key);
          }
          this._render();
          return;
        }

        const entityId = event.currentTarget.dataset.entity;
        if (!entityId) return;
        const moreInfoEvent = new Event("hass-more-info", { bubbles: true, composed: true });
        moreInfoEvent.detail = { entityId };
        this.dispatchEvent(moreInfoEvent);
      });
    });

    if (map) {
      map.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      map.addEventListener("drop", (event) => {
        event.preventDefault();
        const key = event.dataTransfer.getData("text/plain");
        const row = this._deviceRows().find((item) => item.key === key);
        if (!row) return;

        const point = this._pointFromEvent(map.querySelector(".map-content") || map, event);
        const existingMarker = this._markers[key];
        const moveSelectedGroup = (event.ctrlKey || event.metaKey) && existingMarker && this._selectedMarkers.has(key) && this._selectedMarkers.size > 1;
        this._pushMarkerHistory();

        if (moveSelectedGroup) {
          const deltaX = point.x - existingMarker.x;
          const deltaY = point.y - existingMarker.y;
          for (const selectedKey of this._selectedMarkers) {
            const marker = this._markers[selectedKey];
            if (!marker) continue;
            marker.x = Math.max(0, Math.min(100, marker.x + deltaX));
            marker.y = Math.max(0, Math.min(100, marker.y + deltaY));
          }
        } else {
          this._markers[key] = {
            key,
            entityId: row.entityId,
            name: row.name,
            icon: existingMarker?.icon || "",
            x: point.x,
            y: point.y,
          };
          this._selectedMarkers.clear();
          this._selectedMarkers.add(key);
        }
        this._dragMarkerKey = null;
        this._saveMarkers();
        this._render();
      });
    }
  }

  _pointFromEvent(element, event) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  }

  _selectionBoxTemplate() {
    const box = this._normalizedSelectionBox();
    return `
      <div
        class="selection-box"
        style="left: ${this._escape(box.left)}%; top: ${this._escape(box.top)}%; width: ${this._escape(box.width)}%; height: ${this._escape(box.height)}%;"
      ></div>
    `;
  }

  _normalizedSelectionBox() {
    const box = this._selectionBox || { startX: 0, startY: 0, endX: 0, endY: 0 };
    const left = Math.min(box.startX, box.endX);
    const right = Math.max(box.startX, box.endX);
    const top = Math.min(box.startY, box.endY);
    const bottom = Math.max(box.startY, box.endY);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  _updateSelectionFromBox(additive = false) {
    if (!this._selectionBox) return;
    const box = this._normalizedSelectionBox();
    if (!additive) this._selectedMarkers.clear();

    for (const [key, marker] of Object.entries(this._markers)) {
      if (marker.x >= box.left && marker.x <= box.right && marker.y >= box.top && marker.y <= box.bottom) {
        this._selectedMarkers.add(key);
      }
    }
  }

  _updateSelectionBoxElement(map) {
    if (!this._selectionBox) return;
    const content = map.querySelector(".map-content");
    if (!content) return;
    if (!this._selectionBoxElement || !content.contains(this._selectionBoxElement)) {
      this._selectionBoxElement = document.createElement("div");
      this._selectionBoxElement.className = "selection-box";
      content.appendChild(this._selectionBoxElement);
    }

    const box = this._normalizedSelectionBox();
    this._selectionBoxElement.style.left = `${box.left}%`;
    this._selectionBoxElement.style.top = `${box.top}%`;
    this._selectionBoxElement.style.width = `${box.width}%`;
    this._selectionBoxElement.style.height = `${box.height}%`;
  }

  _removeSelectionBoxElement() {
    this._selectionBoxElement?.remove();
    this._selectionBoxElement = null;
  }

  _syncSelectedMarkerClasses(map) {
    map.querySelectorAll("[data-marker]").forEach((marker) => {
      marker.classList.toggle("selected", this._selectedMarkers.has(marker.dataset.marker));
    });
  }

  _captureMapScroll() {
    const map = this.shadowRoot?.querySelector("[data-map]");
    if (!map) return;
    const maxLeft = Math.max(0, map.scrollWidth - map.clientWidth);
    const maxTop = Math.max(0, map.scrollHeight - map.clientHeight);
    const centerX = map.scrollWidth ? (map.scrollLeft + map.clientWidth / 2) / map.scrollWidth : 0.5;
    const centerY = map.scrollHeight ? (map.scrollTop + map.clientHeight / 2) / map.scrollHeight : 0.5;
    this._mapScroll = {
      left: map.scrollLeft,
      top: map.scrollTop,
      leftRatio: maxLeft ? map.scrollLeft / maxLeft : 0,
      topRatio: maxTop ? map.scrollTop / maxTop : 0,
      centerX,
      centerY,
      zoom: this._zoom,
    };
    this._mapScrollByFloor[this._activeFloorId || "default"] = { ...this._mapScroll };
    this._rememberMapViewport();
  }

  _restoreMapScroll() {
    const map = this.shadowRoot?.querySelector("[data-map]");
    if (!map) return;
    const maxLeft = Math.max(0, map.scrollWidth - map.clientWidth);
    const maxTop = Math.max(0, map.scrollHeight - map.clientHeight);
    const hasCenter = Number.isFinite(this._mapScroll.centerX) && Number.isFinite(this._mapScroll.centerY);
    const left = hasCenter ? this._mapScroll.centerX * map.scrollWidth - map.clientWidth / 2 : this._mapScroll.left <= maxLeft ? this._mapScroll.left : maxLeft * (this._mapScroll.leftRatio || 0);
    const top = hasCenter ? this._mapScroll.centerY * map.scrollHeight - map.clientHeight / 2 : this._mapScroll.top <= maxTop ? this._mapScroll.top : maxTop * (this._mapScroll.topRatio || 0);
    this._isRestoringMapScroll = true;
    map.scrollLeft = Math.max(0, Math.min(maxLeft, left));
    map.scrollTop = Math.max(0, Math.min(maxTop, top));
    window.setTimeout(() => {
      this._isRestoringMapScroll = false;
    }, 0);
    this._positionNudgePad();
  }

  _restoreMapScrollSoon() {
    if (Date.now() < this._suppressMapRestoreUntil) return;
    const restoreVersion = this._mapViewportVersion;
    const restoreIfCurrent = () => {
      if (restoreVersion !== this._mapViewportVersion) return;
      this._restoreMapScroll();
    };
    restoreIfCurrent();
    requestAnimationFrame(restoreIfCurrent);
    window.setTimeout(restoreIfCurrent, 80);
    window.setTimeout(restoreIfCurrent, 250);
    window.setTimeout(restoreIfCurrent, 750);
  }

  _captureMapAlertScroll() {
    const mapAlertList = this.shadowRoot?.querySelector(".map-alert-list");
    if (!mapAlertList) return;
    this._mapAlertScrollLeft = mapAlertList.scrollLeft;
  }

  _restoreMapAlertScroll() {
    const mapAlertList = this.shadowRoot?.querySelector(".map-alert-list");
    if (!mapAlertList) return;
    mapAlertList.scrollLeft = this._mapAlertScrollLeft;
  }

  _positionNudgePad() {
    const map = this.shadowRoot?.querySelector("[data-map]");
    const pad = this.shadowRoot?.querySelector(".nudge-pad");
    if (!map || !pad) return;

    const rightOffset = 22;
    const bottomOffset = 34;
    const left = map.scrollLeft + map.clientWidth - pad.offsetWidth - rightOffset;
    const top = map.scrollTop + map.clientHeight - pad.offsetHeight - bottomOffset;
    pad.style.left = `${Math.max(0, left)}px`;
    pad.style.top = `${Math.max(0, top)}px`;
  }

  _captureDeviceListScroll() {
    const deviceList = this.shadowRoot?.querySelector(".devices");
    if (!deviceList) return;
    this._deviceListScrollTop = deviceList.scrollTop;
  }

  _restoreDeviceListScroll() {
    const deviceList = this.shadowRoot?.querySelector(".devices");
    if (!deviceList) return;
    deviceList.scrollTop = this._deviceListScrollTop;
  }

  _attachPanEvents(map) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let panning = false;
    let selecting = false;
    let moved = false;
    let emptyPointerActive = false;
    let pointerId = null;

    map.addEventListener("pointerdown", (event) => {
      if (event.target.closest("[data-marker]")) return;
      if (event.target.closest(".nudge-pad")) return;
      if (event.button !== undefined && event.button !== 0) return;

      event.preventDefault();
      pointerId = event.pointerId;
      moved = false;
      emptyPointerActive = true;
      if (event.shiftKey && this._canEdit() && this._mode === "edit") {
        const point = this._pointFromEvent(map.querySelector(".map-content") || map, event);
        selecting = true;
        this._isSelecting = true;
        this._selectionBox = {
          startX: point.x,
          startY: point.y,
          endX: point.x,
          endY: point.y,
        };
        map.classList.add("selecting");
        map.setPointerCapture?.(event.pointerId);
        this._updateSelectionFromBox(event.ctrlKey || event.metaKey);
        this._updateSelectionBoxElement(map);
        this._syncSelectedMarkerClasses(map);
        return;
      }

      const canScrollX = map.scrollWidth > map.clientWidth;
      const canScrollY = map.scrollHeight > map.clientHeight;
      if (!canScrollX && !canScrollY) return;

      panning = true;
      this._isPanning = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = map.scrollLeft;
      startTop = map.scrollTop;
      map.classList.add("panning");
      map.setPointerCapture?.(event.pointerId);
    });

    const movePan = (event) => {
      if (selecting) {
        if (pointerId !== null && event.pointerId !== pointerId) return;
        event.preventDefault();
        const point = this._pointFromEvent(map.querySelector(".map-content") || map, event);
        moved = true;
        this._selectionBox = {
          ...this._selectionBox,
          endX: point.x,
          endY: point.y,
        };
        this._updateSelectionFromBox(event.ctrlKey || event.metaKey);
        this._updateSelectionBoxElement(map);
        this._syncSelectedMarkerClasses(map);
        return;
      }

      if (!panning) return;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      event.preventDefault();
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 4) moved = true;
      map.scrollLeft = startLeft - (event.clientX - startX);
      map.scrollTop = startTop - (event.clientY - startY);
      this._mapViewportVersion += 1;
      this._captureMapScroll();
    };

    map.addEventListener("pointermove", movePan);

    const stopPan = (event) => {
      if (selecting) {
        if (pointerId !== null && event.pointerId !== pointerId) return;
        selecting = false;
        this._isSelecting = false;
        pointerId = null;
        emptyPointerActive = false;
        this._selectionBox = null;
        this._removeSelectionBoxElement();
        map.classList.remove("selecting");
        try {
          map.releasePointerCapture?.(event.pointerId);
        } catch (error) {
          // Pointer capture may already be gone after browser/HA interruption.
        }
        this._render();
        return;
      }

      if (!panning) {
        if (!emptyPointerActive) return;
        if (pointerId !== null && event.pointerId !== pointerId) return;
        pointerId = null;
        emptyPointerActive = false;
        if (!moved && this._selectedMarkers.size && this._canEdit() && this._mode === "edit") {
          this._selectedMarkers.clear();
          this._syncSelectedMarkerClasses(map);
          this._render();
        }
        return;
      }
      if (pointerId !== null && event.pointerId !== pointerId) return;
      panning = false;
      pointerId = null;
      emptyPointerActive = false;
      this._isPanning = false;
      this._captureMapScroll();
      this._rememberMapViewport({ save: true });
      map.classList.remove("panning");
      try {
        map.releasePointerCapture?.(event.pointerId);
      } catch (error) {
        // Pointer capture may already be gone after browser/HA interruption.
      }
      if (!moved && this._selectedMarkers.size && this._canEdit() && this._mode === "edit") {
        this._selectedMarkers.clear();
        this._syncSelectedMarkerClasses(map);
        this._render();
      }
    };

    map.addEventListener("pointerup", stopPan);
    map.addEventListener("pointercancel", stopPan);
    map.addEventListener("lostpointercapture", stopPan);
  }

  _alignSelectedMarkers(direction) {
    const selected = [...this._selectedMarkers]
      .map((key) => this._markers[key])
      .filter(Boolean);
    if (selected.length < 2) return;

    const values = {
      left: Math.min(...selected.map((marker) => marker.x)),
      right: Math.max(...selected.map((marker) => marker.x)),
      top: Math.min(...selected.map((marker) => marker.y)),
      bottom: Math.max(...selected.map((marker) => marker.y)),
    };

    if (!Object.prototype.hasOwnProperty.call(values, direction)) return;

    this._pushMarkerHistory();
    for (const marker of selected) {
      if (direction === "left" || direction === "right") marker.x = values[direction];
      if (direction === "top" || direction === "bottom") marker.y = values[direction];
    }

    this._saveMarkers();
    this._render();
  }

  _distributeSelectedMarkers(axis) {
    const selected = [...this._selectedMarkers]
      .map((key) => this._markers[key])
      .filter(Boolean);
    if (selected.length < 3) return;

    const key = axis === "vertical" ? "y" : "x";
    const sorted = selected.sort((a, b) => a[key] - b[key]);
    const first = sorted[0][key];
    const last = sorted[sorted.length - 1][key];
    const step = (last - first) / (sorted.length - 1);

    this._pushMarkerHistory();
    sorted.forEach((marker, index) => {
      marker[key] = first + step * index;
    });

    this._saveMarkers();
    this._render();
  }

  _nudgeSelectedMarkers(direction) {
    const selected = [...this._selectedMarkers]
      .map((key) => this._markers[key])
      .filter(Boolean);
    if (!selected.length) return;

    const configuredStep = Number(this._display.nudgeStep);
    const step = Number.isFinite(configuredStep) && configuredStep > 0 ? Math.min(10, configuredStep) : 1;
    const mapContent = this.shadowRoot?.querySelector(".map-content");
    const aspectCompensation = mapContent?.offsetWidth && mapContent?.offsetHeight ? mapContent.offsetHeight / mapContent.offsetWidth : 1;
    const xStep = step * aspectCompensation;
    const delta = {
      left: [-xStep, 0],
      right: [xStep, 0],
      up: [0, -step],
      down: [0, step],
    }[direction];
    if (!delta) return;

    this._pushMarkerHistory();
    for (const marker of selected) {
      marker.x = Math.max(0, Math.min(100, marker.x + delta[0]));
      marker.y = Math.max(0, Math.min(100, marker.y + delta[1]));
    }

    this._saveMarkers();
    this._render();
  }

  _autoPlaceMarkers(scope) {
    const rows = this._deviceRows();
    const sourceRows = scope === "all" ? rows : this._filteredRows(rows);
    const unplaced = sourceRows.filter((row) => !this._markers[row.key]);
    if (!unplaced.length) return;

    const columns = Math.ceil(Math.sqrt(unplaced.length));
    const rowsCount = Math.ceil(unplaced.length / columns);
    const xMin = 8;
    const xMax = 92;
    const yMin = 8;
    const yMax = 92;
    const xStep = columns > 1 ? (xMax - xMin) / (columns - 1) : 0;
    const yStep = rowsCount > 1 ? (yMax - yMin) / (rowsCount - 1) : 0;

    this._pushMarkerHistory();
    this._selectedMarkers.clear();

    unplaced.forEach((row, index) => {
      const column = index % columns;
      const rowIndex = Math.floor(index / columns);
      const jitterX = columns > 1 ? (Math.random() - 0.5) * Math.min(4, xStep * 0.35) : 0;
      const jitterY = rowsCount > 1 ? (Math.random() - 0.5) * Math.min(4, yStep * 0.35) : 0;

      this._markers[row.key] = {
        key: row.key,
        entityId: row.entityId,
        name: row.name,
        icon: this._markers[row.key]?.icon || "",
        x: Math.max(0, Math.min(100, xMin + xStep * column + jitterX)),
        y: Math.max(0, Math.min(100, yMin + yStep * rowIndex + jitterY)),
      };
      this._selectedMarkers.add(row.key);
    });

    this._saveMarkers();
    this._render();
  }

  _handleExternalMapNavigation() {
    this._lastExternalMapTargetKey = "";
    if (this._applyExternalMapTarget({ force: true })) {
      this._render({ preservePageScroll: true, preserveMapViewport: true });
    }
  }

  _externalMapTarget() {
    const params = new URLSearchParams(window.location?.search || "");
    const floorValue = (params.get("dmp_floor") || params.get("map_floor") || "").trim();
    const markerKey = (params.get("dmp_marker") || params.get("map_marker") || "").trim();
    const offline = params.has("dmp_offline") ? this._truthyExternalParam(params.get("dmp_offline")) : false;
    if (!floorValue && !markerKey && !offline) return null;
    return { floorValue, markerKey, offline };
  }

  _truthyExternalParam(value) {
    const text = String(value ?? "").trim().toLowerCase();
    return !["0", "false", "no", "off"].includes(text);
  }

  _floorFromExternalValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const normalized = this._normalizedFloorId(raw);
    return (
      this._floors.find((floor) => floor.id === raw || floor.id.toLowerCase() === lower || floor.name === raw || floor.name.toLowerCase() === lower || floor.id === normalized) || null
    );
  }

  _normalizedFloorId(value) {
    return (
      String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || ""
    );
  }

  _floorForMarker(markerKey) {
    if (!markerKey) return null;
    return this._floors.find((floor) => this._markerExistsOnFloor(floor.id, markerKey)) || null;
  }

  _markerExistsOnFloor(floorId, markerKey) {
    const markers = floorId === this._activeFloorId ? this._markers : this._floorMarkers[floorId] || {};
    return Object.prototype.hasOwnProperty.call(markers, markerKey);
  }

  _switchToFloor(floorId) {
    if (!floorId || !this._floors.some((floor) => floor.id === floorId)) return false;
    if (floorId === this._activeFloorId) return false;
    this._captureMapScroll();
    if (this._activeFloorId) {
      this._mapScrollByFloor[this._activeFloorId] = { ...this._mapScroll };
      this._floorMarkers[this._activeFloorId] = this._markers;
    }
    this._activeFloorId = floorId;
    this._markers = this._floorMarkers[floorId] || {};
    this._selectedMarkers.clear();
    this._selectionBox = null;
    this._applyStoredViewportForFloor(floorId);
    this._mapScroll = this._mapScrollByFloor[floorId] || { left: 0, top: 0, leftRatio: 0, topRatio: 0, centerX: 0.5, centerY: 0.5, zoom: this._zoom };
    return true;
  }

  _applyExternalMapTarget(options = {}) {
    const target = this._externalMapTarget();
    if (!target) {
      this._lastExternalMapTargetKey = "";
      return false;
    }

    let floor = this._floorFromExternalValue(target.floorValue);
    if (!floor && target.markerKey) floor = this._floorForMarker(target.markerKey);
    if (!floor) return false;

    const rows = this._hass?.states ? this._deviceRows() : [];
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    let markerKey = target.markerKey;
    const markerRequest = markerKey.toLowerCase();
    if (target.offline && (!markerKey || ["first", "offline", "first-offline"].includes(markerRequest))) {
      markerKey = this._offlineMarkersByFloor(rowByKey).find((marker) => marker.floorId === floor.id)?.key || "";
    }
    if (markerKey && !this._markerExistsOnFloor(floor.id, markerKey)) markerKey = "";

    const completionPending = target.offline && !markerKey;
    const targetKey = `${window.location?.pathname || ""}?${window.location?.search || ""}|${floor.id}|${markerKey}|${target.offline ? "offline" : ""}`;
    if (!options.force && !completionPending && this._lastExternalMapTargetKey === targetKey) return false;

    let changed = this._switchToFloor(floor.id);
    if (markerKey) {
      this._pendingMarkerFocus = markerKey;
      changed = true;
    }

    this._lastExternalMapTargetKey = completionPending ? "" : targetKey;
    return changed;
  }

  _offlineMarkersByFloor(rowByKey) {
    return this._floors
      .flatMap((floor) => {
        const markers = floor.id === this._activeFloorId ? this._markers : this._floorMarkers[floor.id] || {};
        return Object.keys(markers)
          .map((key) => {
            const row = rowByKey.get(key);
            if (!row?.offline) return null;
            return {
              key,
              name: row.name,
              areaName: row.areaName,
              floorId: floor.id,
              floorName: floor.name,
            };
          })
          .filter(Boolean);
      })
      .sort((a, b) => a.floorName.localeCompare(b.floorName) || a.areaName.localeCompare(b.areaName) || a.name.localeCompare(b.name));
  }

  _offlineMarkerAlertTemplate(markers) {
    return `
      <section class="map-alert" aria-label="Offline markers">
        <div class="map-alert-title">
          <span>!</span>
          <strong>${this._escape(markers.length)} offline ${markers.length === 1 ? "marker" : "markers"}</strong>
        </div>
        <div class="map-alert-list">
          ${markers
            .map(
              (marker) => `
          <button
            type="button"
            data-jump-floor="${this._escape(marker.floorId)}"
            data-jump-marker="${this._escape(marker.key)}"
            title="${this._escape(`${marker.floorName} - ${marker.name}`)}"
          >
            <span>${this._escape(marker.floorName)}</span>
            ${this._escape(marker.name)}
          </button>
          `
            )
            .join("")}
        </div>
      </section>
    `;
  }

  _updateLiveMapState() {
    if (!this.shadowRoot?.querySelector("[data-map]")) {
      this._render({ preservePageScroll: true, preserveMapViewport: true });
      return;
    }

    const rows = this._deviceRows();
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    const isEditing = this._canEdit() && this._mode === "edit";
    let offlineCount = 0;
    let placedCount = 0;

    for (const [key] of Object.entries(this._markers || {})) {
      const row = rowByKey.get(key);
      if (!row) continue;
      placedCount += 1;
      if (row.offline) offlineCount += 1;
      const marker = this.shadowRoot.querySelector(`[data-marker="${this._cssEscape(key)}"]`);
      if (!marker) continue;
      const stateClass = this._stateClass(row);
      marker.classList.toggle("offline", row.offline);
      marker.classList.toggle("online", !row.offline);
      marker.classList.toggle("state-active", stateClass === "state-active");
      marker.classList.toggle("state-inactive", stateClass === "state-inactive");
      marker.classList.toggle("state-neutral", stateClass === "state-neutral");
      marker.classList.toggle("selected", isEditing && this._selectedMarkers.has(key));
      marker.removeAttribute("title");
      marker.setAttribute("aria-label", this._markerTitle(row));
      marker.dataset.entity = row.entityId;
      const icon = marker.querySelector("ha-icon");
      icon?.setAttribute("icon", this._markerIcon(row));
      const label = marker.querySelector(".marker-label");
      if (label) label.textContent = row.name;
      const tooltip = marker.querySelector(".marker-tooltip");
      if (tooltip) tooltip.innerHTML = this._markerTooltipTemplate(row);
    }

    const sidebarStatus = this.shadowRoot.querySelector(".sidebar-status");
    if (sidebarStatus) {
      sidebarStatus.textContent = `${isEditing ? "Edit Mode" : "User Mode"} - v${VERSION} - ${placedCount} placed / ${offlineCount} offline`;
    }

    this._captureMapScroll();
  }

  _jumpToMarker(floorId, markerKey) {
    if (!floorId || !markerKey || !this._floors.some((floor) => floor.id === floorId)) return;
    if (floorId === this._activeFloorId) {
      this._pendingMarkerFocus = null;
      this._focusMarker(markerKey);
      return;
    }

    this._switchToFloor(floorId);
    this._pendingMarkerFocus = markerKey;
    this._render();
  }

  _applyZoomToDom() {
    const zoomPercent = Math.round(this._zoom * 100);
    const map = this.shadowRoot?.querySelector("[data-map]");
    const content = this.shadowRoot?.querySelector(".map-content");
    const slider = this.shadowRoot?.querySelector("[data-zoom-slider]");
    const output = this.shadowRoot?.querySelector("[data-zoom-output]");
    const centerX = map?.scrollWidth ? (map.scrollLeft + map.clientWidth / 2) / map.scrollWidth : 0.5;
    const centerY = map?.scrollHeight ? (map.scrollTop + map.clientHeight / 2) / map.scrollHeight : 0.5;
    if (content) content.style.width = `${zoomPercent}%`;
    if (map) {
      map.classList.toggle("zoomed-out", this._zoom < 1);
      const maxLeft = Math.max(0, map.scrollWidth - map.clientWidth);
      const maxTop = Math.max(0, map.scrollHeight - map.clientHeight);
      const targetLeft = centerX * map.scrollWidth - map.clientWidth / 2;
      const targetTop = centerY * map.scrollHeight - map.clientHeight / 2;
      map.scrollLeft = Math.max(0, Math.min(maxLeft, targetLeft));
      map.scrollTop = Math.max(0, Math.min(maxTop, targetTop));
      this._captureMapScroll();
      this._rememberMapViewport({ save: true });
    }
    if (slider) slider.value = String(zoomPercent);
    if (output) output.textContent = `${zoomPercent}%`;
    this._positionNudgePad();
  }

  _focusMarker(markerKey) {
    const map = this.shadowRoot?.querySelector("[data-map]");
    const marker = this.shadowRoot?.querySelector(`[data-marker="${this._cssEscape(markerKey)}"]`);
    if (!map || !marker) return;

    this._isJumping = true;
    this._suppressMapRestoreUntil = Date.now() + 900;
    const left = marker.offsetLeft - map.clientWidth / 2 + marker.offsetWidth / 2;
    const top = marker.offsetTop - map.clientHeight / 2 + marker.offsetHeight / 2;
    const targetLeft = Math.max(0, Math.min(left, map.scrollWidth - map.clientWidth));
    const targetTop = Math.max(0, Math.min(top, map.scrollHeight - map.clientHeight));
    const maxLeft = Math.max(0, map.scrollWidth - map.clientWidth);
    const maxTop = Math.max(0, map.scrollHeight - map.clientHeight);
    this._mapScroll = {
      left: targetLeft,
      top: targetTop,
      leftRatio: maxLeft ? targetLeft / maxLeft : 0,
      topRatio: maxTop ? targetTop / maxTop : 0,
    };
    map.scrollTo({
      left: targetLeft,
      top: targetTop,
      behavior: "smooth",
    });
    marker.classList.add("jump-focus");
    window.setTimeout(() => {
      this._isJumping = false;
      this._captureMapScroll();
    }, 900);
    window.setTimeout(() => marker.classList.remove("jump-focus"), 1800);
  }

  _select(key, label, options) {
    const optionHtml = options
      .map(([value, text]) => `<option value="${this._escape(value)}" ${this._filters[key] === value ? "selected" : ""}>${this._escape(text)}</option>`)
      .join("");

    return `
      <label>
        <span>${this._escape(label)}</span>
        <select data-filter="${this._escape(key)}">${optionHtml}</select>
      </label>
    `;
  }

  _deviceListItem(row) {
    const placed = Boolean(this._markers[row.key]);
    const icon = this._markerIcon(row);
    return `
      <div class="device-row ${placed ? "is-placed" : ""} ${row.offline ? "offline" : "online"}" draggable="true" data-device="${this._escape(row.key)}">
        <span class="dot"><ha-icon icon="${this._escape(icon)}"></ha-icon></span>
        <span class="device-text">
          <strong>${this._escape(row.name)}</strong>
          <small>${this._escape(row.areaName)} - ${this._escape(row.deviceName || row.displayDomain || row.displayIntegration)}</small>
        </span>
        ${
          placed
            ? `<button type="button" class="remove" data-remove="${this._escape(row.key)}" title="Remove from map">Remove</button>`
            : `<span class="placed">Drag</span>`
        }
        ${placed ? this._iconSelect(row) : ""}
      </div>
    `;
  }

  _iconSelect(row) {
    const selected = this._markers[row.key]?.icon || "auto";
    const options = this._iconOptions()
      .map(([value, label]) => `<option value="${this._escape(value)}" ${selected === value ? "selected" : ""}>${this._escape(label)}</option>`)
      .join("");

    return `
      <label class="icon-picker">
        <span>Icon</span>
        <select data-icon="${this._escape(row.key)}">${options}</select>
      </label>
    `;
  }

  _markerTemplate(row, isEditing) {
    const marker = this._markers[row.key];
    const size = this._display.markerSize;
    const icon = this._markerIcon(row);
    const stateClass = this._stateClass(row);
    const title = this._markerTitle(row);
    return `
      <button
        class="marker ${this._display.showLabels ? "with-label" : "icon-only"} ${this._config.show_entity_state ? "state-mode" : ""} ${stateClass} ${isEditing && this._selectedMarkers.has(row.key) ? "selected" : ""} ${row.offline ? "offline" : "online"}"
        style="left: ${this._escape(marker.x)}%; top: ${this._escape(marker.y)}%; --marker-size: ${this._escape(size)}px;"
        draggable="${isEditing ? "true" : "false"}"
        data-marker="${this._escape(row.key)}"
        data-entity="${this._escape(row.entityId)}"
        aria-label="${this._escape(title)}"
      >
        <span class="marker-icon"><ha-icon icon="${this._escape(icon)}"></ha-icon></span>
        ${this._display.showLabels ? `<strong class="marker-label">${this._escape(row.name)}</strong>` : ""}
        <span class="marker-tooltip" role="tooltip">${this._markerTooltipTemplate(row)}</span>
      </button>
    `;
  }

  _markerTitle(row) {
    const title = this._config.show_entity_state ? `${row.name} - ${row.primaryState}` : row.name;
    return row.parentDeviceName ? `${title}\nConnected via ${row.parentDeviceName}` : title;
  }

  _markerTooltipTemplate(row) {
    const title = this._config.show_entity_state ? `${row.name} - ${row.primaryState}` : row.name;
    return `
      <span class="marker-tooltip-line">${this._escape(title)}</span>
      ${
        row.parentDeviceName
          ? `<span class="marker-tooltip-line marker-tooltip-parent">Connected via <strong>${this._escape(row.parentDeviceName)}</strong></span>`
          : ""
      }
    `;
  }

  _yamlExport(rows) {
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    if (this._hasMultipleFloors()) {
      return [
        "floors:",
        ...this._floors.flatMap((floor) => {
          const markers = this._yamlMarkersForFloor(floor.id, rowByKey);
          return [
            `  - id: ${floor.id}`,
            `    name: ${floor.name}`,
            `    image: ${floor.image}`,
            ...(markers.length
              ? [
                  "    markers:",
                  ...markers.flatMap((marker) => [
                    `      - key: ${marker.key}`,
                    `        entity: ${marker.entity}`,
                    `        name: ${marker.name}`,
                    ...(marker.icon ? [`        icon: ${marker.icon}`] : []),
                    `        x: ${marker.x}`,
                    `        y: ${marker.y}`,
                  ]),
                ]
              : ["    markers: []"]),
          ];
        }),
      ].join("\n");
    }

    const markers = this._yamlMarkersForFloor(this._activeFloorId, rowByKey);

    if (!markers.length) return "markers: []";

    return [
      "markers:",
      ...markers.flatMap((marker) => [
        `  - key: ${marker.key}`,
        `    entity: ${marker.entity}`,
        `    name: ${marker.name}`,
        ...(marker.icon ? [`    icon: ${marker.icon}`] : []),
        `    x: ${marker.x}`,
        `    y: ${marker.y}`,
      ]),
    ].join("\n");
  }

  _yamlMarkersForFloor(floorId, rowByKey) {
    const floorMarkers = floorId === this._activeFloorId ? this._markers : this._floorMarkers[floorId] || {};
    return Object.entries(floorMarkers)
      .map(([key, marker]) => {
        const row = rowByKey.get(key);
        return {
          key,
          entity: row?.entityId || marker.entityId,
          name: row?.name || marker.name || key,
          icon: marker.icon || "",
          x: Number(marker.x).toFixed(2),
          y: Number(marker.y).toFixed(2),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }


  _escape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  _styles() {
    return `
      <style>
        :host {
          display: block;
          --dmp-good: #1d8f5f;
          --dmp-bad: #d43636;
          --dmp-border: var(--divider-color, rgba(127, 127, 127, 0.24));
          --dmp-muted: var(--secondary-text-color, #667085);
        }

        .panel {
          display: grid;
          grid-template-columns: minmax(260px, 330px) 1fr;
        }

        .panel.viewing {
          display: block;
        }

        .panel.sidebar-collapsed {
          grid-template-columns: 1fr;
        }

        aside {
          position: sticky;
          top: 12px;
          display: grid;
          grid-template-rows: auto auto auto minmax(320px, 1fr) auto;
          gap: 8px;
          min-width: 0;
          height: calc(100vh - 24px);
          max-height: calc(100vh - 24px);
          border-right: 1px solid var(--dmp-border);
          box-sizing: border-box;
          padding: 14px;
        }

        header h2, header p {
          margin: 0;
        }

        header h2 {
          color: var(--primary-text-color);
          font-size: 20px;
          font-weight: 700;
          line-height: 1.2;
        }

        header p {
          color: var(--dmp-muted);
          font-size: 13px;
          margin-top: 4px;
        }

        .sidebar-status {
          color: var(--dmp-muted);
          font-size: 13px;
          font-weight: 700;
          line-height: 1.25;
        }

        .filters, .bulk-actions {
          display: grid;
          gap: 8px;
        }

        .bulk-actions {
          grid-template-columns: 1fr;
          border-top: 1px solid var(--dmp-border);
          padding: 8px 0 0;
        }

        .bulk-actions button {
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          font-weight: 700;
          min-height: 36px;
        }

        .bulk-actions button:hover {
          border-color: var(--primary-color, #03a9f4);
        }

        label {
          display: grid;
          gap: 5px;
          min-width: 0;
        }

        label span {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
        }

        select, input {
          box-sizing: border-box;
          width: 100%;
          min-height: 38px;
          min-width: 0;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          font: inherit;
          padding: 0 10px;
        }

        input[type="range"] {
          padding: 0;
        }

        input[type="checkbox"] {
          width: 16px;
          min-height: 16px;
          padding: 0;
        }

        .toggle-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .toggle-row span {
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .devices {
          display: grid;
          align-content: start;
          grid-auto-rows: max-content;
          gap: 7px;
          min-height: 0;
          overflow: auto;
          padding-right: 2px;
        }

        .device-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: start;
          gap: 9px;
          min-height: 48px;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          cursor: grab;
          padding: 8px;
        }

        .device-row.is-placed {
          grid-template-rows: auto auto;
          row-gap: 8px;
          min-height: 84px;
        }

        .device-row:active {
          cursor: grabbing;
        }

        .dot, .marker .marker-icon {
          display: grid;
          place-items: center;
          border-radius: 999px;
          background: var(--dmp-good);
          color: #fff;
        }

        .offline .dot, .marker.offline .marker-icon {
          background: var(--dmp-bad);
        }

        .dot {
          width: 28px;
          height: 28px;
          margin-top: 2px;
        }

        .dot ha-icon {
          --mdc-icon-size: 18px;
        }

        .device-text {
          display: grid;
          gap: 2px;
          min-width: 0;
        }

        .device-text strong, .device-text small {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .device-text strong {
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .device-text small, .placed, .empty-list {
          color: var(--dmp-muted);
          font-size: 12px;
        }

        .icon-picker {
          grid-column: 2 / 4;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 6px;
          margin-top: 0;
          align-self: end;
        }

        .icon-picker span {
          color: var(--dmp-muted);
          font-size: 11px;
          font-weight: 700;
        }

        .icon-picker select {
          min-height: 28px;
          font-size: 12px;
          padding: 0 7px;
        }

        .placed, .remove {
          border: 1px solid var(--dmp-border);
          border-radius: 999px;
          padding: 3px 7px;
        }

        .remove {
          background: transparent;
          color: var(--dmp-muted);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
        }

        .remove:hover {
          color: var(--dmp-bad);
          border-color: var(--dmp-bad);
        }

        main {
          position: relative;
          min-width: 0;
          padding: 14px;
        }

        .viewing main {
          padding: 0 0 14px;
        }

        .map-toolbar {
          position: sticky;
          z-index: 4;
          top: 12px;
          display: flex;
          flex-wrap: nowrap;
          align-items: center;
          gap: 10px;
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: thin;
          width: calc(100% - 24px);
          max-width: calc(100% - 24px);
          margin: 12px;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 3px 12px rgba(0, 0, 0, 0.18);
          padding: 4px;
        }

        .toolbar-title {
          flex: 0 1 260px;
          min-width: 0;
          max-width: 320px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--primary-text-color);
          font-size: 14px;
          font-weight: 800;
          padding: 0 10px;
        }

        .floor-switch {
          display: flex;
          align-items: center;
          flex: 0 1 260px;
          gap: 6px;
          min-width: 180px;
          max-width: 280px;
        }

        .floor-switch select {
          min-height: 30px;
          max-width: none;
          padding: 0 8px;
        }

        .floor-switch span {
          white-space: nowrap;
        }

        .mode-switch {
          flex: 0 0 auto;
          display: flex;
          gap: 4px;
          margin-left: auto;
        }

        .align-controls {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 4px;
          border-left: 1px solid var(--dmp-border);
          padding-left: 10px;
        }

        .align-controls span {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
          padding-right: 4px;
          white-space: nowrap;
        }

        .mode-switch button, .align-controls button, .sidebar-toggle {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--dmp-muted);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          min-height: 30px;
          padding: 0 10px;
        }

        .sidebar-toggle {
          flex: 0 0 auto;
          border-left: 1px solid var(--dmp-border);
          color: var(--primary-text-color);
          white-space: nowrap;
        }

        .sidebar-toggle:hover {
          background: var(--secondary-background-color, #f7f8fa);
        }

        .map-alert {
          display: flex;
          align-items: center;
          gap: 10px;
          width: calc(100% - 24px);
          max-width: calc(100% - 24px);
          margin: -4px 12px 10px;
          border: 1px solid rgba(212, 54, 54, 0.45);
          border-radius: 8px;
          background: linear-gradient(90deg, rgba(212, 54, 54, 0.18), rgba(212, 54, 54, 0.07));
          box-sizing: border-box;
          padding: 8px 10px;
        }

        .map-alert-title {
          display: flex;
          align-items: center;
          flex: 0 0 auto;
          gap: 7px;
          color: var(--primary-text-color);
          font-size: 13px;
          white-space: nowrap;
        }

        .map-alert-title span {
          display: grid;
          place-items: center;
          width: 22px;
          height: 22px;
          border-radius: 999px;
          background: var(--dmp-bad);
          color: #fff;
          font-weight: 900;
          box-shadow: 0 0 0 0 rgba(212, 54, 54, 0.45);
          animation: dmp-alert-pulse 1.8s ease-out infinite;
        }

        .map-alert-list {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          overflow-x: auto;
          scrollbar-width: thin;
        }

        .map-alert-list button {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex: 0 0 auto;
          max-width: 280px;
          min-height: 28px;
          border: 1px solid rgba(212, 54, 54, 0.45);
          border-radius: 999px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          padding: 0 9px;
        }

        .map-alert-list button:hover {
          border-color: var(--dmp-bad);
          color: var(--dmp-bad);
        }

        .map-alert-list button span {
          overflow: hidden;
          max-width: 120px;
          color: var(--dmp-bad);
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        @keyframes dmp-alert-pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(212, 54, 54, 0.45);
          }
          70% {
            box-shadow: 0 0 0 9px rgba(212, 54, 54, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(212, 54, 54, 0);
          }
        }

        .align-controls .tool-icon {
          display: grid;
          place-items: center;
          min-width: 34px;
          padding: 0;
        }

        .align-icon {
          position: relative;
          display: block;
          width: 22px;
          height: 22px;
          --guide-color: var(--primary-text-color);
          --block-color: #c052a8;
        }

        .align-icon::before,
        .align-icon::after {
          content: "";
          position: absolute;
          box-sizing: border-box;
        }

        .align-left::before,
        .align-right::before,
        .distribute-horizontal::before {
          top: 2px;
          bottom: 2px;
          width: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .align-left::before {
          left: 3px;
        }

        .align-right::before {
          right: 3px;
        }

        .align-left::after {
          left: 8px;
          top: 5px;
          width: 11px;
          height: 13px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 11px 5px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 0 8px / 8px 5px no-repeat;
        }

        .align-right::after {
          right: 8px;
          top: 5px;
          width: 11px;
          height: 13px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 11px 5px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 3px 8px / 8px 5px no-repeat;
        }

        .distribute-horizontal::before,
        .distribute-horizontal::after {
          top: 2px;
          bottom: 2px;
          width: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .distribute-horizontal::before {
          left: 2px;
        }

        .distribute-horizontal::after {
          right: 2px;
        }

        .distribute-horizontal {
          background:
            linear-gradient(var(--block-color), var(--block-color)) 7px 5px / 4px 12px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 14px 5px / 4px 12px no-repeat;
        }

        .align-top::before,
        .align-bottom::before {
          left: 2px;
          right: 2px;
          height: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .align-top::before {
          top: 3px;
        }

        .align-bottom::before {
          bottom: 3px;
        }

        .align-top::after {
          left: 5px;
          top: 8px;
          width: 13px;
          height: 11px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 5px 11px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 8px 0 / 5px 8px no-repeat;
        }

        .align-bottom::after {
          left: 5px;
          bottom: 8px;
          width: 13px;
          height: 11px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 5px 8px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 8px 0 / 5px 11px no-repeat;
        }

        .distribute-vertical::before,
        .distribute-vertical::after {
          left: 2px;
          right: 2px;
          height: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .distribute-vertical::before {
          top: 2px;
        }

        .distribute-vertical::after {
          bottom: 2px;
        }

        .distribute-vertical {
          background:
            linear-gradient(var(--block-color), var(--block-color)) 6px 6px / 10px 4px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 6px 12px / 10px 4px no-repeat;
        }

        .align-controls button:disabled {
          cursor: not-allowed;
          opacity: 0.45;
        }

        .align-controls button:not(:disabled):hover {
          background: var(--secondary-background-color, #f7f8fa);
        }

        .mode-switch button.active {
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
        }

        .zoom-controls {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .zoom-controls button,
        .marker-size-stepper button {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          min-height: 30px;
          min-width: 30px;
          padding: 0 8px;
        }

        .zoom-controls button:hover,
        .marker-size-stepper button:hover {
          background: var(--secondary-background-color, #f7f8fa);
        }

        .zoom-controls span,
        .display-controls span {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
        }

        .zoom-controls input[type="range"] {
          width: 120px;
          min-width: 80px;
        }

        .zoom-controls output,
        .marker-size-stepper output {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
          min-width: 42px;
          text-align: center;
        }

        .display-controls {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          width: auto;
          min-width: 150px;
          border-left: 1px solid var(--dmp-border);
          border-right: 1px solid var(--dmp-border);
          margin-left: 4px;
          padding: 0 10px;
        }

        .display-controls label {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .marker-size-stepper {
          display: flex;
          align-items: center;
          gap: 4px;
          white-space: nowrap;
        }

        .marker-size-stepper output {
          min-width: 24px;
        }

        .display-controls .toolbar-toggle {
          grid-template-columns: auto auto;
          justify-content: start;
          white-space: nowrap;
        }

        .map {
          position: relative;
          width: 100%;
          max-height: clamp(520px, 82vh, 1100px);
          overflow: auto;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          cursor: grab;
          touch-action: none;
        }

        .map.panning {
          cursor: grabbing;
          user-select: none;
        }

        .map.selecting {
          cursor: crosshair;
          user-select: none;
        }

        .nudge-pad {
          position: absolute;
          z-index: 5;
          left: 0;
          top: 0;
          display: grid;
          justify-content: center;
          grid-template-areas:
            ". up ."
            "left . right"
            ". down ."
            "step step step";
          grid-template-columns: 28px 28px 28px;
          grid-template-rows: 28px 28px 28px auto;
          gap: 3px;
          width: 112px;
          margin: 0;
          border: 1px solid rgba(127, 127, 127, 0.3);
          border-radius: 28px;
          background: rgba(255, 255, 255, 0.42);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
          opacity: 0.58;
          padding: 7px;
          pointer-events: auto;
          backdrop-filter: blur(3px);
        }

        .nudge-pad:hover {
          opacity: 0.95;
        }

        .nudge-pad button {
          display: grid;
          place-items: center;
          border: 1px solid rgba(29, 143, 95, 0.55);
          border-radius: 999px;
          background: rgba(160, 220, 120, 0.72);
          color: #1f5f2f;
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 900;
          line-height: 1;
          padding: 0;
        }

        .nudge-pad button:disabled {
          cursor: not-allowed;
          filter: grayscale(1);
          opacity: 0.45;
        }

        .nudge-pad button:not(:disabled):hover {
          background: rgba(150, 225, 95, 0.95);
        }

        .nudge-up {
          grid-area: up;
        }

        .nudge-left {
          grid-area: left;
        }

        .nudge-right {
          grid-area: right;
        }

        .nudge-down {
          grid-area: down;
        }

        .nudge-step {
          grid-area: step;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 5px;
          margin-top: 3px;
          min-width: 0;
        }

        .nudge-step span {
          color: #1f5f2f;
          font-size: 10px;
          font-weight: 800;
        }

        .nudge-step input {
          min-width: 0;
          min-height: 22px;
          width: 100%;
          border: 1px solid rgba(29, 143, 95, 0.45);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.8);
          color: #1f5f2f;
          font: inherit;
          font-size: 11px;
          font-weight: 800;
          padding: 0 5px;
        }

        .map-content {
          position: relative;
          margin: 0;
        }

        .zoomed-out .map-content {
          margin: 0 auto;
        }

        .viewing .map {
          border: 0;
          border-radius: var(--ha-card-border-radius, 12px);
        }

        .map img {
          display: block;
          width: 100%;
          height: auto;
          object-fit: contain;
          pointer-events: none;
          user-select: none;
        }

        .image-error {
          display: none;
          position: absolute;
          inset: 16px;
          place-items: center;
          border: 1px dashed var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          color: var(--dmp-muted);
          padding: 18px;
          text-align: center;
        }

        .image-failed .image-error {
          display: grid;
        }

        .marker {
          position: absolute;
          z-index: 3;
          display: flex;
          align-items: center;
          gap: 6px;
          max-width: min(240px, 42vw);
          min-width: 0;
          border: 0;
          border-radius: 999px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 3px 12px rgba(0, 0, 0, 0.28);
          color: var(--primary-text-color);
          cursor: grab;
          font: inherit;
          padding: 5px 8px 5px 5px;
          transform: translate(calc(var(--marker-size) / -2 - 5px), -50%);
        }

        .selection-box {
          position: absolute;
          z-index: 2;
          border: 1px solid var(--primary-color, #03a9f4);
          background: rgba(3, 169, 244, 0.16);
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
          pointer-events: none;
        }

        .marker.icon-only {
          display: grid;
          place-items: center;
          width: calc(var(--marker-size) + 10px);
          height: calc(var(--marker-size) + 10px);
          max-width: none;
          padding: 5px;
        }

        .marker:active {
          cursor: grabbing;
        }

        .marker.selected {
          outline: 3px solid var(--primary-color, #03a9f4);
          outline-offset: 4px;
        }

        .marker:hover,
        .marker:focus-visible {
          z-index: 8;
        }

        .marker.jump-focus {
          outline: 4px solid var(--dmp-bad);
          outline-offset: 7px;
          animation: marker-jump-focus 1.4s ease-out 1;
        }

        @keyframes marker-jump-focus {
          0%, 100% {
            transform: translate(calc(var(--marker-size) / -2 - 5px), -50%) scale(1);
          }
          35% {
            transform: translate(calc(var(--marker-size) / -2 - 5px), -50%) scale(1.18);
          }
        }

        .marker .marker-icon {
          display: grid;
          flex: 0 0 var(--marker-size);
          place-items: center;
          width: var(--marker-size);
          height: var(--marker-size);
          min-width: var(--marker-size);
          min-height: var(--marker-size);
          border-radius: 50%;
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 0 13px rgba(29, 143, 95, 0.78);
          line-height: 0;
        }

        .marker.online .marker-icon {
          background: var(--dmp-good);
        }

        .marker.offline .marker-icon {
          background: var(--dmp-bad);
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 0 15px rgba(212, 54, 54, 0.9);
        }

        .marker.state-mode.online .marker-icon {
          box-shadow: 0 0 0 3px rgba(29, 143, 95, 0.96), 0 0 16px rgba(29, 143, 95, 0.8);
        }

        .marker.state-mode.state-active .marker-icon {
          background: #f5c542;
          color: #111;
        }

        .marker.state-mode.state-inactive .marker-icon {
          background: #111827;
          color: #fff;
        }

        .marker.state-mode.state-neutral .marker-icon {
          background: #64748b;
          color: #fff;
        }

        .marker.state-mode.offline .marker-icon {
          background: var(--dmp-bad);
          color: #fff;
          box-shadow: 0 0 0 3px rgba(212, 54, 54, 0.98), 0 0 18px rgba(212, 54, 54, 0.95);
        }

        .marker ha-icon {
          --mdc-icon-size: calc(var(--marker-size) * 0.68);
          display: block;
          width: calc(var(--marker-size) * 0.68);
          height: calc(var(--marker-size) * 0.68);
          line-height: 1;
        }

        .marker-label {
          display: block;
          min-width: 0;
          max-width: calc(240px - var(--marker-size) - 24px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
        }

        .marker-tooltip {
          position: absolute;
          left: 50%;
          bottom: calc(100% + 10px);
          z-index: 20;
          display: grid;
          gap: 4px;
          width: max-content;
          max-width: min(300px, 72vw);
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          color: var(--primary-text-color);
          font-size: 12px;
          line-height: 1.35;
          opacity: 0;
          padding: 8px 10px;
          pointer-events: none;
          text-align: left;
          transform: translate(-50%, 4px);
          transition: opacity 120ms ease, transform 120ms ease, visibility 120ms ease;
          visibility: hidden;
          white-space: nowrap;
        }

        .marker-tooltip::after {
          position: absolute;
          left: 50%;
          bottom: -5px;
          width: 10px;
          height: 10px;
          border-right: 1px solid var(--dmp-border);
          border-bottom: 1px solid var(--dmp-border);
          background: var(--card-background-color, #fff);
          content: "";
          transform: translateX(-50%) rotate(45deg);
        }

        .marker:hover .marker-tooltip,
        .marker:focus-visible .marker-tooltip {
          opacity: 1;
          transform: translate(-50%, 0);
          visibility: visible;
        }

        .marker-tooltip-line {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .marker-tooltip-parent {
          color: var(--secondary-text-color, #64748b);
        }

        .marker-tooltip-parent strong {
          color: var(--primary-text-color);
          font-weight: 800;
        }

        .missing-image {
          display: grid;
          min-height: 520px;
          place-items: center;
          border: 1px dashed var(--dmp-border);
          border-radius: 8px;
          color: var(--dmp-muted);
          text-align: center;
        }

        .export {
          border-top: 1px solid var(--dmp-border);
          padding-top: 10px;
        }

        .export summary {
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
        }

        textarea {
          box-sizing: border-box;
          width: 100%;
          min-height: 150px;
          margin-top: 8px;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          font: 12px/1.4 monospace;
          padding: 8px;
          resize: vertical;
        }

        @media (max-width: 900px) {
          .panel {
            grid-template-columns: 1fr;
          }

          aside {
            position: relative;
            top: auto;
            height: auto;
            border-right: 0;
            border-bottom: 1px solid var(--dmp-border);
            max-height: 520px;
          }

          .map-toolbar {
            flex-wrap: nowrap;
            width: auto;
          }

          .align-controls {
            border-left: 0;
            border-top: 0;
            flex-wrap: nowrap;
            padding-left: 0;
            padding-top: 0;
          }

          .floor-switch {
            width: auto;
          }

          .floor-switch select {
            max-width: none;
          }

          .display-controls {
            width: auto;
            min-width: 150px;
            border-left: 0;
            border-right: 0;
            border-top: 0;
            border-bottom: 0;
            margin-left: 0;
            padding: 0;
          }
        }
      </style>
    `;
  }
}

customElements.define("device-map-panel", DeviceMapPanel);

class DeviceMapPanelEditor extends DevicePanelConfigEditor {
  constructor() {
    super();
    this._entities = [];
    this._areas = [];
    this._registriesLoaded = false;
    this._optionsSignature = "";
  }

  setConfig(config) {
    const nextConfig = {
      title: "Device Map",
      image: "",
      offline_states: ["unavailable", "unknown"],
      domains: [],
      integrations: [],
      areas: [],
      domain_labels: {},
      integration_labels: {},
      markers: [],
      floors: [],
      persist_layout: true,
      storage_key: "",
      marker_size: 18,
      show_labels: true,
      show_entity_state: false,
      nudge_step: 1,
      ...config,
    };
    this._config = nextConfig;
    if (this._skipNextSetConfigRender) {
      this._skipNextSetConfigRender = false;
      return;
    }
    this._layoutError = "";
    this._renderEditor();
  }

  _handleHassChanged(hass) {
    this._loadEditorRegistries(hass);
    this._renderEditorIfOptionsChanged();
  }

  async _loadEditorRegistries(hass) {
    if (this._registriesLoaded || !hass?.callWS) return;
    this._registriesLoaded = true;
    try {
      const [entities, areas] = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/area_registry/list" }),
      ]);
      this._entities = entities || [];
      this._areas = areas || [];
      this._renderEditorIfOptionsChanged();
    } catch (error) {
      console.warn("device-map-panel-editor: registry lookup failed", error);
    }
  }

  _renderEditor() {
    if (!this._config) return;
    this._optionsSignature = this._currentOptionsSignature();
    this.shadowRoot.innerHTML = `
      ${this._editorStyle()}
      <div class="editor">
        <fieldset>
          <legend>General</legend>
          ${this._field("title", "Title")}
          ${this._checkbox("persist_layout", "Remember marker layout in this browser", { defaultValue: true })}
        </fieldset>
        <fieldset>
          <legend>Display</legend>
          ${this._field("marker_size", "Marker size", { type: "number", min: 12, max: 48, step: 1 })}
          ${this._field("nudge_step", "Nudge step", { type: "number", min: 0.05, max: 10, step: 0.05 })}
          ${this._checkbox("show_labels", "Show marker names", { defaultValue: true })}
          ${this._checkbox("show_entity_state", "Show entity state styling", { defaultValue: false })}
        </fieldset>
        <fieldset>
          <legend>Filters</legend>
          ${this._textarea("offline_states", "Offline states", { rows: 3 })}
          ${this._multiPicker("domains", "Domains to include", this._domainOptions(), { labelKey: "domain_labels", placeholder: "Custom domain name" })}
          ${this._multiPicker("integrations", "Integrations to include", this._integrationOptions(), { labelKey: "integration_labels", placeholder: "Custom integration name" })}
          ${this._multiPicker("areas", "Areas to include", this._areaOptions())}
        </fieldset>
        <fieldset>
          <legend>Floors and Markers</legend>
          <label>
            <span>Floors and markers</span>
            <textarea data-layout-yaml rows="12">${this._escape(this._layoutYamlFromConfig(this._config))}</textarea>
          </label>
          <button type="button" data-apply-layout>Apply floors and markers</button>
          <div class="error" data-layout-error></div>
        </fieldset>
      </div>
    `;
    this._wireBasicInputs(["offline_states"]);
    this.shadowRoot.querySelector("[data-apply-layout]")?.addEventListener("click", () => this._applyLayoutYaml());
    this._wireMultiPickers();
    this._wireLabelInputs();
  }

  _renderEditorIfOptionsChanged() {
    if (!this._config) return;
    const signature = this._currentOptionsSignature();
    if (signature === this._optionsSignature) return;
    this._renderEditor();
  }

  _currentOptionsSignature() {
    return JSON.stringify({
      domains: this._domainOptions(),
      integrations: this._integrationOptions(),
      areas: this._areaOptions(),
    });
  }

  _domainOptions() {
    const states = this._hass?.states || {};
    return [...new Set(Object.keys(states).map((entityId) => entityId.split(".")[0]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _integrationOptions() {
    const states = this._hass?.states || {};
    const fromRegistry = this._entities.map((entity) => entity.platform).filter(Boolean);
    const fromStates = Object.values(states)
      .flatMap((stateObj) => [stateObj.attributes?.integration, stateObj.attributes?.platform])
      .filter(Boolean);
    return [...new Set([...fromRegistry, ...fromStates])].sort((a, b) => a.localeCompare(b));
  }

  _areaOptions() {
    const states = this._hass?.states || {};
    const fromRegistry = this._areas.map((area) => area.name || area.area_id || area.id).filter(Boolean);
    const fromStates = Object.values(states)
      .flatMap((stateObj) => [stateObj.attributes?.area, stateObj.attributes?.area_id])
      .filter(Boolean);
    return [...new Set([...fromRegistry, ...fromStates])].sort((a, b) => a.localeCompare(b));
  }

  _layoutYamlFromConfig(config) {
    if (Array.isArray(config.floors) && config.floors.length) {
      return [
        "floors:",
        ...config.floors.flatMap((floor) => [
          `  - id: ${this._yamlScalar(floor.id || "")}`,
          `    name: ${this._yamlScalar(floor.name || floor.title || "")}`,
          `    image: ${this._yamlScalar(floor.image || "")}`,
          ...(Array.isArray(floor.markers) && floor.markers.length
            ? [
                "    markers:",
                ...floor.markers.flatMap((marker) => this._markerYaml(marker, 6)),
              ]
            : ["    markers: []"]),
        ]),
      ].join("\n");
    }

    if (config.image || (Array.isArray(config.markers) && config.markers.length)) {
      return [
        "floors:",
        "  - id: default",
        `    name: ${this._yamlScalar(config.title || "Floor")}`,
        `    image: ${this._yamlScalar(config.image || "")}`,
        ...(Array.isArray(config.markers) && config.markers.length
          ? [
              "    markers:",
              ...config.markers.flatMap((marker) => this._markerYaml(marker, 6)),
            ]
          : ["    markers: []"]),
      ].join("\n");
    }

    return ["floors:", "  - id: default", `    name: ${this._yamlScalar(config.title || "Floor")}`, '    image: ""', "    markers: []"].join("\n");
  }

  _markerYaml(marker, indent) {
    const space = " ".repeat(indent);
    const child = " ".repeat(indent + 2);
    return [
      `${space}- key: ${this._yamlScalar(marker.key || marker.entity || marker.device || "")}`,
      `${child}entity: ${this._yamlScalar(marker.entity || marker.entityId || marker.key || "")}`,
      ...(marker.name ? [`${child}name: ${this._yamlScalar(marker.name)}`] : []),
      ...(marker.icon ? [`${child}icon: ${this._yamlScalar(marker.icon)}`] : []),
      `${child}x: ${Number(marker.x || 0).toFixed(2)}`,
      `${child}y: ${Number(marker.y || 0).toFixed(2)}`,
    ];
  }

  _yamlScalar(value) {
    const text = String(value ?? "");
    if (!text) return '""';
    if (/^[A-Za-z0-9_.:/@+-]+$/.test(text)) return text;
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  _applyLayoutYaml() {
    const textarea = this.shadowRoot.querySelector("[data-layout-yaml]");
    const error = this.shadowRoot.querySelector("[data-layout-error]");
    try {
      const layout = this._parseLayoutYaml(textarea?.value || "");
      const nextConfig = { ...this._config };
      if (layout.floors) {
        nextConfig.floors = layout.floors;
        delete nextConfig.markers;
        delete nextConfig.image;
      } else {
        nextConfig.markers = layout.markers || [];
        delete nextConfig.floors;
      }
      if (error) error.textContent = "";
      this._emitConfig(nextConfig);
    } catch (parseError) {
      if (error) error.textContent = parseError.message || "Floors and markers YAML could not be parsed.";
    }
  }

  _parseLayoutYaml(text) {
    const value = String(text || "").trim();
    if (!value) return { markers: [] };

    if (window.jsyaml?.load) {
      const parsed = window.jsyaml.load(value) || {};
      if (Array.isArray(parsed.floors)) return { floors: parsed.floors };
      if (Array.isArray(parsed.markers)) return { markers: parsed.markers };
      throw new Error("Use a top-level markers: or floors: block.");
    }

    return this._parseSimpleLayoutYaml(value);
  }

  _parseSimpleLayoutYaml(text) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/\t/g, "  "))
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    const root = lines[0]?.trim();

    if (root === "markers: []") return { markers: [] };
    if (root === "floors: []") return { floors: [] };
    if (root === "markers:") {
      return { markers: this._parseYamlObjectList(lines, 1, 2).items };
    }
    if (root === "floors:") {
      return { floors: this._parseYamlObjectList(lines, 1, 2).items };
    }

    throw new Error("Use a top-level markers: or floors: block.");
  }

  _parseYamlObjectList(lines, startIndex, itemIndent) {
    const items = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = lines[index];
      const indent = this._yamlIndent(line);
      const trimmed = line.trim();
      if (indent < itemIndent) break;
      if (indent !== itemIndent || !trimmed.startsWith("- ")) {
        index += 1;
        continue;
      }

      const item = {};
      this._assignYamlPair(item, trimmed.slice(2));
      index += 1;

      while (index < lines.length) {
        const childLine = lines[index];
        const childIndent = this._yamlIndent(childLine);
        const childTrimmed = childLine.trim();
        if (childIndent <= itemIndent && childTrimmed.startsWith("- ")) break;
        if (childIndent < itemIndent + 2) break;

        if (childIndent === itemIndent + 2 && childTrimmed === "markers: []") {
          item.markers = [];
          index += 1;
          continue;
        }

        if (childIndent === itemIndent + 2 && childTrimmed === "markers:") {
          const parsed = this._parseYamlObjectList(lines, index + 1, itemIndent + 4);
          item.markers = parsed.items;
          index = parsed.index;
          continue;
        }

        if (childIndent === itemIndent + 2) {
          this._assignYamlPair(item, childTrimmed);
        }
        index += 1;
      }

      items.push(item);
    }

    return { items, index };
  }

  _assignYamlPair(target, text) {
    const match = String(text || "").match(/^([^:]+):(?:\s*(.*))?$/);
    if (!match) return;
    const key = match[1].trim();
    const value = match[2] ?? "";
    target[key] = this._parseYamlScalar(value);
  }

  _parseYamlScalar(value) {
    const text = String(value ?? "").trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (text === "true") return true;
    if (text === "false") return false;
    if (text !== "" && Number.isFinite(Number(text))) return Number(text);
    return text;
  }

  _yamlIndent(line) {
    return String(line || "").match(/^ */)?.[0].length || 0;
  }
}

customElements.define("device-map-panel-editor", DeviceMapPanelEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "device-map-panel",
  name: "Device Map Panel",
  description: "Drag-and-drop Home Assistant device status map for floor plans and drawings.",
});
