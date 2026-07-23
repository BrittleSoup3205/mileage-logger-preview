(() => {
  "use strict";

  const STATE_KEY = "mileage_logger_state_v3";
  const INSPECTION_SCHEMA_VERSION = 1;
  const REFRESH_INTERVAL_MS = 1200;
  const nativeSetItem = window.localStorage.setItem.bind(window.localStorage);
  const $ = (id) => document.getElementById(id);

  let editingInspectionId = null;
  let currentTripId = "";
  let activeView = "inspections";
  let lastStateSignature = "";

  const INSPECTION_TYPES = [
    "Inspection",
    "Pre-Fab Meeting",
    "Material Inspection",
    "Fit-up Inspection",
    "Welding Surveillance",
    "NDE Review",
    "Hydro Test",
    "Coating Inspection",
    "Final Inspection",
    "Document Review",
    "Phone / Coordination",
    "Other"
  ];

  const INSPECTION_STATUSES = ["Complete", "In Progress", "Pending", "Released", "Hold"];
  const ACCEPTANCE_STATUSES = [
    "Not Determined",
    "Accepted",
    "Accepted with Follow-up",
    "Released",
    "Hold",
    "Rejected"
  ];

  function makeId(prefix = "inspection") {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[\",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function readState() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STATE_KEY) || "{}");
      parsed.trips = Array.isArray(parsed.trips) ? parsed.trips : [];
      parsed.settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
      parsed.settings.inspections = Array.isArray(parsed.settings.inspections)
        ? parsed.settings.inspections
        : [];
      parsed.settings.inspectionIgnoredTripIds = Array.isArray(parsed.settings.inspectionIgnoredTripIds)
        ? parsed.settings.inspectionIgnoredTripIds
        : [];
      parsed.settings.inspectionSchemaVersion = INSPECTION_SCHEMA_VERSION;
      parsed.backup = parsed.backup && typeof parsed.backup === "object" ? parsed.backup : {};
      return parsed;
    } catch (error) {
      console.error("Inspection database could not read mileage state:", error);
      return {
        trips: [],
        settings: {
          inspections: [],
          inspectionIgnoredTripIds: [],
          inspectionSchemaVersion: INSPECTION_SCHEMA_VERSION
        },
        backup: {}
      };
    }
  }

  function writeState(state) {
    state.settings = state.settings || {};
    state.settings.inspections = Array.isArray(state.settings.inspections)
      ? state.settings.inspections
      : [];
    state.settings.inspectionIgnoredTripIds = Array.isArray(state.settings.inspectionIgnoredTripIds)
      ? state.settings.inspectionIgnoredTripIds
      : [];
    state.settings.inspectionSchemaVersion = INSPECTION_SCHEMA_VERSION;
    nativeSetItem(STATE_KEY, JSON.stringify(state));

    // The main mileage app listens for this event and reloads its in-memory state.
    window.dispatchEvent(new Event("storage"));
    lastStateSignature = "";
    refreshFromState(true);
  }

  function updateState(mutator) {
    const state = readState();
    mutator(state);
    state.settings.inspectionLastChangedISO = nowISO();
    writeState(state);
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function todayInputValue() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function inputDateFromTrip(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (match) return `${match[3]}-${match[1]}-${match[2]}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    return todayInputValue();
  }

  function displayDate(value) {
    if (!value) return "—";
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return `${match[2]}/${match[3]}/${match[1]}`;
    return String(value);
  }

  function formatMiles(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(1)} mi` : "—";
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function parseTimeToMinutes(value) {
    const text = String(value || "").trim();
    if (!text) return null;

    const twentyFourHour = text.match(/^(\d{1,2}):(\d{2})$/);
    if (twentyFourHour) {
      const hour = Number(twentyFourHour[1]);
      const minute = Number(twentyFourHour[2]);
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return hour * 60 + minute;
    }

    const twelveHour = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!twelveHour) return null;
    let hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2]);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (hour === 12) hour = 0;
    if (twelveHour[3].toUpperCase() === "PM") hour += 12;
    return hour * 60 + minute;
  }

  function calculateHours(start, end) {
    const startMinutes = parseTimeToMinutes(start);
    const endMinutes = parseTimeToMinutes(end);
    if (startMinutes === null || endMinutes === null) return "";
    let difference = endMinutes - startMinutes;
    if (difference < 0) difference += 24 * 60;
    return (difference / 60).toFixed(2);
  }

  function mapLink(location, label) {
    if (!location) return "";
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "";
    return `https://maps.apple.com/?ll=${encodeURIComponent(latitude)},${encodeURIComponent(longitude)}&q=${encodeURIComponent(label || "Location")}`;
  }

  function getTripById(state, tripId) {
    if (!tripId) return null;
    return state.trips.find((trip) => trip.id === tripId) || null;
  }

  function tripSnapshot(trip) {
    if (!trip) return null;
    return {
      tripId: trip.id,
      date: trip.date || "",
      startTime: trip.startTime || "",
      endTime: trip.endTime || "",
      startOdometer: trip.startOdometer ?? "",
      endOdometer: trip.endOdometer ?? "",
      miles: Number(trip.miles || 0),
      gpsRouteMiles: Number(trip.gpsRouteMiles || 0),
      startLocation: trip.startLocation || null,
      endLocation: trip.endLocation || null,
      staGenerated: Boolean(trip.staGenerated),
      staFileName: trip.staFileName || ""
    };
  }

  function inspectionSearchText(inspection) {
    const followUps = Array.isArray(inspection.followUps) ? inspection.followUps : [];
    return [
      inspection.date,
      inspection.customer,
      inspection.vendor,
      inspection.projectNumber,
      inspection.purchaseOrderJob,
      inspection.equipmentTag,
      inspection.inspectionType,
      inspection.activity,
      inspection.status,
      inspection.summary,
      inspection.observations,
      inspection.deficiencies,
      inspection.acceptanceStatus,
      ...followUps.flatMap((item) => [item.action, item.responsibleParty, item.status])
    ].join(" ").toLowerCase();
  }

  function latestInspectionChangeISO(inspections) {
    return inspections.reduce((latest, inspection) => {
      const candidate = inspection.modifiedISO || inspection.createdISO || "";
      return candidate > latest ? candidate : latest;
    }, "");
  }

  function inspectionBackupIsCurrent(state) {
    const latestChange = state.settings.inspectionLastChangedISO
      || latestInspectionChangeISO(state.settings.inspections);
    if (!latestChange) return true;
    const confirmed = state.backup?.lastConfirmedISO || "";
    return Boolean(confirmed && confirmed >= latestChange);
  }

  function createOptionList(values, selectedValue) {
    return values.map((value) => (
      `<option value="${escapeHTML(value)}"${value === selectedValue ? " selected" : ""}>${escapeHTML(value)}</option>`
    )).join("");
  }

  function injectStyles() {
    if ($("inspectionDatabaseStyles")) return;
    const style = document.createElement("style");
    style.id = "inspectionDatabaseStyles";
    style.textContent = `
      .inspection-prompt-card { border: 2px solid var(--info); }
      .inspection-prompt-card .inspection-prompt-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
      .inspection-button { color: #ffffff; background: #1d4ed8; }
      body.dark .inspection-button { color: #0b1220; background: #93c5fd; }
      .inspection-dashboard { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 15px; }
      .inspection-metric { padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: color-mix(in srgb, var(--card), var(--bg) 35%); }
      .inspection-metric span { display: block; color: var(--muted); font-size: .78rem; font-weight: 700; }
      .inspection-metric strong { display: block; margin-top: 4px; font-size: 1.3rem; }
      .inspection-toolbar { display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 13px; }
      .inspection-toolbar .active-view { outline: 3px solid color-mix(in srgb, var(--info), transparent 65%); }
      .inspection-backup-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; padding: 12px; border: 1px solid var(--warning); border-radius: 12px; color: var(--warning); background: color-mix(in srgb, var(--warning), transparent 94%); }
      .inspection-backup-notice.current { color: var(--success); border-color: var(--success); background: color-mix(in srgb, var(--success), transparent 94%); }
      .inspection-form-panel { margin: 13px 0 16px; padding: 14px; border: 2px solid var(--info); border-radius: 14px; background: color-mix(in srgb, var(--info), transparent 96%); }
      .inspection-form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 11px; }
      .inspection-form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .inspection-form-grid .full { grid-column: 1 / -1; }
      .inspection-list { display: grid; gap: 12px; }
      .inspection-record { padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--card), var(--bg) 28%); }
      .inspection-record-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .inspection-record-heading h3 { margin: 2px 0 4px; }
      .inspection-meta { display: flex; flex-wrap: wrap; gap: 7px 12px; margin: 9px 0; color: var(--muted); font-size: .88rem; }
      .inspection-summary { margin: 10px 0; line-height: 1.45; white-space: pre-wrap; }
      .inspection-record-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 11px; }
      .inspection-followups { display: grid; gap: 8px; margin-top: 10px; }
      .inspection-followup { padding: 10px; border-left: 4px solid var(--warning); border-radius: 9px; background: color-mix(in srgb, var(--warning), transparent 95%); }
      .inspection-followup.closed { border-left-color: var(--success); background: color-mix(in srgb, var(--success), transparent 95%); }
      .followup-editor-list { display: grid; gap: 10px; }
      .followup-editor { padding: 11px; border: 1px solid var(--line); border-radius: 11px; background: var(--card); }
      .followup-editor-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap: 8px; align-items: end; }
      .inspection-linked-trip { padding: 10px; border: 1px dashed var(--line); border-radius: 10px; background: var(--card); }
      .inspection-empty { padding: 18px; color: var(--muted); text-align: center; border: 1px dashed var(--line); border-radius: 12px; }
      .inspection-pill-open { color: var(--warning); background: color-mix(in srgb, var(--warning), transparent 88%); }
      .inspection-pill-complete { color: var(--success); background: color-mix(in srgb, var(--success), transparent 88%); }
      .bottom-nav.inspection-nav-enabled { grid-template-columns: repeat(6, 1fr); }
      .bottom-nav.inspection-nav-enabled button { font-size: .76rem; }
      @media (max-width: 760px) {
        .inspection-dashboard { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .inspection-form-grid, .inspection-form-grid.two { grid-template-columns: 1fr; }
        .followup-editor-grid { grid-template-columns: 1fr; }
        .inspection-record-heading, .inspection-backup-notice { flex-direction: column; }
      }
    `;
    document.head.appendChild(style);
  }

  function injectInterface() {
    injectStyles();

    const quickActions = document.querySelector(".quick-actions");
    if (quickActions && !$('inspectionBtn')) {
      const button = document.createElement("button");
      button.id = "inspectionBtn";
      button.className = "button inspection-button button-large";
      button.type = "button";
      button.textContent = "Inspections";
      quickActions.appendChild(button);
    }

    const bottomNav = document.querySelector(".bottom-nav");
    if (bottomNav && !$('inspectionNavBtn')) {
      const button = document.createElement("button");
      button.id = "inspectionNavBtn";
      button.type = "button";
      button.textContent = "Inspect";
      bottomNav.appendChild(button);
      bottomNav.classList.add("inspection-nav-enabled");
    }

    const backupCard = $("backupCard");
    if (backupCard && !$('inspectionPromptCard')) {
      const prompt = document.createElement("section");
      prompt.id = "inspectionPromptCard";
      prompt.className = "card inspection-prompt-card hidden";
      prompt.setAttribute("aria-live", "polite");
      backupCard.insertAdjacentElement("afterend", prompt);
    }

    if (!$('inspectionSection')) {
      const section = document.createElement("section");
      section.id = "inspectionSection";
      section.className = "card collapsible hidden";
      section.setAttribute("aria-labelledby", "inspectionTitle");
      section.innerHTML = `
        <div class="section-heading">
          <div>
            <p class="eyebrow">Inspection database</p>
            <h2 id="inspectionTitle">Inspection Records</h2>
            <p class="muted">Trip-linked and standalone work records stored inside the full app backup.</p>
          </div>
          <button id="closeInspectionSection" class="button button-quiet button-small" type="button">Close</button>
        </div>

        <div id="inspectionDashboard" class="inspection-dashboard"></div>
        <div id="inspectionBackupNotice" class="inspection-backup-notice"></div>

        <div class="inspection-toolbar">
          <button id="newInspectionBtn" class="button inspection-button" type="button">New Inspection</button>
          <button id="inspectionListViewBtn" class="button button-secondary active-view" type="button">Inspection History</button>
          <button id="followUpViewBtn" class="button button-secondary" type="button">Open Follow-ups</button>
          <button id="exportInspectionsBtn" class="button button-secondary" type="button">Export Inspection CSV</button>
        </div>

        <div id="inspectionFormPanel" class="inspection-form-panel hidden"></div>

        <div class="log-toolbar">
          <input id="inspectionSearch" class="search-input" placeholder="Search project, vendor, type, summary, or follow-up">
          <button id="clearInspectionSearch" class="button button-secondary button-small" type="button">Clear Search</button>
        </div>

        <div id="inspectionList" class="inspection-list"></div>
      `;

      const settingsSection = $("settingsSection");
      const main = document.querySelector("main");
      if (settingsSection) settingsSection.insertAdjacentElement("beforebegin", section);
      else if (main) main.appendChild(section);
      else document.body.appendChild(section);
    }

    const helpCard = document.querySelector(".help-card");
    if (helpCard && !$('inspectionLinkExample')) {
      const code = document.createElement("code");
      code.id = "inspectionLinkExample";
      const url = new URL(window.location.href);
      url.search = "";
      url.hash = "";
      code.textContent = `${url.toString()}?action=inspection`;
      helpCard.appendChild(code);
    }
  }

  function showInspectionSection(openNew = false, tripId = "") {
    ["startSection", "endSection", "staSection", "logSection"].forEach((id) => {
      $(id)?.classList.add("hidden");
    });
    $("inspectionSection")?.classList.remove("hidden");
    if (openNew) openInspectionForm(null, tripId);
    setTimeout(() => $("inspectionSection")?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }

  function hideInspectionSection() {
    $("inspectionSection")?.classList.add("hidden");
    closeInspectionForm();
  }

  function renderPrompt(state) {
    const card = $("inspectionPromptCard");
    if (!card) return;

    const inspectionTripIds = new Set(
      state.settings.inspections.map((inspection) => inspection.tripId).filter(Boolean)
    );
    const ignored = new Set(state.settings.inspectionIgnoredTripIds);
    const candidate = [...state.trips]
      .sort((a, b) => String(b.endISO || "").localeCompare(String(a.endISO || "")))
      .find((trip) => trip.id && !inspectionTripIds.has(trip.id) && !ignored.has(trip.id));

    const backupPending = Number(state.backup?.pendingTripCount || 0) > 0;
    if (!candidate || backupPending) {
      card.classList.add("hidden");
      card.innerHTML = "";
      return;
    }

    card.innerHTML = `
      <p class="eyebrow">Completed trip ready</p>
      <h2>Create an inspection record?</h2>
      <p>
        <strong>${escapeHTML(candidate.vendor || "Destination")}</strong>
        ${candidate.projectNumber ? `• ${escapeHTML(candidate.projectNumber)}` : ""}<br>
        ${escapeHTML(candidate.date || "")}${candidate.miles !== undefined ? ` • ${formatMiles(candidate.miles)}` : ""}
      </p>
      <div class="inspection-prompt-actions">
        <button class="button inspection-button" type="button" data-create-inspection-trip="${escapeHTML(candidate.id)}">Create Inspection Record</button>
        <button class="button button-secondary" type="button" data-ignore-inspection-trip="${escapeHTML(candidate.id)}">Not an Inspection</button>
      </div>
    `;
    card.classList.remove("hidden");
  }

  function renderDashboard(state) {
    const inspections = state.settings.inspections;
    const openFollowUps = inspections.reduce((count, inspection) => (
      count + (inspection.followUps || []).filter((item) => item.status !== "Closed").length
    ), 0);
    const linked = inspections.filter((inspection) => inspection.tripId).length;
    const standalone = inspections.length - linked;

    $("inspectionDashboard").innerHTML = `
      <div class="inspection-metric"><span>Total inspections</span><strong>${inspections.length}</strong></div>
      <div class="inspection-metric"><span>Open follow-ups</span><strong>${openFollowUps}</strong></div>
      <div class="inspection-metric"><span>Trip-linked</span><strong>${linked}</strong></div>
      <div class="inspection-metric"><span>Standalone</span><strong>${standalone}</strong></div>
    `;

    const notice = $("inspectionBackupNotice");
    const current = inspectionBackupIsCurrent(state);
    notice.classList.toggle("current", current);
    notice.innerHTML = current
      ? `<div><strong>Inspection backup is current.</strong><br><small>The latest inspection changes are included in a confirmed full backup.</small></div>`
      : `<div><strong>Inspection changes need a full backup.</strong><br><small>Save the app's JSON restore file so the inspection database is protected.</small></div>
         <button id="backupInspectionChangesBtn" class="button button-backup button-small" type="button">Back Up Changes</button>`;
  }

  function renderTripOptions(state, selectedTripId) {
    const sortedTrips = [...state.trips].sort((a, b) => String(b.endISO || "").localeCompare(String(a.endISO || "")));
    return [
      `<option value="">Standalone inspection — no mileage trip</option>`,
      ...sortedTrips.map((trip) => {
        const label = [trip.date, trip.vendor, trip.projectNumber, formatMiles(trip.miles)].filter(Boolean).join(" • ");
        return `<option value="${escapeHTML(trip.id)}"${trip.id === selectedTripId ? " selected" : ""}>${escapeHTML(label)}</option>`;
      })
    ].join("");
  }

  function renderFollowUpEditors(followUps) {
    const list = $("followUpEditorList");
    if (!list) return;
    const items = followUps.length ? followUps : [];
    list.innerHTML = items.map((item) => `
      <div class="followup-editor" data-followup-id="${escapeHTML(item.id || makeId("followup"))}">
        <div class="followup-editor-grid">
          <label>Action item<input class="followup-action" value="${escapeHTML(item.action || "")}" placeholder="Required follow-up"></label>
          <label>Responsible party<input class="followup-owner" value="${escapeHTML(item.responsibleParty || "")}" placeholder="Vendor, client, inspector"></label>
          <label>Due date<input class="followup-due" type="date" value="${escapeHTML(item.dueDate || "")}"></label>
          <label>Status<select class="followup-status"><option${item.status !== "Closed" ? " selected" : ""}>Open</option><option${item.status === "Closed" ? " selected" : ""}>Closed</option></select></label>
          <button class="button button-danger-outline button-small remove-followup-btn" type="button">Remove</button>
        </div>
      </div>
    `).join("");
  }

  function openInspectionForm(inspection = null, tripId = "") {
    const state = readState();
    editingInspectionId = inspection?.id || null;
    currentTripId = tripId || inspection?.tripId || "";
    const trip = getTripById(state, currentTripId);
    const snapshot = inspection?.tripSnapshot || tripSnapshot(trip);
    const values = inspection || {};

    const date = values.date || (trip ? inputDateFromTrip(trip.date) : todayInputValue());
    const customer = values.customer ?? trip?.customer ?? "";
    const vendor = values.vendor ?? trip?.vendor ?? "";
    const projectNumber = values.projectNumber ?? trip?.projectNumber ?? "";
    const activity = values.activity ?? trip?.purpose ?? "";
    const startTime = values.startTime ?? trip?.startTime ?? "";
    const endTime = values.endTime ?? trip?.endTime ?? "";
    const hours = values.hoursOnSite ?? calculateHours(startTime, endTime);

    const panel = $("inspectionFormPanel");
    panel.innerHTML = `
      <div class="section-heading compact">
        <div>
          <p class="eyebrow">${editingInspectionId ? "Edit record" : "New record"}</p>
          <h3>${editingInspectionId ? "Update Inspection" : "Create Inspection"}</h3>
        </div>
        <button id="closeInspectionFormBtn" class="button button-quiet button-small" type="button">Close Form</button>
      </div>

      <form id="inspectionForm" autocomplete="off">
        <label>
          Related mileage trip
          <select id="inspectionTripId">${renderTripOptions(state, currentTripId)}</select>
          <small>Choose a trip to copy its mileage, GPS, customer, vendor, project, and times. Leave standalone for calls or document reviews.</small>
        </label>

        <div id="inspectionTripSummary" class="inspection-linked-trip"></div>

        <div class="inspection-form-grid">
          <label>Date<input id="inspectionDate" type="date" required value="${escapeHTML(date)}"></label>
          <label>Customer<input id="inspectionCustomer" list="customerList" required value="${escapeHTML(customer)}" placeholder="Example: Shell"></label>
          <label>Vendor / facility<input id="inspectionVendor" list="vendorList" required value="${escapeHTML(vendor)}" placeholder="Example: Repcon"></label>
          <label>Project number<input id="inspectionProject" list="inspectionProjectList" value="${escapeHTML(projectNumber)}" placeholder="Example: E10379-424"></label>
          <label>PO / vendor job number<input id="inspectionPoJob" value="${escapeHTML(values.purchaseOrderJob || "")}" placeholder="PO, requisition, or shop job"></label>
          <label>Equipment tag<input id="inspectionTag" value="${escapeHTML(values.equipmentTag || "")}" placeholder="Example: F-511"></label>
        </div>

        <datalist id="inspectionProjectList"></datalist>

        <div class="inspection-form-grid">
          <label>Inspection type<select id="inspectionType">${createOptionList(INSPECTION_TYPES, values.inspectionType || "Inspection")}</select></label>
          <label>Status<select id="inspectionStatus">${createOptionList(INSPECTION_STATUSES, values.status || "Complete")}</select></label>
          <label>Acceptance / release<select id="inspectionAcceptance">${createOptionList(ACCEPTANCE_STATUSES, values.acceptanceStatus || "Not Determined")}</select></label>
          <label class="full">Activity<input id="inspectionActivity" required value="${escapeHTML(activity)}" placeholder="Inspection activity performed"></label>
        </div>

        <div class="inspection-form-grid">
          <label>Start time<input id="inspectionStartTime" value="${escapeHTML(startTime)}" placeholder="7:30 AM"></label>
          <label>End time<input id="inspectionEndTime" value="${escapeHTML(endTime)}" placeholder="3:45 PM"></label>
          <label>Hours on site<input id="inspectionHours" inputmode="decimal" value="${escapeHTML(hours)}" placeholder="8.25"></label>
        </div>

        <label>Inspection summary<textarea id="inspectionSummary" rows="5" placeholder="Concise work-only summary">${escapeHTML(values.summary || "")}</textarea></label>
        <label>Observations<textarea id="inspectionObservations" rows="4" placeholder="Detailed observations and documents reviewed">${escapeHTML(values.observations || "")}</textarea></label>
        <label>Deficiencies / exceptions<textarea id="inspectionDeficiencies" rows="3" placeholder="Leave blank when none were identified">${escapeHTML(values.deficiencies || "")}</textarea></label>

        <div class="section-heading compact">
          <div><p class="eyebrow">Action tracking</p><h3>Follow-ups</h3></div>
          <button id="addFollowUpBtn" class="button button-secondary button-small" type="button">Add Follow-up</button>
        </div>
        <div id="followUpEditorList" class="followup-editor-list"></div>

        <div class="form-actions wrap">
          <button class="button inspection-button" type="submit">${editingInspectionId ? "Save Changes" : "Save Inspection"}</button>
          <button id="cancelInspectionFormBtn" class="button button-secondary" type="button">Cancel</button>
        </div>
      </form>
    `;
    panel.classList.remove("hidden");
    populateProjectDatalist(state);
    renderFollowUpEditors(Array.isArray(values.followUps) ? values.followUps : []);
    renderSelectedTripSummary(snapshot);
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeInspectionForm() {
    editingInspectionId = null;
    currentTripId = "";
    const panel = $("inspectionFormPanel");
    if (panel) {
      panel.classList.add("hidden");
      panel.innerHTML = "";
    }
  }

  function populateProjectDatalist(state) {
    const datalist = $("inspectionProjectList");
    if (!datalist) return;
    const projects = new Set();
    state.trips.forEach((trip) => { if (trip.projectNumber) projects.add(trip.projectNumber); });
    state.settings.inspections.forEach((inspection) => { if (inspection.projectNumber) projects.add(inspection.projectNumber); });
    datalist.innerHTML = [...projects].sort().map((project) => `<option value="${escapeHTML(project)}"></option>`).join("");
  }

  function renderSelectedTripSummary(snapshot) {
    const box = $("inspectionTripSummary");
    if (!box) return;
    if (!snapshot) {
      box.innerHTML = `<strong>Standalone record</strong><br><small>No mileage or GPS record is linked.</small>`;
      return;
    }
    const startMap = mapLink(snapshot.startLocation, "Trip Start");
    const endMap = mapLink(snapshot.endLocation, "Trip End");
    box.innerHTML = `
      <strong>Linked mileage: ${formatMiles(snapshot.miles)}</strong>
      ${snapshot.gpsRouteMiles ? ` • GPS ${formatMiles(snapshot.gpsRouteMiles)}` : ""}<br>
      <small>${escapeHTML(snapshot.date || "")} ${escapeHTML(snapshot.startTime || "")}–${escapeHTML(snapshot.endTime || "")}
      ${snapshot.staGenerated ? ` • STA ${escapeHTML(snapshot.staFileName || "generated")}` : ""}</small>
      ${(startMap || endMap) ? `<div class="map-links">${startMap ? `<a href="${startMap}" target="_blank" rel="noopener">Start map</a>` : ""}${endMap ? `<a href="${endMap}" target="_blank" rel="noopener">End map</a>` : ""}</div>` : ""}
    `;
  }

  function applyTripToOpenForm(tripId) {
    const state = readState();
    const trip = getTripById(state, tripId);
    currentTripId = tripId;
    if (!trip) {
      renderSelectedTripSummary(null);
      return;
    }
    $("inspectionDate").value = inputDateFromTrip(trip.date);
    $("inspectionCustomer").value = trip.customer || "";
    $("inspectionVendor").value = trip.vendor || "";
    $("inspectionProject").value = trip.projectNumber || "";
    $("inspectionActivity").value = trip.purpose || "Inspection";
    $("inspectionStartTime").value = trip.startTime || "";
    $("inspectionEndTime").value = trip.endTime || "";
    $("inspectionHours").value = calculateHours(trip.startTime, trip.endTime);
    renderSelectedTripSummary(tripSnapshot(trip));
  }

  function collectFollowUps() {
    return [...document.querySelectorAll("#followUpEditorList .followup-editor")]
      .map((row) => ({
        id: row.dataset.followupId || makeId("followup"),
        action: row.querySelector(".followup-action")?.value.trim() || "",
        responsibleParty: row.querySelector(".followup-owner")?.value.trim() || "",
        dueDate: row.querySelector(".followup-due")?.value || "",
        status: row.querySelector(".followup-status")?.value === "Closed" ? "Closed" : "Open"
      }))
      .filter((item) => item.action);
  }

  function saveInspectionFromForm() {
    const wasEditing = Boolean(editingInspectionId);
    const state = readState();
    const selectedTripId = $("inspectionTripId").value;
    const trip = getTripById(state, selectedTripId);
    const existing = editingInspectionId
      ? state.settings.inspections.find((inspection) => inspection.id === editingInspectionId)
      : null;
    const createdISO = existing?.createdISO || nowISO();

    const inspection = {
      id: existing?.id || makeId(),
      schemaVersion: INSPECTION_SCHEMA_VERSION,
      tripId: selectedTripId || null,
      tripSnapshot: trip ? tripSnapshot(trip) : (existing?.tripId === selectedTripId ? existing.tripSnapshot : null),
      date: $("inspectionDate").value,
      customer: $("inspectionCustomer").value.trim(),
      vendor: $("inspectionVendor").value.trim(),
      projectNumber: $("inspectionProject").value.trim(),
      purchaseOrderJob: $("inspectionPoJob").value.trim(),
      equipmentTag: $("inspectionTag").value.trim(),
      inspectionType: $("inspectionType").value,
      activity: $("inspectionActivity").value.trim(),
      status: $("inspectionStatus").value,
      acceptanceStatus: $("inspectionAcceptance").value,
      startTime: $("inspectionStartTime").value.trim(),
      endTime: $("inspectionEndTime").value.trim(),
      hoursOnSite: $("inspectionHours").value.trim(),
      summary: $("inspectionSummary").value.trim(),
      observations: $("inspectionObservations").value.trim(),
      deficiencies: $("inspectionDeficiencies").value.trim(),
      followUps: collectFollowUps(),
      createdISO,
      modifiedISO: nowISO()
    };

    if (!inspection.date || !inspection.customer || !inspection.vendor || !inspection.activity) {
      window.alert("Date, customer, vendor/facility, and activity are required.");
      return;
    }

    updateState((nextState) => {
      const inspections = nextState.settings.inspections;
      const index = inspections.findIndex((item) => item.id === inspection.id);
      if (index >= 0) inspections[index] = inspection;
      else inspections.push(inspection);

      nextState.settings.customers = Array.isArray(nextState.settings.customers) ? nextState.settings.customers : [];
      nextState.settings.vendors = Array.isArray(nextState.settings.vendors) ? nextState.settings.vendors : [];
      if (!nextState.settings.customers.includes(inspection.customer)) nextState.settings.customers.push(inspection.customer);
      if (!nextState.settings.vendors.includes(inspection.vendor)) nextState.settings.vendors.push(inspection.vendor);
    });

    closeInspectionForm();
    showInspectionToast(wasEditing ? "Inspection updated." : "Inspection saved.");
  }

  function renderInspectionList(state) {
    const container = $("inspectionList");
    if (!container) return;
    const query = $("inspectionSearch")?.value.trim().toLowerCase() || "";
    const inspections = [...state.settings.inspections]
      .filter((inspection) => !query || inspectionSearchText(inspection).includes(query))
      .sort((a, b) => `${b.date || ""}|${b.modifiedISO || ""}`.localeCompare(`${a.date || ""}|${a.modifiedISO || ""}`));

    if (activeView === "followups") {
      renderOpenFollowUps(inspections, container);
      return;
    }

    if (!inspections.length) {
      container.innerHTML = `<div class="inspection-empty">No inspection records match the current search.</div>`;
      return;
    }

    container.innerHTML = inspections.map((inspection) => {
      const followUps = Array.isArray(inspection.followUps) ? inspection.followUps : [];
      const openCount = followUps.filter((item) => item.status !== "Closed").length;
      const snapshot = inspection.tripSnapshot;
      const statusClass = ["Complete", "Released"].includes(inspection.status)
        ? "inspection-pill-complete"
        : "inspection-pill-open";
      return `
        <article class="inspection-record" data-inspection-id="${escapeHTML(inspection.id)}">
          <div class="inspection-record-heading">
            <div>
              <p class="eyebrow">${escapeHTML(displayDate(inspection.date))} • ${escapeHTML(inspection.inspectionType || "Inspection")}</p>
              <h3>${escapeHTML(inspection.vendor || "Facility")}${inspection.projectNumber ? ` — ${escapeHTML(inspection.projectNumber)}` : ""}</h3>
              <p class="muted">${escapeHTML(inspection.customer || "")}${inspection.equipmentTag ? ` • ${escapeHTML(inspection.equipmentTag)}` : ""}${inspection.purchaseOrderJob ? ` • ${escapeHTML(inspection.purchaseOrderJob)}` : ""}</p>
            </div>
            <span class="pill ${statusClass}">${escapeHTML(inspection.status || "Pending")}</span>
          </div>

          <div class="inspection-meta">
            <span><strong>Activity:</strong> ${escapeHTML(inspection.activity || "—")}</span>
            <span><strong>Acceptance:</strong> ${escapeHTML(inspection.acceptanceStatus || "Not Determined")}</span>
            <span><strong>Hours:</strong> ${escapeHTML(inspection.hoursOnSite || "—")}</span>
            <span><strong>Mileage:</strong> ${snapshot ? formatMiles(snapshot.miles) : "Standalone"}</span>
            <span><strong>Open actions:</strong> ${openCount}</span>
          </div>

          ${inspection.summary ? `<div class="inspection-summary"><strong>Summary</strong><br>${escapeHTML(inspection.summary)}</div>` : ""}
          ${inspection.deficiencies ? `<div class="inspection-summary"><strong>Deficiencies / exceptions</strong><br>${escapeHTML(inspection.deficiencies)}</div>` : ""}

          ${followUps.length ? `<div class="inspection-followups">${followUps.map((item) => `
            <div class="inspection-followup ${item.status === "Closed" ? "closed" : ""}">
              <strong>${escapeHTML(item.action)}</strong><br>
              <small>${escapeHTML(item.responsibleParty || "Unassigned")}${item.dueDate ? ` • due ${escapeHTML(displayDate(item.dueDate))}` : ""} • ${escapeHTML(item.status || "Open")}</small>
            </div>
          `).join("")}</div>` : ""}

          <div class="inspection-record-actions">
            <button class="button button-secondary button-small" type="button" data-edit-inspection="${escapeHTML(inspection.id)}">Edit</button>
            ${snapshot?.startLocation ? `<a class="button button-secondary button-small" href="${mapLink(snapshot.startLocation, "Trip Start")}" target="_blank" rel="noopener">Start Map</a>` : ""}
            ${snapshot?.endLocation ? `<a class="button button-secondary button-small" href="${mapLink(snapshot.endLocation, "Trip End")}" target="_blank" rel="noopener">End Map</a>` : ""}
            <button class="button button-danger-outline button-small" type="button" data-delete-inspection="${escapeHTML(inspection.id)}">Delete</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderOpenFollowUps(inspections, container) {
    const rows = inspections.flatMap((inspection) => (
      (inspection.followUps || [])
        .filter((item) => item.status !== "Closed")
        .map((item) => ({ inspection, item }))
    )).sort((a, b) => String(a.item.dueDate || "9999-12-31").localeCompare(String(b.item.dueDate || "9999-12-31")));

    if (!rows.length) {
      container.innerHTML = `<div class="inspection-empty">No open follow-up actions match the current search.</div>`;
      return;
    }

    container.innerHTML = rows.map(({ inspection, item }) => `
      <article class="inspection-record">
        <div class="inspection-record-heading">
          <div>
            <p class="eyebrow">Open follow-up${item.dueDate ? ` • due ${escapeHTML(displayDate(item.dueDate))}` : ""}</p>
            <h3>${escapeHTML(item.action)}</h3>
            <p class="muted">${escapeHTML(inspection.vendor || "Facility")}${inspection.projectNumber ? ` • ${escapeHTML(inspection.projectNumber)}` : ""} • ${escapeHTML(displayDate(inspection.date))}</p>
          </div>
          <span class="pill inspection-pill-open">OPEN</span>
        </div>
        <div class="inspection-meta">
          <span><strong>Responsible:</strong> ${escapeHTML(item.responsibleParty || "Unassigned")}</span>
          <span><strong>Inspection:</strong> ${escapeHTML(inspection.inspectionType || "Inspection")}</span>
        </div>
        <div class="inspection-record-actions">
          <button class="button button-secondary button-small" type="button" data-edit-inspection="${escapeHTML(inspection.id)}">Open Inspection</button>
          <button class="button inspection-button button-small" type="button" data-close-followup="${escapeHTML(inspection.id)}|${escapeHTML(item.id)}">Mark Closed</button>
        </div>
      </article>
    `).join("");
  }

  function exportInspectionCSV() {
    const state = readState();
    const inspections = [...state.settings.inspections].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    if (!inspections.length) {
      window.alert("There are no inspection records to export.");
      return;
    }

    const header = [
      "Date", "Customer", "Vendor / Facility", "Project Number", "PO / Vendor Job", "Equipment Tag",
      "Inspection Type", "Activity", "Status", "Acceptance / Release", "Start Time", "End Time",
      "Hours On Site", "Linked Trip", "Odometer Miles", "GPS Miles", "STA Generated", "STA Filename",
      "Summary", "Observations", "Deficiencies / Exceptions", "Open Follow-ups", "Closed Follow-ups",
      "Created", "Modified"
    ];

    const rows = inspections.map((inspection) => {
      const followUps = inspection.followUps || [];
      const open = followUps.filter((item) => item.status !== "Closed").map((item) => (
        `${item.action}${item.responsibleParty ? ` [${item.responsibleParty}]` : ""}${item.dueDate ? ` due ${item.dueDate}` : ""}`
      )).join(" | ");
      const closed = followUps.filter((item) => item.status === "Closed").map((item) => item.action).join(" | ");
      const snapshot = inspection.tripSnapshot || {};
      return [
        displayDate(inspection.date), inspection.customer, inspection.vendor, inspection.projectNumber,
        inspection.purchaseOrderJob, inspection.equipmentTag, inspection.inspectionType, inspection.activity,
        inspection.status, inspection.acceptanceStatus, inspection.startTime, inspection.endTime,
        inspection.hoursOnSite, inspection.tripId ? "Yes" : "No", snapshot.miles ?? "",
        snapshot.gpsRouteMiles ?? "", snapshot.staGenerated ? "Yes" : "No", snapshot.staFileName || "",
        inspection.summary, inspection.observations, inspection.deficiencies, open, closed,
        formatDateTime(inspection.createdISO), formatDateTime(inspection.modifiedISO)
      ];
    });

    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `inspection-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showInspectionToast("Inspection CSV created.");
  }

  function showInspectionToast(message) {
    const toast = $("toast");
    if (toast) {
      toast.textContent = message;
      toast.classList.remove("hidden");
      clearTimeout(showInspectionToast.timer);
      showInspectionToast.timer = setTimeout(() => toast.classList.add("hidden"), 3400);
      return;
    }
    console.info(message);
  }

  function setActiveView(view) {
    activeView = view;
    $("inspectionListViewBtn")?.classList.toggle("active-view", view === "inspections");
    $("followUpViewBtn")?.classList.toggle("active-view", view === "followups");
    renderInspectionList(readState());
  }

  function refreshFromState(force = false) {
    if (!$('inspectionSection')) return;
    const state = readState();
    const signature = JSON.stringify({
      trips: state.trips.map((trip) => [trip.id, trip.endISO, trip.miles]),
      inspections: state.settings.inspections.map((inspection) => [inspection.id, inspection.modifiedISO]),
      ignored: state.settings.inspectionIgnoredTripIds,
      backup: [state.backup?.pendingTripCount, state.backup?.lastConfirmedISO]
    });
    if (!force && signature === lastStateSignature) return;
    lastStateSignature = signature;
    renderPrompt(state);
    renderDashboard(state);
    renderInspectionList(state);
  }

  function bindEvents() {
    $("inspectionBtn")?.addEventListener("click", () => showInspectionSection(false));
    $("inspectionNavBtn")?.addEventListener("click", () => showInspectionSection(false));
    $("closeInspectionSection")?.addEventListener("click", hideInspectionSection);
    $("newInspectionBtn")?.addEventListener("click", () => openInspectionForm());
    $("inspectionListViewBtn")?.addEventListener("click", () => setActiveView("inspections"));
    $("followUpViewBtn")?.addEventListener("click", () => setActiveView("followups"));
    $("exportInspectionsBtn")?.addEventListener("click", exportInspectionCSV);
    $("inspectionSearch")?.addEventListener("input", () => renderInspectionList(readState()));
    $("clearInspectionSearch")?.addEventListener("click", () => {
      $("inspectionSearch").value = "";
      renderInspectionList(readState());
    });

    document.addEventListener("click", (event) => {
      const createTripButton = event.target.closest("[data-create-inspection-trip]");
      if (createTripButton) {
        showInspectionSection(true, createTripButton.dataset.createInspectionTrip);
        return;
      }

      const ignoreTripButton = event.target.closest("[data-ignore-inspection-trip]");
      if (ignoreTripButton) {
        const tripId = ignoreTripButton.dataset.ignoreInspectionTrip;
        updateState((state) => {
          if (!state.settings.inspectionIgnoredTripIds.includes(tripId)) {
            state.settings.inspectionIgnoredTripIds.push(tripId);
          }
        });
        showInspectionToast("Trip marked as not requiring an inspection record.");
        return;
      }

      if (event.target.closest("#backupInspectionChangesBtn")) {
        const backupButton = $("backupNowBtn") || $("backupBtn");
        if (backupButton) backupButton.click();
        else window.alert("Open the Mileage Logger page and use Save Full Backup to protect the inspection changes.");
        return;
      }

      if (event.target.closest("#closeInspectionFormBtn") || event.target.closest("#cancelInspectionFormBtn")) {
        closeInspectionForm();
        return;
      }

      if (event.target.closest("#addFollowUpBtn")) {
        const current = [...document.querySelectorAll("#followUpEditorList .followup-editor")].map((row) => ({
          id: row.dataset.followupId,
          action: row.querySelector(".followup-action")?.value || "",
          responsibleParty: row.querySelector(".followup-owner")?.value || "",
          dueDate: row.querySelector(".followup-due")?.value || "",
          status: row.querySelector(".followup-status")?.value || "Open"
        }));
        current.push({ id: makeId("followup"), action: "", responsibleParty: "", dueDate: "", status: "Open" });
        renderFollowUpEditors(current);
        return;
      }

      const removeFollowUp = event.target.closest(".remove-followup-btn");
      if (removeFollowUp) {
        removeFollowUp.closest(".followup-editor")?.remove();
        return;
      }

      const editButton = event.target.closest("[data-edit-inspection]");
      if (editButton) {
        const state = readState();
        const inspection = state.settings.inspections.find((item) => item.id === editButton.dataset.editInspection);
        if (inspection) {
          showInspectionSection(false);
          openInspectionForm(inspection);
        }
        return;
      }

      const deleteButton = event.target.closest("[data-delete-inspection]");
      if (deleteButton) {
        const state = readState();
        const inspection = state.settings.inspections.find((item) => item.id === deleteButton.dataset.deleteInspection);
        if (!inspection) return;
        if (!window.confirm(`Delete the ${displayDate(inspection.date)} inspection at ${inspection.vendor}? This cannot be undone.`)) return;
        updateState((nextState) => {
          nextState.settings.inspections = nextState.settings.inspections.filter((item) => item.id !== inspection.id);
        });
        closeInspectionForm();
        showInspectionToast("Inspection deleted.");
        return;
      }

      const closeFollowUpButton = event.target.closest("[data-close-followup]");
      if (closeFollowUpButton) {
        const [inspectionId, followUpId] = closeFollowUpButton.dataset.closeFollowup.split("|");
        updateState((state) => {
          const inspection = state.settings.inspections.find((item) => item.id === inspectionId);
          const followUp = inspection?.followUps?.find((item) => item.id === followUpId);
          if (followUp) {
            followUp.status = "Closed";
            inspection.modifiedISO = nowISO();
          }
        });
        showInspectionToast("Follow-up marked closed.");
        return;
      }

      const mainAppControl = event.target.closest("#startBtn, #endBtn, #staBtn, #logBtn, [data-show]");
      if (mainAppControl && !event.target.closest("#inspectionSection")) {
        $("inspectionSection")?.classList.add("hidden");
      }
    });

    document.addEventListener("change", (event) => {
      if (event.target.id === "inspectionTripId") {
        applyTripToOpenForm(event.target.value);
      }
      if (event.target.id === "inspectionStartTime" || event.target.id === "inspectionEndTime") {
        const calculated = calculateHours($("inspectionStartTime")?.value, $("inspectionEndTime")?.value);
        if (calculated && $("inspectionHours")) $("inspectionHours").value = calculated;
      }
    });

    document.addEventListener("submit", (event) => {
      if (event.target.id !== "inspectionForm") return;
      event.preventDefault();
      saveInspectionFromForm();
    });

    window.addEventListener("storage", () => refreshFromState(true));
  }

  function initialize() {
    injectInterface();
    bindEvents();
    refreshFromState(true);

    const action = new URLSearchParams(window.location.search).get("action");
    if (action === "inspection" || action === "inspections") {
      setTimeout(() => showInspectionSection(false), 80);
    }

    window.setInterval(() => refreshFromState(false), REFRESH_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();



