(() => {
  "use strict";

  const STATE_KEY = "mileage_logger_state_v3";
  const INSPECTION_SCHEMA_VERSION = 2;
  const REFRESH_INTERVAL_MS = 1200;
  const PRIVATE_FILE_DB_NAME = "MileageLoggerPrivateFiles";
  const PRIVATE_FILE_DB_VERSION = 1;
  const PRIVATE_FILE_DB_STORE = "privateFiles";
  const INSPECTION_REPORT_TEMPLATE_KEY = "inspectionReportTemplate";
  const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const XML_NS = "http://www.w3.org/XML/1998/namespace";
  const nativeSetItem = window.localStorage.setItem.bind(window.localStorage);
  const $ = (id) => document.getElementById(id);

  let editingInspectionId = null;
  let editingInspectionWasExisting = false;
  let currentTripId = "";
  let currentPhotos = [];
  let originalPhotoIds = new Set();
  let photoObjectUrls = [];
  let inspectionListObjectUrls = [];
  let activeView = "inspections";
  let lastStateSignature = "";
  let inspectionTemplateInstalled = false;

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

  function openInspectionPrivateFileDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("This browser does not support private local file storage."));
        return;
      }
      const request = indexedDB.open(PRIVATE_FILE_DB_NAME, PRIVATE_FILE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PRIVATE_FILE_DB_STORE)) {
          database.createObjectStore(PRIVATE_FILE_DB_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error || new Error("The private file database could not be opened.")
      );
    });
  }

  async function readInspectionReportTemplateRecord() {
    const database = await openInspectionPrivateFileDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(PRIVATE_FILE_DB_STORE, "readonly");
      const request = transaction.objectStore(PRIVATE_FILE_DB_STORE).get(INSPECTION_REPORT_TEMPLATE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(
        request.error || new Error("The private S&B report template could not be read.")
      );
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("The private template transaction failed."));
      };
    });
  }

  async function writeInspectionReportTemplateRecord(record) {
    const database = await openInspectionPrivateFileDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(PRIVATE_FILE_DB_STORE, "readwrite");
      transaction.objectStore(PRIVATE_FILE_DB_STORE).put(record);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("The private S&B report template could not be saved."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Saving the private S&B report template was canceled."));
      };
    });
  }

  async function deleteInspectionReportTemplateRecord() {
    const database = await openInspectionPrivateFileDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(PRIVATE_FILE_DB_STORE, "readwrite");
      transaction.objectStore(PRIVATE_FILE_DB_STORE).delete(INSPECTION_REPORT_TEMPLATE_KEY);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("The private S&B report template could not be removed."));
      };
    });
  }

  function privateFileSize(bytes) {
    const size = Number(bytes || 0);
    if (size < 1024) return `${size} bytes`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function validateInspectionReportTemplateBytes(bytes) {
    if (!window.fflate) throw new Error("The Word document component is unavailable.");
    let files;
    try {
      files = window.fflate.unzipSync(bytes);
    } catch (error) {
      throw new Error("This file is not a readable Word .docx document.");
    }
    const requiredParts = [
      "word/document.xml",
      "word/header1.xml",
      "word/footer1.xml",
      "word/_rels/document.xml.rels",
      "[Content_Types].xml"
    ];
    const missing = requiredParts.filter((path) => !files[path]);
    if (missing.length) {
      throw new Error(`This Word file is missing required template parts: ${missing.join(", ")}.`);
    }
    const documentXml = parseWordXml(files["word/document.xml"], "word/document.xml");
    const headerXml = parseWordXml(files["word/header1.xml"], "word/header1.xml");
    const documentText = wordNodeText(documentXml);
    const headerText = wordNodeText(headerXml);
    const requiredDocumentLabels = ["VENDOR:", "ACTION ITEMS:", "ATTACHMENTS:", "Figure 1"];
    const requiredHeaderLabels = ["SOURCE INSPECTION REPORT", "CLIENT PROJECT NUMBER:", "DATE OF REPORT:"];
    const missingLabels = [
      ...requiredDocumentLabels.filter((label) => !documentText.includes(label)),
      ...requiredHeaderLabels.filter((label) => !headerText.includes(label))
    ];
    if (missingLabels.length) {
      throw new Error(`This does not appear to be the approved S&B blank inspection report. Missing: ${missingLabels.join(", ")}.`);
    }
  }

  async function importInspectionReportTemplate(file) {
    if (!file || !String(file.name || "").toLowerCase().endsWith(".docx")) {
      throw new Error("Choose the approved blank S&B inspection report in Word .docx format.");
    }
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    validateInspectionReportTemplateBytes(bytes);
    await writeInspectionReportTemplateRecord({
      id: INSPECTION_REPORT_TEMPLATE_KEY,
      name: file.name,
      type: file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: file.size || bytes.byteLength,
      importedISO: nowISO(),
      bytes: arrayBuffer
    });
  }

  async function refreshInspectionReportTemplateStatus() {
    const status = $("inspectionTemplateStatus");
    const pill = $("inspectionTemplatePill");
    const importButton = $("importInspectionTemplateBtn");
    const removeButton = $("removeInspectionTemplateBtn");
    if (!status || !pill || !importButton || !removeButton) return false;
    try {
      const record = await readInspectionReportTemplateRecord();
      inspectionTemplateInstalled = Boolean(record?.bytes);
      if (!inspectionTemplateInstalled) {
        status.textContent = "No private S&B Word template is installed. Exports will use the standard editable report.";
        status.className = "private-master-status warning";
        pill.textContent = "NOT INSTALLED";
        pill.className = "pill active";
        importButton.textContent = "Import S&B Word Template";
        removeButton.disabled = true;
        return false;
      }
      const imported = record.importedISO ? new Date(record.importedISO).toLocaleString() : "date unavailable";
      status.innerHTML = `<strong>${escapeHTML(record.name || "S&B inspection report template")}</strong><br>Stored privately on this device • ${escapeHTML(privateFileSize(record.size))} • imported ${escapeHTML(imported)}`;
      status.className = "private-master-status installed";
      pill.textContent = "INSTALLED";
      pill.className = "pill ready";
      importButton.textContent = "Replace S&B Word Template";
      removeButton.disabled = false;
      return true;
    } catch (error) {
      inspectionTemplateInstalled = false;
      status.textContent = `Private template storage error: ${error.message}`;
      status.className = "private-master-status error";
      pill.textContent = "ERROR";
      pill.className = "pill active";
      removeButton.disabled = true;
      return false;
    }
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
    state.backup = state.backup && typeof state.backup === "object" ? state.backup : {};
    state.backup.pendingChangeCount = Math.max(0, Number(state.backup.pendingChangeCount || 0)) + 1;
    state.backup.lastRequiredISO = state.settings.inspectionLastChangedISO;
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
      .inspection-template-panel { margin: 12px 0 15px; padding: 13px; border: 1px solid var(--line); border-radius: 13px; background: color-mix(in srgb, var(--card), var(--bg) 28%); }
      .inspection-template-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
      .inspection-template-heading h3 { margin: 1px 0 0; }
      .inspection-form-panel { margin: 13px 0 16px; padding: 14px; border: 2px solid var(--info); border-radius: 14px; background: color-mix(in srgb, var(--info), transparent 96%); }
      .inspection-form-open #inspectionDashboard,
      .inspection-form-open #inspectionBackupNotice,
      .inspection-form-open .inspection-template-panel,
      .inspection-form-open .inspection-toolbar,
      .inspection-form-open .log-toolbar,
      .inspection-form-open #inspectionList { display: none; }
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
      .inspection-photo-list { display: grid; gap: 11px; margin: 11px 0 16px; }
      .inspection-photo-card { display: grid; grid-template-columns: minmax(110px, 160px) 1fr; gap: 11px; padding: 11px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
      .inspection-photo-preview, .inspection-photo-thumbnails button { padding: 0; overflow: hidden; border: 0; border-radius: 10px; background: color-mix(in srgb, var(--card), var(--bg) 40%); cursor: pointer; }
      .inspection-photo-preview { min-height: 120px; }
      .inspection-photo-preview img, .inspection-photo-thumbnails img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .inspection-photo-loading { display: grid; min-height: 120px; place-items: center; padding: 8px; color: var(--muted); }
      .inspection-photo-details { display: grid; align-content: start; gap: 7px; }
      .inspection-photo-details small { color: var(--muted); }
      .inspection-photo-thumbnails { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
      .inspection-photo-thumbnails button { width: 78px; height: 78px; }
      .inspection-photo-thumbnails button span { display: grid; height: 100%; place-items: center; color: var(--muted); }
      .inspection-photo-more { display: grid; min-width: 78px; min-height: 78px; place-items: center; color: var(--muted); font-weight: 700; }
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
        .inspection-photo-card { grid-template-columns: 1fr; }
        .inspection-photo-preview { min-height: 180px; }
        .inspection-record-heading, .inspection-backup-notice, .inspection-template-heading { flex-direction: column; }
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

        <section class="inspection-template-panel" aria-labelledby="inspectionTemplateTitle">
          <div class="inspection-template-heading">
            <div>
              <p class="eyebrow">Stored only on this device</p>
              <h3 id="inspectionTemplateTitle">Private S&B Word Report Template</h3>
            </div>
            <span id="inspectionTemplatePill" class="pill">CHECKING</span>
          </div>
          <div id="inspectionTemplateStatus" class="private-master-status">
            Checking this device for an imported S&B Word template…
          </div>
          <div class="form-actions wrap">
            <button id="importInspectionTemplateBtn" class="button inspection-button button-small" type="button">Import S&B Word Template</button>
            <button id="removeInspectionTemplateBtn" class="button button-danger-outline button-small" type="button" disabled>Remove Private Template</button>
            <input id="inspectionTemplateFileInput" class="hidden" type="file" accept="application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx">
          </div>
          <p class="privacy-note compact-note">
            The S&B template is not uploaded to GitHub or included in backups. When installed, Export Package uses it for the editable Word report.
          </p>
        </section>

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
    refreshInspectionReportTemplateStatus();
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
      : `<div><strong>Inspection changes need a full backup.</strong><br><small>Save the app's ZIP restore file so the inspection database and photos are protected.</small></div>
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

  function collectPhotoMetadata() {
    const captions = new Map(
      [...document.querySelectorAll("#inspectionPhotoList [data-photo-caption]")].map((input) => [
        input.dataset.photoCaption,
        input.value.trim()
      ])
    );
    return currentPhotos.map((photo) => ({
      ...photo,
      caption: captions.get(photo.id) ?? photo.caption ?? ""
    }));
  }

  async function renderPhotoEditors() {
    const list = $("inspectionPhotoList");
    const count = $("inspectionPhotoCount");
    if (!list || !count) return;
    photoObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    photoObjectUrls = [];
    count.textContent = String(currentPhotos.length);

    if (!currentPhotos.length) {
      list.innerHTML = `<div class="inspection-empty compact">No photos attached.</div>`;
      return;
    }

    list.innerHTML = currentPhotos.map((photo) => `
      <article class="inspection-photo-card">
        <button class="inspection-photo-preview" type="button" data-view-photo="${escapeHTML(photo.id)}" aria-label="Open photo">
          <span class="inspection-photo-loading">Loading photo…</span>
        </button>
        <div class="inspection-photo-details">
          <strong>${escapeHTML(photo.name || "Inspection photo")}</strong>
          <small>${Number(photo.size || 0) > 0 ? `${Math.max(1, Math.round(Number(photo.size) / 1024))} KB` : ""}</small>
          <label>Caption<input data-photo-caption="${escapeHTML(photo.id)}" value="${escapeHTML(photo.caption || "")}" placeholder="What does this photo show?"></label>
          <button class="button button-danger-outline button-small" type="button" data-remove-photo="${escapeHTML(photo.id)}">Remove Photo</button>
        </div>
      </article>
    `).join("");

    if (!window.MileageMediaStore) return;
    await Promise.all(currentPhotos.map(async (photo) => {
      try {
        const stored = await window.MileageMediaStore.getPhoto(photo.id);
        const target = list.querySelector(`[data-view-photo="${CSS.escape(photo.id)}"]`);
        if (!stored?.blob || !target) return;
        const url = URL.createObjectURL(stored.blob);
        photoObjectUrls.push(url);
        target.dataset.photoUrl = url;
        target.innerHTML = `<img src="${url}" alt="${escapeHTML(photo.caption || photo.name || "Inspection photo")}">`;
      } catch (error) {
        console.warn("Could not load inspection photo:", error);
      }
    }));
  }

  async function addInspectionPhotos(files) {
    const status = $("inspectionPhotoStatus");
    if (!editingInspectionId || !window.MileageMediaStore) {
      window.alert("Private photo storage is unavailable.");
      return;
    }

    const images = [...(files || [])].filter((file) => String(file.type || "").startsWith("image/"));
    if (!images.length) return;
    status.textContent = `Preparing ${images.length} photo${images.length === 1 ? "" : "s"}…`;
    status.className = "gps-status";

    try {
      for (let index = 0; index < images.length; index += 1) {
        status.textContent = `Preparing photo ${index + 1} of ${images.length}…`;
        const metadata = await window.MileageMediaStore.addPhoto(editingInspectionId, images[index]);
        currentPhotos.push(metadata);
      }
      status.textContent = `${images.length} photo${images.length === 1 ? "" : "s"} added. Save the inspection to keep the attachment.`;
      status.className = "gps-status good";
      await renderPhotoEditors();
    } catch (error) {
      status.textContent = `A photo could not be added: ${error.message}`;
      status.className = "gps-status bad";
      window.alert(`The photo could not be added.\n\n${error.message}`);
    }
  }

  async function recoverLinkedTripPhotos(trip) {
    if (!trip?.id || !window.MileageMediaStore?.getPhotosByOwner) return;
    try {
      const stored = await window.MileageMediaStore.getPhotosByOwner(trip.id);
      const knownIds = new Set(currentPhotos.map((photo) => photo.id));
      const recovered = stored
        .filter((photo) => !knownIds.has(photo.id))
        .map((photo) => ({
          id: photo.id,
          name: photo.name || "Trip photo",
          type: photo.type || "image/jpeg",
          size: Number(photo.size || 0),
          width: Number(photo.width || 0),
          height: Number(photo.height || 0),
          createdISO: photo.createdISO || "",
          caption: photo.caption || "",
          sourceTripId: trip.id
        }));
      if (!recovered.length || currentTripId !== trip.id) return;
      currentPhotos.push(...recovered);
      recovered.forEach((photo) => originalPhotoIds.add(photo.id));
      await renderPhotoEditors();
      const status = $("inspectionPhotoStatus");
      if (status) {
        status.textContent = `${currentPhotos.length} trip photo${currentPhotos.length === 1 ? "" : "s"} attached to this inspection record.`;
        status.className = "gps-status good";
      }
    } catch (error) {
      console.warn("Could not recover linked trip photos:", error);
    }
  }

  function openInspectionForm(inspection = null, tripId = "") {
    const state = readState();
    editingInspectionWasExisting = Boolean(inspection);
    editingInspectionId = inspection?.id || makeId();
    currentTripId = tripId || inspection?.tripId || "";
    const trip = getTripById(state, currentTripId);
    const inspectionPhotos = Array.isArray(inspection?.photos)
      ? inspection.photos.map((photo) => ({ ...photo }))
      : [];
    const photoIds = new Set(inspectionPhotos.map((photo) => photo.id));
    const inheritedTripPhotos = Array.isArray(trip?.photos)
      ? trip.photos
        .filter((photo) => !photoIds.has(photo.id))
        .map((photo) => ({ ...photo, sourceTripId: trip.id }))
      : [];
    currentPhotos = [...inspectionPhotos, ...inheritedTripPhotos];
    originalPhotoIds = new Set(currentPhotos.map((photo) => photo.id));
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
          <p class="eyebrow">${editingInspectionWasExisting ? "Edit record" : "New record"}</p>
          <h3>${editingInspectionWasExisting ? "Update Inspection" : "Create Inspection"}</h3>
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
          <div>
            <p class="eyebrow">Stored privately on this device</p>
            <h3>Inspection Photos</h3>
          </div>
          <span id="inspectionPhotoCount" class="pill">0</span>
        </div>
        <p class="muted">Photos are reduced to a practical size and included in the required ZIP backup.</p>
        <div class="form-actions wrap">
          <button id="takeInspectionPhotoBtn" class="button inspection-button button-small" type="button">Take Photo</button>
          <button id="chooseInspectionPhotosBtn" class="button button-secondary button-small" type="button">Choose Photos</button>
          <input id="takeInspectionPhotoInput" class="hidden" type="file" accept="image/*" capture="environment">
          <input id="chooseInspectionPhotosInput" class="hidden" type="file" accept="image/*" multiple>
        </div>
        <div id="inspectionPhotoStatus" class="gps-status">Ready to add photos.</div>
        <div id="inspectionPhotoList" class="inspection-photo-list"></div>

        <div class="section-heading compact">
          <div><p class="eyebrow">Action tracking</p><h3>Follow-ups</h3></div>
          <button id="addFollowUpBtn" class="button button-secondary button-small" type="button">Add Follow-up</button>
        </div>
        <div id="followUpEditorList" class="followup-editor-list"></div>

        <div class="form-actions wrap">
          <button class="button inspection-button" type="submit">${editingInspectionWasExisting ? "Save Changes" : "Save Inspection"}</button>
          <button id="cancelInspectionFormBtn" class="button button-secondary" type="button">Cancel</button>
        </div>
      </form>
    `;
    panel.classList.remove("hidden");
    $("inspectionSection")?.classList.add("inspection-form-open");
    populateProjectDatalist(state);
    renderFollowUpEditors(Array.isArray(values.followUps) ? values.followUps : []);
    renderPhotoEditors();
    recoverLinkedTripPhotos(trip);
    renderSelectedTripSummary(snapshot);
    panel.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function closeInspectionForm(options = {}) {
    const saved = Boolean(options.saved);
    const abandonedInspectionId = !editingInspectionWasExisting && !saved ? editingInspectionId : "";
    const unsavedAddedPhotoIds = editingInspectionWasExisting && !saved
      ? currentPhotos.filter((photo) => !originalPhotoIds.has(photo.id)).map((photo) => photo.id)
      : [];
    photoObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    photoObjectUrls = [];
    if (abandonedInspectionId && window.MileageMediaStore) {
      window.MileageMediaStore.deleteInspectionPhotos(abandonedInspectionId).catch((error) => {
        console.warn("Could not remove abandoned inspection photos:", error);
      });
    }
    unsavedAddedPhotoIds.forEach((photoId) => {
      window.MileageMediaStore?.deletePhoto(photoId).catch((error) => {
        console.warn("Could not remove an unsaved photo:", error);
      });
    });
    editingInspectionId = null;
    editingInspectionWasExisting = false;
    currentTripId = "";
    currentPhotos = [];
    originalPhotoIds = new Set();
    const panel = $("inspectionFormPanel");
    $("inspectionSection")?.classList.remove("inspection-form-open");
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
    const wasEditing = editingInspectionWasExisting;
    const state = readState();
    const selectedTripId = $("inspectionTripId").value;
    const trip = getTripById(state, selectedTripId);
    const existing = editingInspectionWasExisting
      ? state.settings.inspections.find((inspection) => inspection.id === editingInspectionId)
      : null;
    const createdISO = existing?.createdISO || nowISO();

    const inspection = {
      id: existing?.id || editingInspectionId || makeId(),
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
      photos: collectPhotoMetadata(),
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

    closeInspectionForm({ saved: true });
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
      const photos = Array.isArray(inspection.photos) ? inspection.photos : [];
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
            <span><strong>Photos:</strong> ${photos.length}</span>
          </div>

          ${inspection.summary ? `<div class="inspection-summary"><strong>Summary</strong><br>${escapeHTML(inspection.summary)}</div>` : ""}
          ${inspection.deficiencies ? `<div class="inspection-summary"><strong>Deficiencies / exceptions</strong><br>${escapeHTML(inspection.deficiencies)}</div>` : ""}
          ${photos.length ? `<div class="inspection-photo-thumbnails">${photos.slice(0, 4).map((photo) => `
            <button type="button" data-view-photo="${escapeHTML(photo.id)}" aria-label="Open ${escapeHTML(photo.caption || photo.name || "inspection photo")}">
              <span>Photo</span>
            </button>
          `).join("")}${photos.length > 4 ? `<span class="inspection-photo-more">+${photos.length - 4} more</span>` : ""}</div>` : ""}

          ${followUps.length ? `<div class="inspection-followups">${followUps.map((item) => `
            <div class="inspection-followup ${item.status === "Closed" ? "closed" : ""}">
              <strong>${escapeHTML(item.action)}</strong><br>
              <small>${escapeHTML(item.responsibleParty || "Unassigned")}${item.dueDate ? ` • due ${escapeHTML(displayDate(item.dueDate))}` : ""} • ${escapeHTML(item.status || "Open")}</small>
            </div>
          `).join("")}</div>` : ""}

          <div class="inspection-record-actions">
            <button class="button button-secondary button-small" type="button" data-edit-inspection="${escapeHTML(inspection.id)}">Edit</button>
            <button class="button inspection-button button-small" type="button" data-export-inspection="${escapeHTML(inspection.id)}">Export Package</button>
            ${snapshot?.startLocation ? `<a class="button button-secondary button-small" href="${mapLink(snapshot.startLocation, "Trip Start")}" target="_blank" rel="noopener">Start Map</a>` : ""}
            ${snapshot?.endLocation ? `<a class="button button-secondary button-small" href="${mapLink(snapshot.endLocation, "Trip End")}" target="_blank" rel="noopener">End Map</a>` : ""}
            <button class="button button-danger-outline button-small" type="button" data-delete-inspection="${escapeHTML(inspection.id)}">Delete</button>
          </div>
        </article>
      `;
    }).join("");
    hydrateInspectionListPhotos();
  }

  async function hydrateInspectionListPhotos() {
    inspectionListObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    inspectionListObjectUrls = [];
    if (!window.MileageMediaStore) return;
    const buttons = [...document.querySelectorAll("#inspectionList [data-view-photo]")];
    await Promise.all(buttons.map(async (button) => {
      try {
        const stored = await window.MileageMediaStore.getPhoto(button.dataset.viewPhoto);
        if (!stored?.blob || !button.isConnected) return;
        const url = URL.createObjectURL(stored.blob);
        inspectionListObjectUrls.push(url);
        button.dataset.photoUrl = url;
        button.innerHTML = `<img src="${url}" alt="">`;
      } catch (error) {
        console.warn("Could not load inspection thumbnail:", error);
      }
    }));
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

  function safeFilePart(value, fallback = "record") {
    const cleaned = String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 70);
    return cleaned || fallback;
  }

  function photoExtension(photo) {
    const type = String(photo?.type || photo?.blob?.type || "").toLowerCase();
    if (type === "image/png") return "png";
    if (type === "image/webp") return "webp";
    if (type === "image/heic" || type === "image/heif") return "heic";
    const match = String(photo?.name || "").toLowerCase().match(/\.(jpe?g|png|webp|heic|heif)$/);
    if (match) return match[1] === "jpeg" ? "jpg" : match[1];
    return "jpg";
  }

  function packageBaseName(inspection) {
    return [
      "Inspection",
      inspection.date || todayInputValue(),
      inspection.vendor || "Facility",
      inspection.projectNumber || inspection.equipmentTag || "Record"
    ].map((part, index) => safeFilePart(part, index === 0 ? "Inspection" : "Record")).join("_");
  }

  function inspectionFollowUpText(inspection, status = "Open") {
    return (inspection.followUps || [])
      .filter((item) => status === "All" || (status === "Closed" ? item.status === "Closed" : item.status !== "Closed"))
      .map((item) => {
        const details = [
          item.responsibleParty ? `Owner: ${item.responsibleParty}` : "",
          item.dueDate ? `Due: ${displayDate(item.dueDate)}` : "",
          `Status: ${item.status || "Open"}`
        ].filter(Boolean).join("; ");
        return `- ${item.action || "Follow-up"}${details ? ` (${details})` : ""}`;
      })
      .join("\r\n");
  }

  function buildInspectionUpdate(inspection, photoCount) {
    const snapshot = inspection.tripSnapshot || {};
    const lines = [
      "INSPECTION UPDATE",
      "",
      `Date: ${displayDate(inspection.date)}`,
      `Customer: ${inspection.customer || "Not entered"}`,
      `Vendor / Facility: ${inspection.vendor || "Not entered"}`,
      `Project: ${inspection.projectNumber || "Not entered"}`,
      `PO / Vendor Job: ${inspection.purchaseOrderJob || "Not entered"}`,
      `Equipment Tag: ${inspection.equipmentTag || "Not entered"}`,
      `Inspection Type: ${inspection.inspectionType || "Inspection"}`,
      `Activity: ${inspection.activity || "Not entered"}`,
      `Status: ${inspection.status || "Not entered"}`,
      `Acceptance / Release: ${inspection.acceptanceStatus || "Not Determined"}`,
      `Time: ${inspection.startTime || "Not entered"} - ${inspection.endTime || "Not entered"}`,
      `Hours On Site: ${inspection.hoursOnSite || "Not entered"}`,
      "",
      "SUMMARY",
      inspection.summary || "No summary entered.",
      "",
      "OBSERVATIONS",
      inspection.observations || "No observations entered.",
      "",
      "DEFICIENCIES / EXCEPTIONS",
      inspection.deficiencies || "None entered.",
      "",
      "OPEN FOLLOW-UPS",
      inspectionFollowUpText(inspection, "Open") || "None.",
      "",
      "RECORD DETAILS",
      `Photos: ${photoCount}`,
      `Mileage: ${snapshot.miles === undefined || snapshot.miles === null ? "Standalone inspection" : `${Number(snapshot.miles).toFixed(1)} miles`}`,
      `GPS Route Miles: ${snapshot.gpsRouteMiles === undefined || snapshot.gpsRouteMiles === null ? "Not recorded" : Number(snapshot.gpsRouteMiles).toFixed(1)}`,
      `STA Generated: ${snapshot.staGenerated ? "Yes" : "No"}`,
      `STA Filename: ${snapshot.staFileName || "Not recorded"}`,
      "",
      `Generated by Mileage Logger on ${new Date().toLocaleString()}`
    ];
    return lines.join("\r\n");
  }

  function buildInspectionDataCsv(inspection, photoCount) {
    const snapshot = inspection.tripSnapshot || {};
    const header = [
      "Date", "Customer", "Vendor / Facility", "Project Number", "PO / Vendor Job", "Equipment Tag",
      "Inspection Type", "Activity", "Status", "Acceptance / Release", "Start Time", "End Time",
      "Hours On Site", "Odometer Miles", "GPS Miles", "STA Generated", "STA Filename", "Photo Count",
      "Summary", "Observations", "Deficiencies / Exceptions", "Open Follow-ups", "Closed Follow-ups",
      "Created", "Modified"
    ];
    const row = [
      displayDate(inspection.date), inspection.customer, inspection.vendor, inspection.projectNumber,
      inspection.purchaseOrderJob, inspection.equipmentTag, inspection.inspectionType, inspection.activity,
      inspection.status, inspection.acceptanceStatus, inspection.startTime, inspection.endTime,
      inspection.hoursOnSite, snapshot.miles ?? "", snapshot.gpsRouteMiles ?? "",
      snapshot.staGenerated ? "Yes" : "No", snapshot.staFileName || "", photoCount,
      inspection.summary, inspection.observations, inspection.deficiencies,
      inspectionFollowUpText(inspection, "Open"), inspectionFollowUpText(inspection, "Closed"),
      formatDateTime(inspection.createdISO), formatDateTime(inspection.modifiedISO)
    ];
    return [header, row].map((values) => values.map(csvEscape).join(",")).join("\r\n");
  }

  function buildPhotoIndexHtml(inspection, photos) {
    const cards = photos.length
      ? photos.map((photo, index) => `
        <article class="photo">
          <img src="${escapeHTML(photo.packagePath)}" alt="${escapeHTML(photo.caption || photo.name || `Inspection photo ${index + 1}`)}">
          <div>
            <h2>Photo ${index + 1}</h2>
            <p><strong>Caption:</strong> ${escapeHTML(photo.caption || "No caption entered.")}</p>
            <p><strong>Original name:</strong> ${escapeHTML(photo.name || "Inspection photo")}</p>
          </div>
        </article>
      `).join("")
      : "<p>No photographs were attached to this inspection.</p>";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHTML(packageBaseName(inspection))} Photo Index</title>
  <style>
    body{font-family:Arial,sans-serif;color:#172033;background:#f4f6f8;margin:0;padding:24px}
    main{max-width:1000px;margin:auto}.header,.photo{background:white;border:1px solid #d9e0e8;border-radius:12px;padding:20px;margin-bottom:20px}
    h1,h2{margin-top:0}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
    .photo{display:grid;grid-template-columns:minmax(240px,2fr) minmax(180px,1fr);gap:20px;align-items:start}
    img{display:block;width:100%;height:auto;border-radius:8px}@media(max-width:700px){.photo{grid-template-columns:1fr}}
  </style>
</head>
<body>
<main>
  <section class="header">
    <h1>Inspection Photo Index</h1>
    <div class="meta">
      <span><strong>Date:</strong> ${escapeHTML(displayDate(inspection.date))}</span>
      <span><strong>Customer:</strong> ${escapeHTML(inspection.customer || "Not entered")}</span>
      <span><strong>Vendor:</strong> ${escapeHTML(inspection.vendor || "Not entered")}</span>
      <span><strong>Project:</strong> ${escapeHTML(inspection.projectNumber || "Not entered")}</span>
      <span><strong>Activity:</strong> ${escapeHTML(inspection.activity || "Not entered")}</span>
      <span><strong>Photos:</strong> ${photos.length}</span>
    </div>
  </section>
  ${cards}
</main>
</body>
</html>`;
  }

  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function wordParagraph(text, style = "", options = {}) {
    const paragraphProperties = [
      style ? `<w:pStyle w:val="${style}"/>` : "",
      options.center ? '<w:jc w:val="center"/>' : "",
      options.pageBreakBefore ? '<w:pageBreakBefore/>' : "",
      options.keepNext ? '<w:keepNext/>' : ""
    ].filter(Boolean).join("");
    const lines = String(text ?? "").split(/\r?\n/);
    const runs = lines.map((line, index) => {
      const breakTag = index ? '<w:br/>' : "";
      return `<w:r>${options.bold ? "<w:rPr><w:b/></w:rPr>" : ""}${breakTag}<w:t xml:space="preserve">${xmlEscape(line || " ")}</w:t></w:r>`;
    }).join("");
    return `<w:p>${paragraphProperties ? `<w:pPr>${paragraphProperties}</w:pPr>` : ""}${runs}</w:p>`;
  }

  function wordTable(rows, widths, headerRows = 0) {
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
    const tableRows = rows.map((row, rowIndex) => {
      const cells = row.map((value, cellIndex) => {
        const fill = rowIndex < headerRows || (widths.length === 4 && cellIndex % 2 === 0) ? "F2F4F7" : "";
        const bold = rowIndex < headerRows || (widths.length === 4 && cellIndex % 2 === 0);
        return `<w:tc><w:tcPr><w:tcW w:w="${widths[cellIndex]}" w:type="dxa"/>${fill ? `<w:shd w:fill="${fill}"/>` : ""}<w:vAlign w:val="center"/></w:tcPr>${wordParagraph(value || " ", "", { bold })}</w:tc>`;
      }).join("");
      return `<w:tr>${rowIndex < headerRows ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
    }).join("");
    return `<w:tbl>
      <w:tblPr>
        <w:tblW w:w="${totalWidth}" w:type="dxa"/>
        <w:tblInd w:w="120" w:type="dxa"/>
        <w:tblLayout w:type="fixed"/>
        <w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:color="D9E0E8"/>
          <w:left w:val="single" w:sz="4" w:color="D9E0E8"/>
          <w:bottom w:val="single" w:sz="4" w:color="D9E0E8"/>
          <w:right w:val="single" w:sz="4" w:color="D9E0E8"/>
          <w:insideH w:val="single" w:sz="4" w:color="D9E0E8"/>
          <w:insideV w:val="single" w:sz="4" w:color="D9E0E8"/>
        </w:tblBorders>
      </w:tblPr>
      <w:tblGrid>${grid}</w:tblGrid>
      ${tableRows}
    </w:tbl>`;
  }

  function wordImageParagraph(photo, relationshipId, drawingId, mediaName, options = {}) {
    const maxWidth = Number(options.maxWidth) || 6.2;
    const maxHeight = Number(options.maxHeight) || 7.0;
    const sourceWidth = Number(photo.width) || 1200;
    const sourceHeight = Number(photo.height) || 900;
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
    const width = Math.max(1, sourceWidth * scale);
    const height = Math.max(1, sourceHeight * scale);
    const cx = Math.round(width * 914400);
    const cy = Math.round(height * 914400);
    const description = xmlEscape(photo.caption || photo.name || `Inspection photo ${drawingId}`);
    return `<w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="${cx}" cy="${cy}"/>
          <wp:docPr id="${drawingId}" name="${xmlEscape(mediaName)}" descr="${description}"/>
          <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic>
                <pic:nvPicPr><pic:cNvPr id="0" name="${xmlEscape(mediaName)}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr>
                <pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing></w:r>
    </w:p>`;
  }

  function parseWordXml(bytes, partName) {
    const xml = window.fflate.strFromU8(bytes);
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const parserError = document.getElementsByTagName("parsererror")[0];
    if (parserError) throw new Error(`The S&B template contains invalid XML in ${partName}.`);
    return document;
  }

  function serializeWordXml(document) {
    return window.fflate.strToU8(new XMLSerializer().serializeToString(document));
  }

  function wordElements(parent, localName) {
    return Array.from(parent.getElementsByTagNameNS(WORD_NS, localName));
  }

  function wordNodeText(parent) {
    return wordElements(parent, "t").map((node) => node.textContent || "").join("");
  }

  function setWordParagraphText(paragraph, value) {
    const document = paragraph.ownerDocument;
    const firstRun = wordElements(paragraph, "r")[0];
    const runProperties = firstRun ? wordElements(firstRun, "rPr")[0]?.cloneNode(true) : null;
    Array.from(paragraph.childNodes).forEach((node) => {
      if (!(node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === "pPr")) {
        paragraph.removeChild(node);
      }
    });
    String(value ?? "").split(/\r?\n/).forEach((line, index) => {
      const run = document.createElementNS(WORD_NS, "w:r");
      if (runProperties) run.appendChild(runProperties.cloneNode(true));
      if (index) run.appendChild(document.createElementNS(WORD_NS, "w:br"));
      const text = document.createElementNS(WORD_NS, "w:t");
      text.setAttributeNS(XML_NS, "xml:space", "preserve");
      text.textContent = line || " ";
      run.appendChild(text);
      paragraph.appendChild(run);
    });
  }

  function tableRows(table) {
    return Array.from(table.childNodes).filter(
      (node) => node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === "tr"
    );
  }

  function rowCells(row) {
    return Array.from(row.childNodes).filter(
      (node) => node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === "tc"
    );
  }

  function setWordCellText(table, rowIndex, cellIndex, value) {
    const row = tableRows(table)[rowIndex];
    const cell = row ? rowCells(row)[cellIndex] : null;
    if (!cell) return;
    let paragraph = Array.from(cell.childNodes).find(
      (node) => node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === "p"
    );
    if (!paragraph) {
      paragraph = cell.ownerDocument.createElementNS(WORD_NS, "w:p");
      cell.appendChild(paragraph);
    }
    setWordParagraphText(paragraph, value || " ");
  }

  function setHeaderLabelValue(table, rowIndex, cellIndex, label, value) {
    setWordCellText(table, rowIndex, cellIndex, `${label}${value ? ` ${value}` : " "}`);
  }

  function normalizedWordText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
  }

  function hasWordAncestor(element, localName) {
    let parent = element?.parentElement || null;
    while (parent) {
      if (parent.namespaceURI === WORD_NS && parent.localName === localName) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function findWordParagraph(document, label) {
    const expected = normalizedWordText(label);
    return wordElements(document, "p").find(
      (paragraph) => (
        !hasWordAncestor(paragraph, "tc")
        && normalizedWordText(wordNodeText(paragraph)) === expected
      )
    ) || null;
  }

  function nextWordParagraph(paragraph) {
    let node = paragraph?.nextSibling || null;
    while (node) {
      if (node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === "p") return node;
      node = node.nextSibling;
    }
    return null;
  }

  function setParagraphAfterLabel(document, label, value) {
    if (!value) return;
    const labelParagraph = findWordParagraph(document, label);
    const valueParagraph = nextWordParagraph(labelParagraph);
    if (valueParagraph) setWordParagraphText(valueParagraph, value);
  }

  function setLabeledParagraphValue(document, label, value) {
    if (!value) return;
    const paragraph = findWordParagraph(document, label);
    if (paragraph) setWordParagraphText(paragraph, `${label} ${value}`);
  }

  function importWordFragment(document, xml) {
    const wrapper = new DOMParser().parseFromString(
      `<root xmlns:w="${WORD_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">${xml}</root>`,
      "application/xml"
    );
    const parserError = wrapper.getElementsByTagName("parsererror")[0];
    if (parserError) throw new Error("The S&B photo layout could not be created.");
    return document.importNode(wrapper.documentElement.firstElementChild, true);
  }

  function setPhotoCell(table, rowIndex, cellIndex, photo, relationshipId, drawingId, mediaName, figureNumber) {
    const row = tableRows(table)[rowIndex];
    const cell = row ? rowCells(row)[cellIndex] : null;
    if (!cell) return;
    Array.from(cell.childNodes).forEach((node) => {
      if (!(node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === "tcPr")) {
        cell.removeChild(node);
      }
    });
    const imageParagraph = importWordFragment(
      cell.ownerDocument,
      wordImageParagraph(photo, relationshipId, drawingId, mediaName, {
        maxWidth: 3.65,
        maxHeight: 1.65
      })
    );
    const caption = importWordFragment(
      cell.ownerDocument,
      wordParagraph(
        `Figure ${figureNumber} - ${photo.caption || photo.name || "Inspection photo"}`,
        "",
        { center: true }
      )
    );
    cell.appendChild(imageParagraph);
    cell.appendChild(caption);
  }

  function setEmptyPhotoCell(table, rowIndex, cellIndex, figureNumber) {
    const row = tableRows(table)[rowIndex];
    const cell = row ? rowCells(row)[cellIndex] : null;
    if (!cell) return;
    Array.from(cell.childNodes).forEach((node) => {
      if (!(node.nodeType === 1 && node.namespaceURI === WORD_NS && node.localName === "tcPr")) {
        cell.removeChild(node);
      }
    });
    cell.appendChild(
      importWordFragment(
        cell.ownerDocument,
        wordParagraph(`Figure ${figureNumber} -`, "", { center: false })
      )
    );
  }

  function nextRelationshipId(relationshipsDocument) {
    const used = Array.from(relationshipsDocument.getElementsByTagNameNS(REL_NS, "Relationship"))
      .map((relationship) => String(relationship.getAttribute("Id") || ""))
      .map((id) => Number(id.replace(/^rId/i, "")))
      .filter(Number.isFinite);
    return Math.max(0, ...used) + 1;
  }

  async function buildSAndBInspectionDocx(templateRecord, inspection, photos, outputFilename) {
    if (!window.fflate) throw new Error("The Word document component is unavailable.");
    const files = window.fflate.unzipSync(new Uint8Array(templateRecord.bytes));
    validateInspectionReportTemplateBytes(new Uint8Array(templateRecord.bytes));

    const documentXml = parseWordXml(files["word/document.xml"], "word/document.xml");
    const headerXml = parseWordXml(files["word/header1.xml"], "word/header1.xml");
    const footerXml = parseWordXml(files["word/footer1.xml"], "word/footer1.xml");
    const relationshipsXml = parseWordXml(
      files["word/_rels/document.xml.rels"],
      "word/_rels/document.xml.rels"
    );

    const headerTable = wordElements(headerXml, "tbl")[0];
    if (!headerTable) throw new Error("The S&B template header table is missing.");
    setHeaderLabelValue(headerTable, 1, 0, "CLIENT:", inspection.customer || "");
    setHeaderLabelValue(headerTable, 1, 1, "CLIENT PROJECT:", "");
    setHeaderLabelValue(headerTable, 2, 0, "CLIENT PROJECT NUMBER:", inspection.projectNumber || "");
    setHeaderLabelValue(headerTable, 2, 1, "CLIENT PO TO S&B INSPECTION:", "");
    setHeaderLabelValue(headerTable, 3, 0, "CLIENT PO TO VENDOR:", inspection.purchaseOrderJob || "");
    setHeaderLabelValue(headerTable, 3, 1, "S&B INSPECTION JOB:", "");
    setHeaderLabelValue(headerTable, 4, 0, "REPORT NUMBER:", "");
    setHeaderLabelValue(headerTable, 4, 1, "DATE OF REPORT:", displayDate(inspection.date));

    const tables = wordElements(documentXml, "tbl");
    const vendorTable = tables[0];
    const photoTable = tables[2];
    if (!vendorTable || !photoTable) throw new Error("The S&B template report tables are missing.");
    const snapshot = inspection.tripSnapshot || {};
    setWordCellText(vendorTable, 0, 1, inspection.vendor || "");
    setWordCellText(vendorTable, 4, 1, inspection.purchaseOrderJob || "");
    setWordCellText(vendorTable, 7, 1, displayDate(inspection.date));
    setWordCellText(vendorTable, 8, 1, snapshot.staFileName || "");
    setWordCellText(vendorTable, 7, 3, inspection.activity || "");
    setWordCellText(vendorTable, 8, 3, inspection.equipmentTag || "");

    const followUps = Array.isArray(inspection.followUps) ? inspection.followUps : [];
    const actionItems = followUps.map((item) => {
      const owner = item.responsibleParty ? ` — ${item.responsibleParty}` : "";
      const due = item.dueDate ? `, due ${displayDate(item.dueDate)}` : "";
      return `${item.action || "Follow-up"}${owner}${due} (${item.status || "Open"})`;
    }).join("\n");
    const inspectionAudit = [
      inspection.observations || "",
      inspection.deficiencies ? `Deficiencies / Exceptions: ${inspection.deficiencies}` : ""
    ].filter(Boolean).join("\n");
    setParagraphAfterLabel(documentXml, "DESCRIPTION:", inspection.summary || inspection.activity || "");
    setParagraphAfterLabel(documentXml, "ACTION ITEMS:", actionItems);
    setParagraphAfterLabel(documentXml, "INSPECTION/AUDIT:", inspectionAudit);
    setLabeledParagraphValue(
      documentXml,
      "Shop Inspection:",
      [inspection.activity, inspection.summary].filter(Boolean).join(" — ")
    );
    if (/NDE/i.test(inspection.inspectionType || "") || /NDE/i.test(inspection.activity || "")) {
      setLabeledParagraphValue(documentXml, "NDE Review:", inspection.observations || inspection.summary || "Performed");
    }
    if (/COAT/i.test(inspection.inspectionType || "") || /COAT/i.test(inspection.activity || "")) {
      setLabeledParagraphValue(documentXml, "Coating Inspection:", inspection.observations || inspection.summary || "Performed");
    }
    setLabeledParagraphValue(
      documentXml,
      "Inspection Release:",
      [
        inspection.acceptanceStatus || "",
        inspection.deficiencies ? `Exceptions: ${inspection.deficiencies}` : ""
      ].filter(Boolean).join(" — ")
    );

    const relationshipRoot = relationshipsXml.documentElement;
    let relationshipNumber = nextRelationshipId(relationshipsXml);
    const supportedPhotos = photos
      .filter((photo) => ["png", "jpg", "jpeg"].includes(photoExtension(photo)))
      .slice(0, 4);
    for (let index = 0; index < supportedPhotos.length; index += 1) {
      const photo = supportedPhotos[index];
      const extension = photoExtension(photo) === "jpeg" ? "jpg" : photoExtension(photo);
      const mediaName = `sb-inspection-photo-${index + 1}.${extension}`;
      const relationshipId = `rId${relationshipNumber}`;
      relationshipNumber += 1;
      const relationship = relationshipsXml.createElementNS(REL_NS, "Relationship");
      relationship.setAttribute("Id", relationshipId);
      relationship.setAttribute(
        "Type",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
      );
      relationship.setAttribute("Target", `media/${mediaName}`);
      relationshipRoot.appendChild(relationship);
      files[`word/media/${mediaName}`] = new Uint8Array(await photo.blob.arrayBuffer());
      setPhotoCell(
        photoTable,
        Math.floor(index / 2),
        index % 2,
        photo,
        relationshipId,
        100 + index,
        mediaName,
        index + 1
      );
    }
    for (let index = supportedPhotos.length; index < 4; index += 1) {
      setEmptyPhotoCell(
        photoTable,
        Math.floor(index / 2),
        index % 2,
        index + 1
      );
    }

    wordElements(footerXml, "t").forEach((textNode) => {
      const text = String(textNode.textContent || "");
      if (/\.docx/i.test(text)) textNode.textContent = outputFilename;
    });

    files["word/document.xml"] = serializeWordXml(documentXml);
    files["word/header1.xml"] = serializeWordXml(headerXml);
    files["word/footer1.xml"] = serializeWordXml(footerXml);
    files["word/_rels/document.xml.rels"] = serializeWordXml(relationshipsXml);
    return new Uint8Array(window.fflate.zipSync(files, { level: 6 }));
  }

  async function buildInspectionDocx(inspection, photos) {
    if (!window.fflate) throw new Error("The Word document component is unavailable.");
    const snapshot = inspection.tripSnapshot || {};
    const now = new Date().toISOString();
    const metadata = [
      ["Date", displayDate(inspection.date), "Customer", inspection.customer || "Not entered"],
      ["Vendor / Facility", inspection.vendor || "Not entered", "Project Number", inspection.projectNumber || "Not entered"],
      ["PO / Vendor Job", inspection.purchaseOrderJob || "Not entered", "Equipment Tag", inspection.equipmentTag || "Not entered"],
      ["Inspection Type", inspection.inspectionType || "Inspection", "Activity", inspection.activity || "Not entered"],
      ["Status", inspection.status || "Not entered", "Acceptance / Release", inspection.acceptanceStatus || "Not Determined"],
      ["Start Time", inspection.startTime || "Not entered", "End Time", inspection.endTime || "Not entered"],
      ["Hours On Site", inspection.hoursOnSite || "Not entered", "Attached Photos", String(photos.length)],
      ["Mileage", snapshot.miles === undefined || snapshot.miles === null ? "Standalone inspection" : `${Number(snapshot.miles).toFixed(1)} miles`, "GPS Route Miles", snapshot.gpsRouteMiles === undefined || snapshot.gpsRouteMiles === null ? "Not recorded" : Number(snapshot.gpsRouteMiles).toFixed(1)],
      ["STA Generated", snapshot.staGenerated ? "Yes" : "No", "STA Filename", snapshot.staFileName || "Not recorded"]
    ];
    const followUps = inspection.followUps || [];
    const followUpRows = [
      ["Action", "Responsible Party", "Due Date", "Status"],
      ...followUps.map((item) => [
        item.action || "Follow-up",
        item.responsibleParty || "Not assigned",
        item.dueDate ? displayDate(item.dueDate) : "Not entered",
        item.status || "Open"
      ])
    ];

    const embeddedPhotos = photos.filter((photo) => ["png", "jpg", "jpeg"].includes(photoExtension(photo)));
    const imageRelationships = [];
    const mediaEntries = {};
    embeddedPhotos.forEach((photo, index) => {
      const extension = photoExtension(photo) === "jpeg" ? "jpg" : photoExtension(photo);
      const mediaName = `inspection-photo-${index + 1}.${extension}`;
      const relationshipId = `rId${5 + index}`;
      imageRelationships.push({ photo, relationshipId, mediaName, extension });
    });
    for (const item of imageRelationships) {
      mediaEntries[`word/media/${item.mediaName}`] = new Uint8Array(await item.photo.blob.arrayBuffer());
    }

    const photoBody = photos.length
      ? photos.map((photo, index) => {
        const embedded = imageRelationships.find((item) => item.photo === photo);
        const caption = photo.caption || photo.name || `Inspection photo ${index + 1}`;
        const photoHeading = index === 0
          ? `Inspection Photos - Photo 1 of ${photos.length}`
          : `Photo ${index + 1} of ${photos.length}`;
        return [
          wordParagraph(photoHeading, "Heading1", { pageBreakBefore: true, keepNext: true }),
          wordParagraph(caption, "Caption", { center: true }),
          embedded
            ? wordImageParagraph(photo, embedded.relationshipId, index + 1, embedded.mediaName)
            : wordParagraph("This image remains in the package's Photos folder but cannot be embedded in this Word version.", "", { center: true }),
          wordParagraph(`File: ${photo.packagePath}`, "Caption", { center: true })
        ].join("");
      }).join("")
      : "";

    const body = [
      wordParagraph("INSPECTION REPORT", "Title"),
      wordParagraph(`${inspection.vendor || "Facility"}${inspection.projectNumber ? ` | ${inspection.projectNumber}` : ""}`, "Subtitle"),
      wordTable(metadata, [1500, 3180, 1500, 3180]),
      wordParagraph("Summary", "Heading1", { keepNext: true }),
      wordParagraph(inspection.summary || "No summary entered."),
      wordParagraph("Observations", "Heading1", { keepNext: true }),
      wordParagraph(inspection.observations || "No observations entered."),
      wordParagraph("Deficiencies / Exceptions", "Heading1", { keepNext: true }),
      wordParagraph(inspection.deficiencies || "None entered."),
      followUps.length ? wordParagraph("Follow-up Actions", "Heading1", { keepNext: true }) : "",
      followUps.length ? wordTable(followUpRows, [4200, 1900, 1400, 1860], 1) : "",
      photoBody
    ].join("");

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>${body}
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId3"/>
      <w:footerReference w:type="default" r:id="rId4"/>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
      <w:cols w:space="720"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="172033"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="80"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="0B2545"/><w:sz w:val="46"/><w:szCs w:val="46"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/><w:keepNext/></w:pPr><w:rPr><w:color w:val="566573"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4D78"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="80" w:after="80"/></w:pPr><w:rPr><w:i/><w:color w:val="566573"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
</w:styles>`;

    const documentRelationships = [
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
      ...imageRelationships.map((item) => `<Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${item.mediaName}"/>`)
    ].join("");

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

    const entries = {
      "[Content_Types].xml": window.fflate.strToU8(contentTypes),
      "_rels/.rels": window.fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
      "docProps/core.xml": window.fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(packageBaseName(inspection))} Editable Inspection Report</dc:title><dc:creator>Mileage Logger</dc:creator><cp:lastModifiedBy>Mileage Logger</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
      "docProps/app.xml": window.fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Mileage Logger</Application><AppVersion>1.0</AppVersion></Properties>`),
      "word/document.xml": window.fflate.strToU8(documentXml),
      "word/styles.xml": window.fflate.strToU8(stylesXml),
      "word/settings.xml": window.fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:updateFields w:val="true"/></w:settings>`),
      "word/header1.xml": window.fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D9E0E8"/></w:pBdr></w:pPr><w:r><w:rPr><w:color w:val="566573"/><w:sz w:val="18"/></w:rPr><w:t>Mileage Logger | Editable Inspection Report</w:t></w:r></w:p></w:hdr>`),
      "word/footer1.xml": window.fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:color w:val="777777"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:color w:val="777777"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`),
      "word/_rels/document.xml.rels": window.fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${documentRelationships}</Relationships>`),
      ...mediaEntries
    };
    return new Uint8Array(window.fflate.zipSync(entries, { level: 6 }));
  }

  function pdfSafeText(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, "\"")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  }

  function wrapPdfText(text, font, size, maxWidth) {
    const lines = [];
    const paragraphs = pdfSafeText(text || "").split(/\r?\n/);
    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) {
        lines.push("");
        continue;
      }
      const words = paragraph.split(/\s+/);
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
          line = candidate;
        } else {
          lines.push(line);
          line = word;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  async function buildInspectionPdf(inspection, photos) {
    if (!window.PDFLib?.PDFDocument) throw new Error("The PDF component is unavailable.");
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const document = await PDFDocument.create();
    const regular = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    const pageSize = [612, 792];
    const margin = 44;
    const contentWidth = pageSize[0] - margin * 2;
    let page;
    let y;

    const addPage = () => {
      page = document.addPage(pageSize);
      y = pageSize[1] - margin;
      page.drawText("Mileage Logger Inspection Record", {
        x: margin,
        y,
        size: 9,
        font: bold,
        color: rgb(0.22, 0.35, 0.48)
      });
      y -= 22;
    };
    const ensureSpace = (height) => {
      if (y - height < margin) addPage();
    };
    const drawWrapped = (text, options = {}) => {
      const font = options.bold ? bold : regular;
      const size = options.size || 10;
      const lineHeight = options.lineHeight || size * 1.35;
      const lines = wrapPdfText(text || "", font, size, options.width || contentWidth);
      for (const line of lines) {
        ensureSpace(lineHeight);
        page.drawText(line || " ", {
          x: options.x || margin,
          y,
          size,
          font,
          color: options.color || rgb(0.08, 0.12, 0.18)
        });
        y -= lineHeight;
      }
    };
    const drawField = (label, value) => {
      drawWrapped(`${label}: ${value || "Not entered"}`, { size: 10 });
    };
    const drawSection = (title, text) => {
      ensureSpace(55);
      y -= 8;
      drawWrapped(title.toUpperCase(), { bold: true, size: 11, color: rgb(0.06, 0.35, 0.50) });
      drawWrapped(text || "None entered.", { size: 10 });
    };

    addPage();
    drawWrapped("INSPECTION REPORT", { bold: true, size: 20, lineHeight: 25, color: rgb(0.04, 0.24, 0.36) });
    y -= 5;
    drawField("Date", displayDate(inspection.date));
    drawField("Customer", inspection.customer);
    drawField("Vendor / Facility", inspection.vendor);
    drawField("Project Number", inspection.projectNumber);
    drawField("PO / Vendor Job", inspection.purchaseOrderJob);
    drawField("Equipment Tag", inspection.equipmentTag);
    drawField("Inspection Type", inspection.inspectionType);
    drawField("Activity", inspection.activity);
    drawField("Status", inspection.status);
    drawField("Acceptance / Release", inspection.acceptanceStatus);
    drawField("Time", `${inspection.startTime || "Not entered"} - ${inspection.endTime || "Not entered"}`);
    drawField("Hours On Site", inspection.hoursOnSite);

    const snapshot = inspection.tripSnapshot || {};
    drawField("Mileage", snapshot.miles === undefined || snapshot.miles === null ? "Standalone inspection" : `${Number(snapshot.miles).toFixed(1)} miles`);
    drawField("GPS Route Miles", snapshot.gpsRouteMiles === undefined || snapshot.gpsRouteMiles === null ? "Not recorded" : Number(snapshot.gpsRouteMiles).toFixed(1));
    drawField("STA Generated", snapshot.staGenerated ? "Yes" : "No");
    drawField("Attached Photos", String(photos.length));

    drawSection("Summary", inspection.summary);
    drawSection("Observations", inspection.observations);
    drawSection("Deficiencies / Exceptions", inspection.deficiencies || "None entered.");
    drawSection("Open Follow-ups", inspectionFollowUpText(inspection, "Open") || "None.");
    drawSection("Closed Follow-ups", inspectionFollowUpText(inspection, "Closed") || "None.");

    for (let index = 0; index < photos.length; index += 1) {
      const photo = photos[index];
      addPage();
      drawWrapped(`PHOTO ${index + 1} OF ${photos.length}`, { bold: true, size: 14, lineHeight: 20 });
      drawWrapped(photo.caption || photo.name || "Inspection photo", { size: 10 });
      y -= 8;
      try {
        const bytes = new Uint8Array(await photo.blob.arrayBuffer());
        const embedded = String(photo.type || photo.blob.type || "").toLowerCase() === "image/png"
          ? await document.embedPng(bytes)
          : await document.embedJpg(bytes);
        const availableHeight = Math.max(120, y - margin - 30);
        const scale = Math.min(contentWidth / embedded.width, availableHeight / embedded.height, 1);
        const width = embedded.width * scale;
        const height = embedded.height * scale;
        page.drawImage(embedded, {
          x: margin + (contentWidth - width) / 2,
          y: y - height,
          width,
          height
        });
        y -= height + 18;
        drawWrapped(`File: ${photo.packagePath}`, { size: 8, color: rgb(0.35, 0.38, 0.42) });
      } catch (error) {
        drawWrapped("This photo is included in the Photos folder but could not be embedded in the PDF.", {
          size: 10,
          color: rgb(0.65, 0.18, 0.12)
        });
      }
    }

    const pages = document.getPages();
    pages.forEach((currentPage, index) => {
      currentPage.drawText(`Page ${index + 1} of ${pages.length}`, {
        x: pageSize[0] - margin - 70,
        y: 22,
        size: 8,
        font: regular,
        color: rgb(0.4, 0.42, 0.45)
      });
    });
    return new Uint8Array(await document.save());
  }

  async function loadPackagePhotos(inspection) {
    if (!window.MileageMediaStore) return [];
    const stored = await window.MileageMediaStore.getAllPhotos();
    // Match by the photo's unique ID so packages also include photos created by
    // older builds that saved a temporary inspection ID before the record itself.
    const byId = new Map(stored.map((photo) => [photo.id, photo]));
    return (inspection.photos || []).map((metadata, index) => {
      const photo = byId.get(metadata.id);
      if (!photo?.blob) return null;
      const extension = photoExtension(photo);
      const sequence = String(index + 1).padStart(2, "0");
      const friendlyName = safeFilePart(photo.caption || photo.name, `Inspection_Photo_${sequence}`);
      return {
        ...photo,
        ...metadata,
        blob: photo.blob,
        packagePath: `Photos/${sequence}_${friendlyName}.${extension}`
      };
    }).filter(Boolean);
  }

  async function deliverInspectionPackage(filename, blob) {
    const file = new File([blob], filename, { type: "application/zip" });
    const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)")?.matches;
    if (touchDevice && navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        // Share only the file. On iOS, including a text message alongside a ZIP
        // can cause Save to Files to save the message as a .txt file instead.
        await navigator.share({ files: [file] });
        showInspectionToast("Inspection package shared.");
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          showInspectionToast("Inspection package was not saved.");
          return;
        }
        console.warn("Inspection package share failed; using download instead:", error);
      }
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showInspectionToast("Inspection package downloaded.");
  }

  async function exportInspectionPackage(inspection, button) {
    if (!window.fflate) {
      window.alert("The ZIP component is unavailable. Reopen the app while online and try again.");
      return;
    }
    const originalText = button?.textContent || "Export Package";
    if (button) {
      button.disabled = true;
      button.textContent = "Building Package...";
    }
    try {
      const photos = await loadPackagePhotos(inspection);
      const baseName = packageBaseName(inspection);
      const updateText = buildInspectionUpdate(inspection, photos.length);
      const csv = buildInspectionDataCsv(inspection, photos.length);
      const html = buildPhotoIndexHtml(inspection, photos);
      const pdf = await buildInspectionPdf(inspection, photos);
      const editableReportFilename = `${baseName}_Editable_Report.docx`;
      const templateRecord = inspectionTemplateInstalled
        ? await readInspectionReportTemplateRecord()
        : null;
      const docx = templateRecord?.bytes
        ? await buildSAndBInspectionDocx(
          templateRecord,
          inspection,
          photos,
          editableReportFilename
        )
        : await buildInspectionDocx(inspection, photos);
      const entries = {
        [`${baseName}_Report.pdf`]: pdf,
        [editableReportFilename]: docx,
        [`${baseName}_Update.txt`]: window.fflate.strToU8(updateText),
        [`${baseName}_Data.csv`]: window.fflate.strToU8(csv),
        [`${baseName}_Photo_Index.html`]: window.fflate.strToU8(html)
      };
      for (const photo of photos) {
        entries[photo.packagePath] = new Uint8Array(await photo.blob.arrayBuffer());
      }
      const bytes = window.fflate.zipSync(entries, { level: 6 });
      const filename = `${baseName}_Package.zip`;
      await deliverInspectionPackage(filename, new Blob([bytes], { type: "application/zip" }));
    } catch (error) {
      console.error("Inspection package export failed:", error);
      window.alert(`The inspection package could not be created.\n\n${error.message}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
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
      backup: [state.backup?.pendingTripCount, state.backup?.pendingChangeCount, state.backup?.lastConfirmedISO]
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
    $("importInspectionTemplateBtn")?.addEventListener("click", () => {
      $("inspectionTemplateFileInput")?.click();
    });
    $("removeInspectionTemplateBtn")?.addEventListener("click", async () => {
      if (!window.confirm("Remove the privately stored S&B Word report template from this device? Inspection records and photos will not be deleted.")) return;
      try {
        await deleteInspectionReportTemplateRecord();
        await refreshInspectionReportTemplateStatus();
        showInspectionToast("Private S&B Word template removed.");
      } catch (error) {
        window.alert(`The private S&B Word template could not be removed.\n\n${error.message}`);
      }
    });
    $("inspectionSearch")?.addEventListener("input", () => renderInspectionList(readState()));
    $("clearInspectionSearch")?.addEventListener("click", () => {
      $("inspectionSearch").value = "";
      renderInspectionList(readState());
    });

    document.addEventListener("click", async (event) => {
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

      if (event.target.closest("#takeInspectionPhotoBtn")) {
        $("takeInspectionPhotoInput")?.click();
        return;
      }

      if (event.target.closest("#chooseInspectionPhotosBtn")) {
        $("chooseInspectionPhotosInput")?.click();
        return;
      }

      const viewPhotoButton = event.target.closest("[data-view-photo]");
      if (viewPhotoButton) {
        const url = viewPhotoButton.dataset.photoUrl;
        if (url) window.open(url, "_blank", "noopener");
        else window.alert("The photo is still loading or is not available on this device.");
        return;
      }

      const removePhotoButton = event.target.closest("[data-remove-photo]");
      if (removePhotoButton) {
        const photoId = removePhotoButton.dataset.removePhoto;
        const removedPhoto = collectPhotoMetadata().find((photo) => photo.id === photoId);
        if (!window.confirm("Remove this photo from the inspection?")) return;
        currentPhotos = collectPhotoMetadata().filter((photo) => photo.id !== photoId);
        try {
          if (!removedPhoto?.sourceTripId) {
            await window.MileageMediaStore?.deletePhoto(photoId);
          }
          if (editingInspectionWasExisting && originalPhotoIds.has(photoId)) {
            originalPhotoIds.delete(photoId);
            updateState((state) => {
              const inspection = state.settings.inspections.find((item) => item.id === editingInspectionId);
              if (inspection) {
                inspection.photos = (inspection.photos || []).filter((photo) => photo.id !== photoId);
                inspection.modifiedISO = nowISO();
              }
            });
          }
          await renderPhotoEditors();
          $("inspectionPhotoStatus").textContent = "Photo removed. Save the inspection to keep this change.";
          $("inspectionPhotoStatus").className = "gps-status warn";
        } catch (error) {
          window.alert(`The photo could not be removed.\n\n${error.message}`);
        }
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

      const exportButton = event.target.closest("[data-export-inspection]");
      if (exportButton) {
        const state = readState();
        const inspection = state.settings.inspections.find((item) => item.id === exportButton.dataset.exportInspection);
        if (inspection) await exportInspectionPackage(inspection, exportButton);
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
        window.MileageMediaStore?.deleteInspectionPhotos(inspection.id).catch((error) => {
          console.warn("Could not remove inspection photos:", error);
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
      if (event.target.id === "inspectionTemplateFileInput") {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        const status = $("inspectionTemplateStatus");
        const importButton = $("importInspectionTemplateBtn");
        if (importButton) importButton.disabled = true;
        if (status) {
          status.textContent = "Validating and storing the S&B Word template privately on this device…";
          status.className = "private-master-status";
        }
        importInspectionReportTemplate(file)
          .then(async () => {
            await refreshInspectionReportTemplateStatus();
            showInspectionToast("Private S&B Word template installed.");
          })
          .catch(async (error) => {
            console.error("S&B Word template import failed:", error);
            window.alert(`The S&B Word template could not be imported.\n\n${error.message}`);
            await refreshInspectionReportTemplateStatus();
          })
          .finally(() => {
            if (importButton) importButton.disabled = false;
          });
        return;
      }
      if (event.target.id === "takeInspectionPhotoInput" || event.target.id === "chooseInspectionPhotosInput") {
        const files = [...(event.target.files || [])];
        event.target.value = "";
        addInspectionPhotos(files);
      }
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
    window.addEventListener("mileage:trip-completed", (event) => {
      promptForCompletedTrip(event.detail?.tripId || "", event.detail?.backupConfirmed);
    });
  }

  function promptForCompletedTrip(tripId, backupConfirmed) {
      refreshFromState(true);

      if (!tripId || !backupConfirmed) return;

      const state = readState();
      const trip = getTripById(state, tripId);
      if (!trip) return;

      const createInspection = window.confirm(
        `Trip saved and backed up.\n\nCreate an inspection record for ${trip.vendor || "this trip"}?`
      );
      if (createInspection) showInspectionSection(true, tripId);
  }

  function initialize() {
    injectInterface();
    bindEvents();
    window.MileageInspectionDatabase = {
      promptForTrip: promptForCompletedTrip
    };
    refreshFromState(true);
    refreshInspectionReportTemplateStatus();

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



