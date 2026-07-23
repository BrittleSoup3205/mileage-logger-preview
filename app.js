(() => {
  "use strict";

  const STORAGE_KEY = "mileage_logger_state_v3";
  const OLD_STORAGE_KEYS = ["mileage_logger_state_v2", "mileage_logger_state_v1"];
  const STA_DB_NAME = "MileageLoggerPrivateFiles";
  const STA_DB_VERSION = 1;
  const STA_DB_STORE = "privateFiles";
  const STA_MASTER_KEY = "staMaster";
  const METERS_PER_MILE = 1609.344;

  const DEFAULT_SETTINGS = {
    roundMiles: true,
    autoCaptureGps: true,
    maxGpsAccuracy: 100,
    differenceWarning: 3,
    customers: ["Shell", "Westlake"],
    vendors: [
      "Repcon",
      "Cembell",
      "James Machine Works",
      "Smith Tank",
      "Nextcoat",
      "Pipe & Steel"
    ],
    purposes: [
      "Inspection",
      "Pre-Fab Meeting",
      "Hydro Test",
      "Audit",
      "Final Inspection",
      "Coating Inspection"
    ],
    vendorLocations: [],
    dark: false
  };

  const DEFAULT_BACKUP_STATE = {
    pendingTripCount: 0,
    lastConfirmedISO: null,
    lastConfirmedTripCount: 0,
    lastFilename: "",
    lastRequiredISO: null
  };

  const $ = (id) => document.getElementById(id);
  let routeWatchId = null;
  let pendingStartLocation = null;
  let pendingEndLocation = null;
  let pendingVendorGps = null;
  let staContextTripId = null;
  let staMasterBytesPromise = null;

  function defaultState() {
    return {
      activeTrip: null,
      trips: [],
      lastOdometer: "",
      backup: { ...DEFAULT_BACKUP_STATE },
      settings: { ...DEFAULT_SETTINGS, vendorLocations: [] }
    };
  }

  function sanitizeState(parsed) {
    return {
      activeTrip: parsed?.activeTrip || null,
      trips: Array.isArray(parsed?.trips) ? parsed.trips : [],
      lastOdometer: parsed?.lastOdometer ?? "",
      backup: {
        ...DEFAULT_BACKUP_STATE,
        ...(parsed?.backup || {})
      },
      settings: {
        ...DEFAULT_SETTINGS,
        ...(parsed?.settings || {}),
        vendorLocations: Array.isArray(parsed?.settings?.vendorLocations)
          ? parsed.settings.vendorLocations
          : []
      }
    };
  }

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return sanitizeState(JSON.parse(raw));
      } catch (error) {
        console.error("Could not load v2 data:", error);
      }
    }

    for (const oldKey of OLD_STORAGE_KEYS) {
      const oldRaw = localStorage.getItem(oldKey);
      if (!oldRaw) continue;
      try {
        const migrated = sanitizeState(JSON.parse(oldRaw));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      } catch (error) {
        console.error(`Could not migrate data from ${oldKey}:`, error);
      }
    }

    return defaultState();
  }

  let state = loadState();

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `trip-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getNow() {
    const date = new Date();
    return {
      iso: date.toISOString(),
      date: date.toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric"
      }),
      time: date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit"
      })
    };
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function parseNumber(value) {
    const cleaned = String(value ?? "").replace(/,/g, "").trim();
    if (!cleaned) return NaN;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : NaN;
  }

  function parseOdometer(value) {
    return parseNumber(value);
  }

  function formatNumber(value, forceOneDecimal = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    if (forceOneDecimal || state.settings.roundMiles) {
      return number.toFixed(1);
    }
    return String(Math.round(number * 1000) / 1000);
  }

  function normalizeList(text) {
    return [...new Set(
      String(text ?? "")
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    )];
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3400);
  }

  function ensureBackupState() {
    if (!state.backup || typeof state.backup !== "object") {
      state.backup = { ...DEFAULT_BACKUP_STATE };
    }
    state.backup = { ...DEFAULT_BACKUP_STATE, ...state.backup };
    state.backup.pendingTripCount = Math.max(0, Number(state.backup.pendingTripCount || 0));
  }

  function backupIsRequired() {
    ensureBackupState();
    return state.backup.pendingTripCount > 0;
  }

  function formatBackupDate(iso) {
    if (!iso) return "No confirmed external backup yet";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function renderBackupStatus() {
    ensureBackupState();
    const pill = $("backupPill");
    const text = $("backupStatusText");
    if (!pill || !text) return;

    if (backupIsRequired()) {
      pill.textContent = "BACKUP REQUIRED";
      pill.className = "pill backup-required";
      text.innerHTML = `
        <strong>${state.backup.pendingTripCount} completed trip${state.backup.pendingTripCount === 1 ? "" : "s"} not yet confirmed as saved outside the app.</strong><br>
        Save the full backup to Files or iCloud Drive before starting another trip.
      `;
      $("backupCard")?.classList.add("backup-card-required");
      return;
    }

    pill.textContent = state.backup.lastConfirmedISO ? "CURRENT" : "READY";
    pill.className = "pill ready";
    const count = Number(state.backup.lastConfirmedTripCount || 0);
    text.innerHTML = state.backup.lastConfirmedISO
      ? `<strong>Last confirmed backup:</strong> ${escapeHTML(formatBackupDate(state.backup.lastConfirmedISO))}<br>
         ${count} completed trip${count === 1 ? "" : "s"} included • ${escapeHTML(state.backup.lastFilename || "backup file")}`
      : `No completed trip is waiting for backup. After the first trip, the app will open the Save to Files process automatically.`;
    $("backupCard")?.classList.remove("backup-card-required");
  }

  function requireBackupBeforeNewTrip() {
    if (!backupIsRequired()) return true;
    renderBackupStatus();
    $("backupCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.alert(
      "A completed trip still needs a confirmed backup. Tap Save Full Backup to Files, save it to iCloud Drive or Files, and confirm the save before starting another trip."
    );
    return false;
  }

  function hidePrimaryPanels() {
    ["startSection", "endSection", "staSection", "logSection"].forEach((id) => {
      $(id).classList.add("hidden");
    });
  }

  function showSection(id, shouldScroll = true) {
    if (id === "startSection" && !requireBackupBeforeNewTrip()) return;
    hidePrimaryPanels();
    if (!id || !$(id)) return;

    $(id).classList.remove("hidden");

    if (id === "startSection") prepareStartForm();
    if (id === "endSection") prepareEndForm();
    if (id === "staSection") prepareStaForm();
    if (id === "logSection") renderLog();

    if (shouldScroll) {
      setTimeout(() => $(id).scrollIntoView({ behavior: "smooth", block: "start" }), 30);
    }
  }

  function renderDatalists() {
    const definitions = [
      ["customerList", state.settings.customers],
      ["vendorList", state.settings.vendors],
      ["purposeList", state.settings.purposes]
    ];

    definitions.forEach(([id, values]) => {
      const list = $(id);
      list.innerHTML = "";
      values.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        list.appendChild(option);
      });
    });
  }

  function renderSettings() {
    $("roundMiles").checked = Boolean(state.settings.roundMiles);
    $("autoCaptureGps").checked = Boolean(state.settings.autoCaptureGps);
    $("maxGpsAccuracy").value = String(state.settings.maxGpsAccuracy);
    $("differenceWarning").value = String(state.settings.differenceWarning);
    $("savedCustomers").value = state.settings.customers.join("\n");
    $("savedVendors").value = state.settings.vendors.join("\n");
    $("savedPurposes").value = state.settings.purposes.join("\n");

    document.body.classList.toggle("dark", Boolean(state.settings.dark));
    document.querySelector('meta[name="theme-color"]').setAttribute(
      "content",
      state.settings.dark ? "#111a2b" : "#14213d"
    );

    renderVendorLocations();
  }

  function mapLink(location, label) {
    if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) {
      return "";
    }
    const lat = encodeURIComponent(location.latitude);
    const lon = encodeURIComponent(location.longitude);
    const q = encodeURIComponent(label || "Location");
    return `https://maps.apple.com/?ll=${lat},${lon}&q=${q}`;
  }

  function locationSummary(location) {
    if (!location) return "Not captured";
    const accuracy = Number(location.accuracy);
    return `${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)} • accuracy ±${Number.isFinite(accuracy) ? Math.round(accuracy) : "?"} m`;
  }

  function renderStatus() {
    $("todayLine").textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    });

    const title = $("statusTitle");
    const pill = $("statusPill");
    const details = $("activeDetails");

    if (state.activeTrip) {
      const trip = state.activeTrip;
      const routeMiles = calculateRouteMiles(trip.routePoints || []);
      const routeState = trip.trackRoute
        ? (routeWatchId !== null ? "Tracking while app is open" : "Tracking paused")
        : "Route tracking off";

      title.textContent = "Trip Active";
      pill.textContent = "ACTIVE";
      pill.className = "pill active";
      details.innerHTML = `
        <div class="detail-grid">
          <div class="detail"><span>Started</span><strong>${escapeHTML(trip.date)} ${escapeHTML(trip.startTime)}</strong></div>
          <div class="detail"><span>Start odometer</span><strong>${formatNumber(trip.startOdometer, true)}</strong></div>
          <div class="detail"><span>Project</span><strong>${escapeHTML(trip.projectNumber || "—")}</strong></div>
          <div class="detail"><span>Customer</span><strong>${escapeHTML(trip.customer)}</strong></div>
          <div class="detail"><span>Vendor</span><strong>${escapeHTML(trip.vendor)}</strong></div>
          <div class="detail"><span>Purpose</span><strong>${escapeHTML(trip.purpose)}</strong></div>
          <div class="detail"><span>Start GPS</span><strong>${escapeHTML(locationSummary(trip.startLocation))}</strong></div>
          <div class="detail"><span>Route GPS</span><strong>${escapeHTML(routeState)} • ${formatNumber(routeMiles, true)} mi</strong></div>
          <div class="detail"><span>Notes</span><strong>${escapeHTML(trip.notes || "—")}</strong></div>
        </div>
        <div class="active-controls">
          <button id="createStaBtn" class="button button-primary button-small" type="button">Create STA</button>
          ${trip.startLocation ? `<a class="button button-secondary button-small" href="${mapLink(trip.startLocation, "Trip Start")}" target="_blank" rel="noopener">Open Start Map</a>` : ""}
          ${trip.trackRoute && routeWatchId === null ? `<button id="resumeRouteBtn" class="button button-secondary button-small" type="button">Resume Route GPS</button>` : ""}
          ${trip.trackRoute && routeWatchId !== null ? `<button id="pauseRouteBtn" class="button button-secondary button-small" type="button">Pause Route GPS</button>` : ""}
        </div>
      `;
      $("startBtn").disabled = true;
      $("endBtn").disabled = false;
    } else {
      title.textContent = "Ready to Start";
      pill.textContent = "READY";
      pill.className = "pill ready";
      details.innerHTML = state.lastOdometer !== ""
        ? `<div class="detail"><span>Last odometer</span><strong>${formatNumber(state.lastOdometer, true)}</strong></div>`
        : `<p class="muted">No active trip. Your first starting odometer will be entered manually.</p>`;
      $("startBtn").disabled = false;
      $("endBtn").disabled = true;
    }
  }

  function prepareStartForm() {
    if (state.activeTrip) {
      showToast("A trip is already active.");
      showSection("endSection");
      return;
    }

    $("startForm").reset();
    $("startOdo").value = state.lastOdometer === "" ? "" : formatNumber(state.lastOdometer, true);
    $("projectNumber").value = "";
    $("trackRoute").checked = false;
    pendingStartLocation = null;
    updateStartGpsStatus();
    $("vendorSuggestion").classList.add("hidden");
    $("vendorSuggestion").innerHTML = "";

    if (state.settings.autoCaptureGps) {
      setTimeout(() => captureStartGps(false), 120);
    }
  }

  function prepareEndForm() {
    if (!state.activeTrip) {
      showToast("There is no active trip to end.");
      hidePrimaryPanels();
      return;
    }

    const trip = state.activeTrip;
    $("endForm").reset();
    pendingEndLocation = null;
    $("endTripSummary").innerHTML = `
      <strong>${escapeHTML(trip.customer)} — ${escapeHTML(trip.vendor)}</strong><br>
      ${escapeHTML(trip.purpose)}<br>
      Started ${escapeHTML(trip.date)} at ${escapeHTML(trip.startTime)}<br>
      Starting odometer: ${formatNumber(trip.startOdometer, true)}<br>
      GPS route so far: ${formatNumber(calculateRouteMiles(trip.routePoints || []), true)} miles
    `;
    $("milesPreview").classList.add("hidden");
    $("gpsComparison").classList.add("hidden");
    updateEndGpsStatus();

    if (state.settings.autoCaptureGps) {
      setTimeout(() => captureEndGps(false), 120);
    }
  }

  function haversineMiles(a, b) {
    if (!a || !b) return 0;

    const lat1 = Number(a.latitude) * Math.PI / 180;
    const lat2 = Number(b.latitude) * Math.PI / 180;
    const dLat = (Number(b.latitude) - Number(a.latitude)) * Math.PI / 180;
    const dLon = (Number(b.longitude) - Number(a.longitude)) * Math.PI / 180;

    const value = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

    const angle = 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
    return 3958.7613 * angle;
  }

  function calculateRouteMiles(points) {
    if (!Array.isArray(points) || points.length < 2) return 0;
    let total = 0;

    for (let index = 1; index < points.length; index += 1) {
      const segment = haversineMiles(points[index - 1], points[index]);
      if (segment > 0 && segment < 5) total += segment;
    }
    return total;
  }

  function normalizedPosition(position) {
    const coords = position.coords;
    return {
      latitude: Number(coords.latitude),
      longitude: Number(coords.longitude),
      accuracy: Number(coords.accuracy),
      altitude: Number.isFinite(coords.altitude) ? Number(coords.altitude) : null,
      heading: Number.isFinite(coords.heading) ? Number(coords.heading) : null,
      speed: Number.isFinite(coords.speed) ? Number(coords.speed) : null,
      timestamp: new Date(position.timestamp || Date.now()).toISOString()
    };
  }

  function geolocationErrorText(error) {
    if (!error) return "Location could not be captured.";
    if (error.code === 1) return "Location permission was denied. Allow Location access in Safari settings.";
    if (error.code === 2) return "Your location is currently unavailable.";
    if (error.code === 3) return "The GPS request timed out. Try again outdoors or near a window.";
    return error.message || "Location could not be captured.";
  }

  function captureCurrentLocation(button, statusElement, onSuccess, manual = true) {
    if (!("geolocation" in navigator)) {
      statusElement.textContent = "This browser does not support GPS location.";
      statusElement.className = "gps-status bad";
      if (manual) window.alert("This browser does not support GPS location.");
      return;
    }

    button.disabled = true;
    statusElement.textContent = "Requesting current GPS location…";
    statusElement.className = "gps-status";

    navigator.geolocation.getCurrentPosition(
      (position) => {
        button.disabled = false;
        const location = normalizedPosition(position);
        onSuccess(location);
      },
      (error) => {
        button.disabled = false;
        statusElement.textContent = geolocationErrorText(error);
        statusElement.className = "gps-status bad";
        if (manual) window.alert(geolocationErrorText(error));
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0
      }
    );
  }

  function accuracyClass(location) {
    if (!location) return "";
    return Number(location.accuracy) <= Number(state.settings.maxGpsAccuracy) ? "good" : "warn";
  }

  function updateStartGpsStatus() {
    const status = $("startGpsStatus");
    if (!pendingStartLocation) {
      status.textContent = "No starting location captured.";
      status.className = "gps-status";
      return;
    }

    status.textContent = `Captured ${locationSummary(pendingStartLocation)}`;
    status.className = `gps-status ${accuracyClass(pendingStartLocation)}`;
  }

  function updateEndGpsStatus() {
    const status = $("endGpsStatus");
    if (!pendingEndLocation) {
      status.textContent = "No ending location captured.";
      status.className = "gps-status";
      return;
    }

    status.textContent = `Captured ${locationSummary(pendingEndLocation)}`;
    status.className = `gps-status ${accuracyClass(pendingEndLocation)}`;
  }

  function findNearbyVendor(location) {
    if (!location || !Array.isArray(state.settings.vendorLocations)) return null;

    const matches = state.settings.vendorLocations
      .map((vendor) => ({
        ...vendor,
        distanceMiles: haversineMiles(location, vendor)
      }))
      .filter((vendor) => vendor.distanceMiles <= Number(vendor.radiusMiles || 0.5))
      .sort((a, b) => a.distanceMiles - b.distanceMiles);

    return matches[0] || null;
  }

  function showVendorSuggestion(location) {
    const box = $("vendorSuggestion");
    const match = findNearbyVendor(location);

    if (!match) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }

    box.innerHTML = `
      You appear to be near <strong>${escapeHTML(match.name)}</strong>
      (${formatNumber(match.distanceMiles, true)} miles away).
      <button id="useSuggestedVendorBtn" class="button button-secondary button-small" type="button">Use ${escapeHTML(match.name)}</button>
    `;
    box.classList.remove("hidden");

    $("useSuggestedVendorBtn").addEventListener("click", () => {
      $("vendor").value = match.name;
      showToast(`${match.name} selected.`);
    });
  }

  function captureStartGps(manual = true) {
    captureCurrentLocation(
      $("captureStartGpsBtn"),
      $("startGpsStatus"),
      (location) => {
        pendingStartLocation = location;
        updateStartGpsStatus();
        showVendorSuggestion(location);
      },
      manual
    );
  }

  function captureEndGps(manual = true) {
    captureCurrentLocation(
      $("captureEndGpsBtn"),
      $("endGpsStatus"),
      (location) => {
        pendingEndLocation = location;
        updateEndGpsStatus();
        calculateMilesPreview();
      },
      manual
    );
  }

  function addRoutePoint(location) {
    if (!state.activeTrip || !state.activeTrip.trackRoute) return;

    if (!Array.isArray(state.activeTrip.routePoints)) {
      state.activeTrip.routePoints = [];
    }

    const points = state.activeTrip.routePoints;
    const last = points[points.length - 1];

    if (Number(location.accuracy) > Math.max(Number(state.settings.maxGpsAccuracy) * 2, 250)) {
      return;
    }

    if (last) {
      const distance = haversineMiles(last, location);
      const seconds = Math.max(
        1,
        (new Date(location.timestamp).getTime() - new Date(last.timestamp).getTime()) / 1000
      );
      const mph = distance / (seconds / 3600);

      if (distance < 0.003) return;
      if (distance > 2 && mph > 130) return;
    }

    points.push(location);
    if (points.length > 5000) {
      state.activeTrip.routePoints = points.slice(-5000);
    }

    saveState();
    renderStatus();
  }

  function startRouteTracking() {
    if (!state.activeTrip || !state.activeTrip.trackRoute) return;
    if (!("geolocation" in navigator)) return;
    if (routeWatchId !== null) return;

    routeWatchId = navigator.geolocation.watchPosition(
      (position) => addRoutePoint(normalizedPosition(position)),
      (error) => {
        console.warn("Route GPS error:", geolocationErrorText(error));
        showToast("Route GPS paused because location could not be updated.");
        stopRouteTracking(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 25000,
        maximumAge: 5000
      }
    );

    renderStatus();
  }

  function stopRouteTracking(showMessage = true) {
    if (routeWatchId !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(routeWatchId);
    }
    routeWatchId = null;
    renderStatus();
    if (showMessage) showToast("Route GPS paused.");
  }

  function calculateMilesPreview() {
    if (!state.activeTrip) return;

    const end = parseOdometer($("endOdo").value);
    const preview = $("milesPreview");
    const comparison = $("gpsComparison");

    if (!Number.isFinite(end)) {
      preview.classList.add("hidden");
      comparison.classList.add("hidden");
      return;
    }

    const odometerMiles = end - Number(state.activeTrip.startOdometer);
    preview.classList.remove("hidden");

    if (odometerMiles < 0) {
      preview.textContent = "Ending odometer is lower than the starting odometer.";
      preview.style.color = "var(--danger)";
      comparison.classList.add("hidden");
      return;
    }

    preview.textContent = `Calculated odometer distance: ${formatNumber(odometerMiles, true)} miles`;
    preview.style.color = "var(--success)";

    const routeMiles = calculateRouteMiles(state.activeTrip.routePoints || []);
    const hasRoute = routeMiles > 0.05;
    const directMiles = state.activeTrip.startLocation && pendingEndLocation
      ? haversineMiles(state.activeTrip.startLocation, pendingEndLocation)
      : 0;
    const gpsMiles = hasRoute ? routeMiles : directMiles;

    if (gpsMiles <= 0) {
      comparison.classList.add("hidden");
      return;
    }

    const difference = Math.abs(odometerMiles - gpsMiles);
    const gpsLabel = hasRoute ? "GPS route estimate" : "Straight-line GPS distance";
    const warning = hasRoute && difference >= Number(state.settings.differenceWarning);

    comparison.classList.remove("hidden");
    comparison.classList.toggle("warning", warning);
    comparison.innerHTML = `
      <strong>${gpsLabel}: ${formatNumber(gpsMiles, true)} miles</strong><br>
      Difference from odometer: ${formatNumber(difference, true)} miles
      ${warning ? "<br><strong>Check the odometer entries before saving.</strong>" : ""}
      ${!hasRoute ? "<br><small>Straight-line distance is for location verification, not driving mileage.</small>" : ""}
    `;
  }

  function renderLog() {
    const query = $("searchBox").value.trim().toLowerCase();
    const filtered = state.trips
      .filter((trip) => {
        if (!query) return true;
        return [
          trip.date,
          trip.projectNumber || "",
          trip.startTime,
          trip.endTime,
          trip.customer,
          trip.vendor,
          trip.purpose,
          trip.notes
        ].join(" ").toLowerCase().includes(query);
      })
      .sort((a, b) => String(b.endISO).localeCompare(String(a.endISO)));

    const totalMiles = filtered.reduce((sum, trip) => sum + Number(trip.miles || 0), 0);
    $("logSummary").textContent = `${filtered.length} trip${filtered.length === 1 ? "" : "s"} • ${formatNumber(totalMiles, true)} odometer miles`;

    const tbody = $("tripTable").querySelector("tbody");
    tbody.innerHTML = "";

    filtered.forEach((trip) => {
      const gpsMiles = Number(trip.gpsRouteMiles || 0);
      const difference = gpsMiles > 0 ? Math.abs(Number(trip.miles) - gpsMiles) : null;
      const startMap = mapLink(trip.startLocation, "Trip Start");
      const endMap = mapLink(trip.endLocation, "Trip End");

      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHTML(trip.date)}</td>
        <td>${escapeHTML(trip.projectNumber || "")}</td>
        <td>${escapeHTML(trip.startTime)}</td>
        <td>${escapeHTML(trip.endTime)}</td>
        <td>${formatNumber(trip.startOdometer, true)}</td>
        <td>${formatNumber(trip.endOdometer, true)}</td>
        <td>${formatNumber(trip.miles, true)}</td>
        <td>${gpsMiles > 0 ? formatNumber(gpsMiles, true) : "—"}</td>
        <td>${difference !== null ? formatNumber(difference, true) : "—"}</td>
        <td>${escapeHTML(trip.customer)}</td>
        <td>${escapeHTML(trip.vendor)}</td>
        <td>${escapeHTML(trip.purpose)}</td>
        <td>
          <div class="sta-actions-cell">
            <span>${trip.staGenerated ? "Generated" : "Not generated"}</span>
            <button class="button button-secondary button-small" type="button" data-open-sta="${escapeHTML(trip.id)}">${trip.staGenerated ? "Generate Again" : "Create"}</button>
          </div>
        </td>
        <td>
          <div class="map-links">
            ${startMap ? `<a href="${startMap}" target="_blank" rel="noopener">Start</a>` : "—"}
            ${endMap ? `<a href="${endMap}" target="_blank" rel="noopener">End</a>` : ""}
          </div>
        </td>
        <td>${escapeHTML(trip.notes || "")}</td>
        <td><button class="button button-danger-outline button-small" type="button" data-delete-trip="${escapeHTML(trip.id)}">Delete</button></td>
      `;
      tbody.appendChild(row);
    });

    $("emptyLog").classList.toggle("hidden", filtered.length !== 0);
    $("tripTable").classList.toggle("hidden", filtered.length === 0);
  }

  function csvEscape(value) {
    const string = String(value ?? "");
    if (/[",\r\n]/.test(string)) {
      return `"${string.replace(/"/g, '""')}"`;
    }
    return string;
  }

  function locationCsv(location, field) {
    if (!location) return "";
    return location[field] ?? "";
  }

  function makeCSV() {
    const rows = [
      [
        "Date",
        "Project Number",
        "Start Time",
        "End Time",
        "Start Odometer",
        "End Odometer",
        "Odometer Miles",
        "GPS Route Miles",
        "Straight-Line GPS Miles",
        "Mileage Difference",
        "Customer",
        "Vendor",
        "Purpose",
        "STA Generated",
        "STA Filename",
        "Start Latitude",
        "Start Longitude",
        "Start GPS Accuracy Meters",
        "End Latitude",
        "End Longitude",
        "End GPS Accuracy Meters",
        "Start Map URL",
        "End Map URL",
        "Notes"
      ],
      ...state.trips.map((trip) => {
        const gpsMiles = Number(trip.gpsRouteMiles || 0);
        const difference = gpsMiles > 0 ? Math.abs(Number(trip.miles) - gpsMiles) : "";
        return [
          trip.date,
          trip.projectNumber || "",
          trip.startTime,
          trip.endTime,
          formatNumber(trip.startOdometer, true),
          formatNumber(trip.endOdometer, true),
          formatNumber(trip.miles, true),
          gpsMiles > 0 ? formatNumber(gpsMiles, true) : "",
          Number(trip.directGpsMiles || 0) > 0 ? formatNumber(trip.directGpsMiles, true) : "",
          difference === "" ? "" : formatNumber(difference, true),
          trip.customer,
          trip.vendor,
          trip.purpose,
          trip.staGenerated ? "Yes" : "No",
          trip.staFileName || "",
          locationCsv(trip.startLocation, "latitude"),
          locationCsv(trip.startLocation, "longitude"),
          locationCsv(trip.startLocation, "accuracy"),
          locationCsv(trip.endLocation, "latitude"),
          locationCsv(trip.endLocation, "longitude"),
          locationCsv(trip.endLocation, "accuracy"),
          mapLink(trip.startLocation, "Trip Start"),
          mapLink(trip.endLocation, "Trip End"),
          trip.notes || ""
        ];
      })
    ];

    return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function exportCSV() {
    if (state.trips.length === 0) {
      showToast("There are no completed trips to export.");
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`mileage-log-gps-${stamp}.csv`, makeCSV(), "text/csv;charset=utf-8");
    showToast("CSV export created.");
  }

  function backupTimestamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function buildBackupPackage() {
    ensureBackupState();
    return {
      backupFormat: "MileageLoggerFullBackup",
      backupVersion: 2,
      createdISO: new Date().toISOString(),
      tripCount: state.trips.length,
      note: "This full restore file excludes the privately imported STA master. Keep the original STA master PDF separately in Files.",
      appState: state
    };
  }

  function createBackupFile() {
    const filename = `Mileage_Logger_Full_Backup_${backupTimestamp()}_${state.trips.length}_trips.json`;
    const content = JSON.stringify(buildBackupPackage(), null, 2);
    return {
      filename,
      content,
      file: new File([content], filename, { type: "application/json" })
    };
  }

  function markBackupConfirmed(filename) {
    ensureBackupState();
    state.backup.pendingTripCount = 0;
    state.backup.lastConfirmedISO = new Date().toISOString();
    state.backup.lastConfirmedTripCount = state.trips.length;
    state.backup.lastFilename = filename;
    saveState();
    renderAll();
  }

  async function saveFullBackupToFiles(options = {}) {
    const automatic = Boolean(options.automatic);
    const backup = createBackupFile();
    let handoffCompleted = false;

    try {
      const canShareFile = Boolean(
        navigator.share &&
        (!navigator.canShare || navigator.canShare({ files: [backup.file] }))
      );

      if (canShareFile) {
        await navigator.share({
          title: "Mileage Logger Full Backup",
          text: "Choose Save to Files, select an iCloud Drive folder, then tap Save.",
          files: [backup.file]
        });
        handoffCompleted = true;
      } else {
        downloadFile(backup.filename, backup.content, "application/json");
        handoffCompleted = true;
        window.alert(
          "The backup file was downloaded. Make sure it is saved or moved into iCloud Drive or another safe folder."
        );
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        showToast("Backup canceled. Backup is still required.");
      } else {
        console.error("Backup share failed:", error);
        try {
          downloadFile(backup.filename, backup.content, "application/json");
          handoffCompleted = true;
          window.alert(
            "The share sheet could not be used, so the backup was downloaded instead. Save or move it into iCloud Drive or another safe folder."
          );
        } catch (fallbackError) {
          window.alert(`The backup could not be created.

${fallbackError.message || error.message}`);
        }
      }
    }

    if (!handoffCompleted) {
      renderBackupStatus();
      return false;
    }

    const confirmed = window.confirm(
      "Did you save the backup file to Files, iCloud Drive, OneDrive, Google Drive, or another location outside this app?\n\nTap OK only after the file has been saved."
    );

    if (confirmed) {
      markBackupConfirmed(backup.filename);
      showToast(automatic ? "Trip saved and backup confirmed." : "Full backup confirmed.");
      return true;
    }

    renderBackupStatus();
    showToast("Backup remains required until you confirm the external save.");
    return false;
  }

  function backupData() {
    return saveFullBackupToFiles({ automatic: false });
  }

  function importBackupFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const imported = parsed?.backupFormat === "MileageLoggerFullBackup"
          ? parsed.appState
          : parsed;

        if (!imported || !Array.isArray(imported.trips)) {
          throw new Error("Backup does not contain a trip list.");
        }

        const confirmed = window.confirm("Restoring will replace all current mileage app data. Continue?");
        if (!confirmed) return;

        stopRouteTracking(false);
        state = sanitizeState(imported);
        ensureBackupState();
        state.backup.pendingTripCount = 0;
        state.backup.lastConfirmedISO = new Date().toISOString();
        state.backup.lastConfirmedTripCount = state.trips.length;
        state.backup.lastFilename = file.name || "Restored backup";
        saveState();
        renderAll();

        if (state.activeTrip?.trackRoute) startRouteTracking();
        showToast("Backup restored successfully.");
      } catch (error) {
        window.alert(`The backup could not be restored.

${error.message}`);
      }
    };
    reader.readAsText(file);
  }

  function renderVendorLocations() {
    const list = $("vendorLocationsList");
    list.innerHTML = "";

    if (!state.settings.vendorLocations.length) {
      list.innerHTML = `<div class="empty-state">No vendor locations saved.</div>`;
      return;
    }

    state.settings.vendorLocations.forEach((vendor) => {
      const row = document.createElement("div");
      row.className = "vendor-location-row";
      row.innerHTML = `
        <div>
          <strong>${escapeHTML(vendor.name)}</strong>
          <small>${escapeHTML(vendor.taskLocation || "No STA task location")} • ${escapeHTML(vendor.safetyContact || "No safety contact")}${vendor.safetyPhone ? ` • ${escapeHTML(vendor.safetyPhone)}` : ""}</small>
          <small>${Number(vendor.latitude).toFixed(6)}, ${Number(vendor.longitude).toFixed(6)} • ${formatNumber(vendor.radiusMiles, true)} mi radius</small>
        </div>
        <button class="button button-danger-outline button-small" type="button" data-delete-vendor-location="${escapeHTML(vendor.id)}">Remove</button>
      `;
      list.appendChild(row);
    });
  }


  function openPrivateFileDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("This browser does not support private local file storage."));
        return;
      }

      const request = indexedDB.open(STA_DB_NAME, STA_DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STA_DB_STORE)) {
          database.createObjectStore(STA_DB_STORE, { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error || new Error("The private file database could not be opened.")
      );
    });
  }

  async function readPrivateStaMasterRecord() {
    const database = await openPrivateFileDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STA_DB_STORE, "readonly");
      const store = transaction.objectStore(STA_DB_STORE);
      const request = store.get(STA_MASTER_KEY);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(
        request.error || new Error("The private STA master could not be read.")
      );
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("The private file transaction failed."));
      };
    });
  }

  async function writePrivateStaMasterRecord(record) {
    const database = await openPrivateFileDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STA_DB_STORE, "readwrite");
      const store = transaction.objectStore(STA_DB_STORE);
      store.put(record);

      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("The private STA master could not be saved."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Saving the private STA master was canceled."));
      };
    });
  }

  async function deletePrivateStaMasterRecord() {
    const database = await openPrivateFileDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STA_DB_STORE, "readwrite");
      const store = transaction.objectStore(STA_DB_STORE);
      store.delete(STA_MASTER_KEY);

      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("The private STA master could not be removed."));
      };
    });
  }

  function formatFileSize(bytes) {
    const size = Number(bytes || 0);
    if (size < 1024) return `${size} bytes`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function validateStaMasterBytes(bytes) {
    if (!window.PDFLib?.PDFDocument) {
      throw new Error("The PDF generator library did not load.");
    }

    const pdfDoc = await window.PDFLib.PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false
    });

    if (pdfDoc.getPageCount() !== 2) {
      throw new Error("This does not appear to be the approved two-page STA master.");
    }

    const fieldNames = new Set(
      pdfDoc.getForm().getFields().map((field) => field.getName())
    );
    const requiredFields = ["Box 1", "Box 4", "Box 5", "Box 6", "Box 8", "Box 16", "Box 17"];
    const missingFields = requiredFields.filter((name) => !fieldNames.has(name));

    if (missingFields.length) {
      throw new Error(
        `This PDF is missing required STA fields: ${missingFields.join(", ")}.`
      );
    }
  }

  async function refreshPrivateStaMasterStatus() {
    const installStatus = $("staMasterInstallStatus");
    const masterPill = $("staMasterPill");
    const importButton = $("importStaMasterBtn");
    const removeButton = $("removeStaMasterBtn");
    const generateButtons = [$("shareStaBtn"), $("downloadStaBtn")];

    try {
      const record = await readPrivateStaMasterRecord();

      if (!record?.bytes) {
        installStatus.textContent =
          "No private STA master is installed on this device. Import the approved PDF before generating an STA.";
        installStatus.className = "private-master-status warning";
        masterPill.textContent = "NOT INSTALLED";
        masterPill.className = "pill active";
        importButton.textContent = "Import STA Master";
        removeButton.disabled = true;
        generateButtons.forEach((button) => { button.disabled = true; });
        return false;
      }

      const importedDate = record.importedISO
        ? new Date(record.importedISO).toLocaleString()
        : "date unavailable";

      installStatus.innerHTML = `
        <strong>${escapeHTML(record.name || "STA master PDF")}</strong><br>
        Stored privately on this device • ${escapeHTML(formatFileSize(record.size))} • imported ${escapeHTML(importedDate)}
      `;
      installStatus.className = "private-master-status installed";
      masterPill.textContent = "INSTALLED";
      masterPill.className = "pill ready";
      importButton.textContent = "Replace STA Master";
      removeButton.disabled = false;
      generateButtons.forEach((button) => { button.disabled = false; });
      return true;
    } catch (error) {
      console.error("Private STA master status failed:", error);
      installStatus.textContent = `Private storage error: ${error.message}`;
      installStatus.className = "private-master-status error";
      masterPill.textContent = "ERROR";
      masterPill.className = "pill active";
      removeButton.disabled = true;
      generateButtons.forEach((button) => { button.disabled = true; });
      return false;
    }
  }

  async function importPrivateStaMaster(file) {
    if (!file) return;

    const filename = String(file.name || "");
    if (!filename.toLowerCase().endsWith(".pdf")) {
      throw new Error("Choose the approved STA master PDF.");
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    await validateStaMasterBytes(bytes);

    await writePrivateStaMasterRecord({
      id: STA_MASTER_KEY,
      name: filename,
      type: file.type || "application/pdf",
      size: file.size || bytes.byteLength,
      importedISO: new Date().toISOString(),
      bytes: arrayBuffer
    });

    staMasterBytesPromise = null;
  }


  function findFacilityProfileByVendor(vendorName) {
    const normalized = String(vendorName || "").trim().toLowerCase();
    if (!normalized) return null;
    return state.settings.vendorLocations.find(
      (profile) => String(profile.name || "").trim().toLowerCase() === normalized
    ) || null;
  }

  function getStaContextTrip() {
    if (staContextTripId && state.activeTrip?.id === staContextTripId) {
      return state.activeTrip;
    }
    if (staContextTripId) {
      const saved = state.trips.find((trip) => trip.id === staContextTripId);
      if (saved) return saved;
    }
    return state.activeTrip || null;
  }

  function prepareStaForm() {
    const trip = getStaContextTrip();
    const status = $("staStatus");

    if (!trip) {
      const now = getNow();
      $("staSourceSummary").innerHTML = `
        <strong>Standalone STA</strong><br>
        No mileage trip is active. Enter the project and facility details below.
      `;
      $("staForm").reset();
      $("staProjectNumber").value = "";
      $("staDate").value = now.date;
      $("staTime").value = now.time;
      $("staTaskLocation").value = "";
      $("staSafetyContact").value = "";
      $("staSafetyPhone").value = "";
      $("shareStaBtn").disabled = true;
      $("downloadStaBtn").disabled = true;
      status.textContent = "Complete the fields, then import or confirm the private STA master above.";
      refreshPrivateStaMasterStatus();
      status.className = "gps-status good";
      return;
    }

    const profile = findFacilityProfileByVendor(trip.vendor);
    const saved = trip.staData || {};

    $("staSourceSummary").innerHTML = `
      <strong>${escapeHTML(trip.customer)} — ${escapeHTML(trip.vendor)}</strong><br>
      ${escapeHTML(trip.purpose)} • ${escapeHTML(trip.date)} ${escapeHTML(trip.startTime)}<br>
      ${trip.staGenerated ? `Last generated: ${escapeHTML(trip.staFileName || "STA PDF")}` : "No STA has been generated for this trip yet."}
    `;

    $("staProjectNumber").value = saved.projectNumber ?? trip.projectNumber ?? "";
    $("staDate").value = saved.date ?? trip.date ?? "";
    $("staTime").value = saved.time ?? trip.startTime ?? "";
    $("staTaskLocation").value = saved.taskLocation ?? profile?.taskLocation ?? trip.vendor ?? "";
    $("staSafetyContact").value = saved.safetyContact ?? profile?.safetyContact ?? "";
    $("staSafetyPhone").value = saved.safetyPhone ?? profile?.safetyPhone ?? "";

    $("shareStaBtn").disabled = true;
    $("downloadStaBtn").disabled = true;
    refreshPrivateStaMasterStatus();
    status.textContent = profile
      ? `Facility profile found for ${profile.name}. Review the fields before generating.`
      : "No matching facility profile was found. Review and complete the contact fields.";
    status.className = `gps-status ${profile ? "good" : "warn"}`;
  }

  function getStaValues() {
    return {
      projectNumber: $("staProjectNumber").value.trim(),
      date: $("staDate").value.trim(),
      time: $("staTime").value.trim(),
      taskLocation: $("staTaskLocation").value.trim(),
      safetyContact: $("staSafetyContact").value.trim(),
      safetyPhone: $("staSafetyPhone").value.trim()
    };
  }

  function safeFilenamePart(value, fallback) {
    const cleaned = String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
    return cleaned || fallback;
  }

  function buildStaFilename(trip, values) {
    const context = trip || {};
    const isoDate = String(values.date || context.date || "")
      .replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2");
    const datePart = safeFilenamePart(isoDate, new Date().toISOString().slice(0, 10));
    const vendorPart = safeFilenamePart(context.vendor || values.taskLocation, "Facility");
    const projectPart = values.projectNumber ? `_${safeFilenamePart(values.projectNumber, "Project")}` : "";
    return `STA_${datePart}_${vendorPart}${projectPart}.pdf`;
  }

  async function loadStaMasterBytes() {
    if (staMasterBytesPromise) return staMasterBytesPromise;

    staMasterBytesPromise = (async () => {
      const record = await readPrivateStaMasterRecord();
      if (!record?.bytes) {
        throw new Error(
          "No private STA master is installed. Open Create STA and tap Import STA Master."
        );
      }
      return new Uint8Array(record.bytes.slice(0));
    })();

    try {
      return await staMasterBytesPromise;
    } catch (error) {
      staMasterBytesPromise = null;
      throw error;
    }
  }

  async function createFlattenedStaPdf(trip, values) {
    if (!window.PDFLib?.PDFDocument) {
      throw new Error("The PDF generator library did not load.");
    }

    const sourceBytes = await loadStaMasterBytes();
    const pdfDoc = await window.PDFLib.PDFDocument.load(sourceBytes, {
      ignoreEncryption: false,
      updateMetadata: false
    });
    const form = pdfDoc.getForm();
    const font = await pdfDoc.embedFont(window.PDFLib.StandardFonts.Helvetica);

    const fieldValues = {
      "Box 1": values.projectNumber,
      "Box 4": values.projectNumber,
      "Box 5": values.date,
      "Box 6": values.time,
      "Box 8": values.taskLocation,
      "Box 16": values.safetyContact,
      "Box 17": values.safetyPhone
    };

    for (const [fieldName, value] of Object.entries(fieldValues)) {
      const field = form.getTextField(fieldName);
      field.setText(String(value || ""));
    }

    form.updateFieldAppearances(font);
    form.flatten();

    pdfDoc.setTitle("Safety Task Analysis");
    pdfDoc.setSubject(`STA for ${(trip && trip.vendor) || values.taskLocation || "facility"}`);
    pdfDoc.setCreator("Mileage Logger Web App");
    pdfDoc.setProducer("pdf-lib");

    return pdfDoc.save({ useObjectStreams: true });
  }

  function saveStaRecord(trip, values, filename) {
    if (!trip) return;
    trip.staGenerated = true;
    trip.staFileName = filename;
    trip.staData = { ...values };
    trip.staGeneratedISO = new Date().toISOString();
    saveState();
    renderAll();
  }

  function downloadBytes(filename, bytes) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function generateSta(mode) {
    const trip = getStaContextTrip();
    const values = getStaValues();
    const filename = buildStaFilename(trip, values);
    const status = $("staStatus");
    const buttons = [$("shareStaBtn"), $("downloadStaBtn")];

    buttons.forEach((button) => { button.disabled = true; });
    status.textContent = "Generating a flattened STA PDF from the locked master…";
    status.className = "gps-status";

    try {
      const bytes = await createFlattenedStaPdf(trip, values);
      saveStaRecord(trip, values, filename);

      if (mode === "share") {
        const file = new File([bytes], filename, { type: "application/pdf" });
        if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
          try {
            await navigator.share({
              title: filename,
              text: "Flattened Safety Task Analysis PDF",
              files: [file]
            });
            status.textContent = `Generated and shared ${filename}.`;
            status.className = "gps-status good";
            showToast("STA PDF generated and shared.");
            return;
          } catch (shareError) {
            if (shareError?.name === "AbortError") {
              status.textContent = `STA generated. Sharing was canceled. Use Download STA PDF to save it.`;
              status.className = "gps-status warn";
              return;
            }
          }
        }
      }

      downloadBytes(filename, bytes);
      status.textContent = `Generated ${filename}.`;
      status.className = "gps-status good";
      showToast("Flattened STA PDF generated.");
    } catch (error) {
      console.error("STA generation failed:", error);
      status.textContent = `STA generation failed: ${error.message}`;
      status.className = "gps-status bad";
      window.alert(`The STA PDF could not be generated.\n\n${error.message}`);
    } finally {
      await refreshPrivateStaMasterStatus();
    }
  }

  function renderShortcutExamples() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    $("startLinkExample").textContent = `${url.toString()}?action=start`;
    $("endLinkExample").textContent = `${url.toString()}?action=end`;
    $("logLinkExample").textContent = `${url.toString()}?action=log`;
    $("staLinkExample").textContent = `${url.toString()}?action=sta`;
  }

  function handleActionParameter() {
    const action = new URLSearchParams(window.location.search).get("action");
    if (action === "start") showSection("startSection", false);
    if (action === "end") showSection("endSection", false);
    if (action === "log") showSection("logSection", false);
    if (action === "sta") showSection("staSection", false);
  }

  function renderSecureWarning() {
    const isSecure = window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    $("secureWarning").classList.toggle("hidden", isSecure);
  }

  function renderAll() {
    ensureBackupState();
    renderSettings();
    renderDatalists();
    renderStatus();
    renderBackupStatus();
    renderLog();
    renderShortcutExamples();
    renderSecureWarning();
  }

  $("startBtn").addEventListener("click", () => showSection("startSection"));
  $("endBtn").addEventListener("click", () => showSection("endSection"));
  $("staBtn").addEventListener("click", () => {
    staContextTripId = state.activeTrip?.id || null;
    showSection("staSection");
  });
  $("logBtn").addEventListener("click", () => showSection("logSection"));
  $("exportBtn").addEventListener("click", exportCSV);
  $("exportBtn2").addEventListener("click", exportCSV);

  document.querySelectorAll("[data-show]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.show;
      if (id === "settingsSection") {
        $(id).scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        showSection(id);
      }
    });
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => {
      $(button.dataset.close).classList.add("hidden");
    });
  });

  $("captureStartGpsBtn").addEventListener("click", () => captureStartGps(true));
  $("captureEndGpsBtn").addEventListener("click", () => captureEndGps(true));

  $("startForm").addEventListener("submit", (event) => {
    event.preventDefault();

    if (!requireBackupBeforeNewTrip()) return;

    if (state.activeTrip) {
      window.alert("A trip is already active. End it before starting another trip.");
      return;
    }

    const startOdometer = parseOdometer($("startOdo").value);
    if (!Number.isFinite(startOdometer) || startOdometer < 0) {
      window.alert("Enter a valid starting odometer.");
      $("startOdo").focus();
      return;
    }

    const projectNumber = $("projectNumber").value.trim();
    const customer = $("customer").value.trim();
    const vendor = $("vendor").value.trim();
    const purpose = $("purpose").value.trim();

    if (!customer || !vendor || !purpose) {
      window.alert("Customer, vendor or destination, and purpose are required.");
      return;
    }

    const now = getNow();
    const trackRoute = $("trackRoute").checked;

    state.activeTrip = {
      id: makeId(),
      startISO: now.iso,
      date: now.date,
      startTime: now.time,
      startOdometer,
      projectNumber,
      customer,
      vendor,
      purpose,
      notes: $("startNotes").value.trim(),
      startLocation: pendingStartLocation,
      trackRoute,
      routePoints: pendingStartLocation ? [pendingStartLocation] : []
    };

    state.settings.customers = [...new Set([...state.settings.customers, customer])];
    state.settings.vendors = [...new Set([...state.settings.vendors, vendor])];
    state.settings.purposes = [...new Set([...state.settings.purposes, purpose])];

    saveState();
    renderAll();
    hidePrimaryPanels();

    if (trackRoute) startRouteTracking();
    showToast("Mileage trip started.");
  });

  $("endOdo").addEventListener("input", calculateMilesPreview);

  $("endForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!state.activeTrip) {
      window.alert("There is no active trip to end.");
      return;
    }

    const endOdometer = parseOdometer($("endOdo").value);
    if (!Number.isFinite(endOdometer) || endOdometer < 0) {
      window.alert("Enter a valid ending odometer.");
      $("endOdo").focus();
      return;
    }

    const startOdometer = Number(state.activeTrip.startOdometer);
    if (endOdometer < startOdometer) {
      window.alert("Ending odometer cannot be lower than starting odometer.");
      $("endOdo").focus();
      return;
    }

    let miles = endOdometer - startOdometer;
    if (state.settings.roundMiles) {
      miles = Math.round(miles * 10) / 10;
    }

    stopRouteTracking(false);

    const now = getNow();
    const combinedNotes = [
      state.activeTrip.notes,
      $("endNotes").value.trim()
    ].filter(Boolean).join(" | ");

    const routePoints = Array.isArray(state.activeTrip.routePoints)
      ? state.activeTrip.routePoints
      : [];

    if (pendingEndLocation) {
      const last = routePoints[routePoints.length - 1];
      if (!last || haversineMiles(last, pendingEndLocation) > 0.003) {
        routePoints.push(pendingEndLocation);
      }
    }

    const gpsRouteMiles = calculateRouteMiles(routePoints);
    const directGpsMiles = state.activeTrip.startLocation && pendingEndLocation
      ? haversineMiles(state.activeTrip.startLocation, pendingEndLocation)
      : 0;

    const completedTrip = {
      ...state.activeTrip,
      endISO: now.iso,
      endTime: now.time,
      endOdometer,
      miles,
      notes: combinedNotes,
      endLocation: pendingEndLocation,
      routePoints,
      gpsRouteMiles: gpsRouteMiles > 0.05 ? gpsRouteMiles : 0,
      directGpsMiles
    };

    state.trips.push(completedTrip);
    state.lastOdometer = endOdometer;
    state.activeTrip = null;
    pendingEndLocation = null;

    ensureBackupState();
    state.backup.pendingTripCount += 1;
    state.backup.lastRequiredISO = now.iso;

    saveState();
    renderAll();
    hidePrimaryPanels();

    const difference = completedTrip.gpsRouteMiles > 0
      ? Math.abs(Number(miles) - Number(completedTrip.gpsRouteMiles))
      : 0;

    showToast(
      difference >= Number(state.settings.differenceWarning)
        ? `Trip saved locally. GPS difference: ${formatNumber(difference, true)} miles. Opening required backup…`
        : `Trip saved locally: ${formatNumber(miles, true)} miles. Opening required backup…`
    );

    const backupConfirmed = await saveFullBackupToFiles({ automatic: true });

    if (window.MileageInspectionDatabase?.promptForTrip) {
      window.MileageInspectionDatabase.promptForTrip(completedTrip.id, backupConfirmed);
    } else {
      window.dispatchEvent(new CustomEvent("mileage:trip-completed", {
        detail: {
          tripId: completedTrip.id,
          backupConfirmed
        }
      }));
    }
  });

  $("activeDetails").addEventListener("click", (event) => {
    if (event.target.closest("#createStaBtn")) {
      staContextTripId = state.activeTrip?.id || null;
      showSection("staSection");
      return;
    }

    if (event.target.closest("#resumeRouteBtn")) {
      startRouteTracking();
      showToast("Route GPS resumed.");
    }

    if (event.target.closest("#pauseRouteBtn")) {
      stopRouteTracking(true);
    }
  });

  $("searchBox").addEventListener("input", renderLog);
  $("clearSearch").addEventListener("click", () => {
    $("searchBox").value = "";
    renderLog();
  });

  $("tripTable").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-trip]");
    if (!button) return;

    const id = button.dataset.deleteTrip;
    const trip = state.trips.find((item) => item.id === id);
    if (!trip) return;

    const confirmed = window.confirm(`Delete the ${trip.date} trip to ${trip.vendor}? This cannot be undone.`);
    if (!confirmed) return;

    state.trips = state.trips.filter((item) => item.id !== id);
    saveState();
    renderAll();
    showToast("Trip deleted.");
  });

  $("tripTable").addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-sta]");
    if (!button) return;
    staContextTripId = button.dataset.openSta;
    showSection("staSection");
  });

  $("backupNowBtn").addEventListener("click", backupData);
  $("backupCsvBtn").addEventListener("click", exportCSV);
  $("restoreBackupBtn").addEventListener("click", () => $("importFile").click());
  $("backupBtn").addEventListener("click", backupData);
  $("importBtn").addEventListener("click", () => $("importFile").click());

  $("importFile").addEventListener("change", () => {
    const file = $("importFile").files[0];
    if (file) importBackupFile(file);
    $("importFile").value = "";
  });

  $("saveSettingsBtn").addEventListener("click", () => {
    const maxAccuracy = parseNumber($("maxGpsAccuracy").value);
    const warning = parseNumber($("differenceWarning").value);

    state.settings.roundMiles = $("roundMiles").checked;
    state.settings.autoCaptureGps = $("autoCaptureGps").checked;
    state.settings.maxGpsAccuracy = Number.isFinite(maxAccuracy) && maxAccuracy > 0 ? maxAccuracy : 100;
    state.settings.differenceWarning = Number.isFinite(warning) && warning >= 0 ? warning : 3;
    state.settings.customers = normalizeList($("savedCustomers").value);
    state.settings.vendors = normalizeList($("savedVendors").value);
    state.settings.purposes = normalizeList($("savedPurposes").value);

    saveState();
    renderAll();
    showToast("Settings saved.");
  });

  $("useCurrentVendorGpsBtn").addEventListener("click", () => {
    captureCurrentLocation(
      $("useCurrentVendorGpsBtn"),
      $("vendorGpsStatus"),
      (location) => {
        pendingVendorGps = location;
        $("vendorLatitude").value = Number(location.latitude).toFixed(6);
        $("vendorLongitude").value = Number(location.longitude).toFixed(6);
        $("vendorGpsStatus").textContent = `Captured ${locationSummary(location)}`;
        $("vendorGpsStatus").className = `gps-status ${accuracyClass(location)}`;
        showToast("Current GPS inserted into vendor location fields.");
      },
      true
    );
  });

  $("saveVendorLocationBtn").addEventListener("click", () => {
    const name = $("vendorLocationName").value.trim();
    const taskLocation = $("vendorTaskLocation").value.trim();
    const safetyContact = $("vendorSafetyContact").value.trim();
    const safetyPhone = $("vendorSafetyPhone").value.trim();
    const latitude = parseNumber($("vendorLatitude").value);
    const longitude = parseNumber($("vendorLongitude").value);
    const radiusMiles = parseNumber($("vendorRadius").value);

    if (!name) {
      window.alert("Enter a vendor name.");
      return;
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      window.alert("Enter a valid latitude between -90 and 90.");
      return;
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      window.alert("Enter a valid longitude between -180 and 180.");
      return;
    }
    if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
      window.alert("Enter a recognition radius greater than zero.");
      return;
    }

    const existing = state.settings.vendorLocations.find(
      (item) => item.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      existing.taskLocation = taskLocation;
      existing.safetyContact = safetyContact;
      existing.safetyPhone = safetyPhone;
      existing.latitude = latitude;
      existing.longitude = longitude;
      existing.radiusMiles = radiusMiles;
    } else {
      state.settings.vendorLocations.push({
        id: makeId(),
        name,
        taskLocation,
        safetyContact,
        safetyPhone,
        latitude,
        longitude,
        radiusMiles
      });
    }

    if (!state.settings.vendors.includes(name)) {
      state.settings.vendors.push(name);
    }

    saveState();
    $("vendorLocationName").value = "";
    $("vendorTaskLocation").value = "";
    $("vendorSafetyContact").value = "";
    $("vendorSafetyPhone").value = "";
    $("vendorLatitude").value = "";
    $("vendorLongitude").value = "";
    $("vendorRadius").value = "0.5";
    pendingVendorGps = null;
    $("vendorGpsStatus").textContent = "No vendor GPS captured.";
    $("vendorGpsStatus").className = "gps-status";
    renderAll();
    showToast("Facility profile saved.");
  });

  $("vendorLocationsList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-vendor-location]");
    if (!button) return;

    const id = button.dataset.deleteVendorLocation;
    state.settings.vendorLocations = state.settings.vendorLocations.filter((item) => item.id !== id);
    saveState();
    renderAll();
    showToast("Facility profile removed.");
  });

  $("importStaMasterBtn").addEventListener("click", () => {
    $("staMasterFileInput").click();
  });

  $("staMasterFileInput").addEventListener("change", async () => {
    const file = $("staMasterFileInput").files[0];
    $("staMasterFileInput").value = "";
    if (!file) return;

    const installStatus = $("staMasterInstallStatus");
    $("importStaMasterBtn").disabled = true;
    installStatus.textContent = "Validating and storing the STA master privately on this device…";
    installStatus.className = "private-master-status";

    try {
      await importPrivateStaMaster(file);
      await refreshPrivateStaMasterStatus();
      $("staStatus").textContent =
        "Private STA master installed. Review the fields and generate the flattened PDF.";
      $("staStatus").className = "gps-status good";
      showToast("Private STA master installed on this device.");
    } catch (error) {
      console.error("STA master import failed:", error);
      installStatus.textContent = `Import failed: ${error.message}`;
      installStatus.className = "private-master-status error";
      window.alert(`The STA master could not be imported.\n\n${error.message}`);
      await refreshPrivateStaMasterStatus();
    } finally {
      $("importStaMasterBtn").disabled = false;
    }
  });

  $("removeStaMasterBtn").addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Remove the privately stored STA master from this device? Mileage records will not be deleted."
    );
    if (!confirmed) return;

    try {
      await deletePrivateStaMasterRecord();
      staMasterBytesPromise = null;
      await refreshPrivateStaMasterStatus();
      $("staStatus").textContent =
        "The private STA master was removed. Import it again before generating another STA.";
      $("staStatus").className = "gps-status warn";
      showToast("Private STA master removed from this device.");
    } catch (error) {
      window.alert(`The private STA master could not be removed.\n\n${error.message}`);
    }
  });

  $("shareStaBtn").addEventListener("click", () => generateSta("share"));
  $("downloadStaBtn").addEventListener("click", () => generateSta("download"));

  $("resetDataBtn").addEventListener("click", () => {
    const first = window.confirm("Delete the active trip, all completed trips, GPS records, backup status, saved lists, and settings? The privately imported STA master will remain installed.");
    if (!first) return;

    const second = window.confirm("This cannot be undone unless you already exported a backup. Delete everything?");
    if (!second) return;

    stopRouteTracking(false);
    localStorage.removeItem(STORAGE_KEY);
    OLD_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    state = defaultState();
    renderAll();
    hidePrimaryPanels();
    showToast("All app data deleted.");
  });

  $("themeToggle").addEventListener("click", () => {
    state.settings.dark = !state.settings.dark;
    saveState();
    renderAll();
  });

  window.addEventListener("storage", () => {
    state = loadState();
    renderAll();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.activeTrip?.trackRoute && routeWatchId === null) {
      startRouteTracking();
    }
  });

  if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((error) => {
        console.warn("Service worker registration failed:", error);
      });
    });
  }

  renderAll();
  handleActionParameter();

  if (state.activeTrip?.trackRoute) {
    setTimeout(startRouteTracking, 400);
  }
})();
