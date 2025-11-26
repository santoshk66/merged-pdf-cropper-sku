let allPicklists = [];
let activePicklist = null;
let picklistItems = [];
let picklistId = null;

const picklistListEl = document.getElementById("picklistList");
const dateFilterEl = document.getElementById("dateFilter");
const statusFilterEl = document.getElementById("statusFilter");

const bodyEl = document.getElementById("picklistBody");
const wrapperEl = document.getElementById("tableWrapper");
const emptyMsgEl = document.getElementById("emptyMsg");
const loadingMsgEl = document.getElementById("loadingMsg");
const statusBadgeEl = document.getElementById("statusBadge");
const picklistIdLabelEl = document.getElementById("picklistIdLabel");
const markDoneBtn = document.getElementById("markDoneBtn");
const resetBtn = document.getElementById("resetBtn");

function setStatusBadge(text, bg, color) {
  statusBadgeEl.textContent = text;
  statusBadgeEl.style.background = bg;
  statusBadgeEl.style.color = color;
}

function calcOverallStatus(items) {
  if (!items.length) return "No Data";

  const remainingTotal = items.reduce(
    (sum, r) => sum + (Number(r.remaining) || 0),
    0
  );

  if (remainingTotal === 0) return "All Picked";
  const pickedSome = items.some(
    (r) => Number(r.pickedQty) > 0 && Number(r.remaining) > 0
  );
  return pickedSome ? "Partial" : "Pending";
}

// ---------- Date range helper ----------
function getRangeForFilter(key) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  );

  if (key === "today") {
    return { from: todayStart.getTime(), to: todayEnd.getTime() };
  }

  if (key === "yesterday") {
    const yStart = new Date(todayStart);
    yStart.setDate(yStart.getDate() - 1);
    const yEnd = new Date(todayEnd);
    yEnd.setDate(yEnd.getDate() - 1);
    return { from: yStart.getTime(), to: yEnd.getTime() };
  }

  if (key === "last7") {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - 6); // today + last 6 days
    return { from: start.getTime(), to: todayEnd.getTime() };
  }

  if (key === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: start.getTime(), to: todayEnd.getTime() };
  }

  // "all" -> no range filter
  return { from: null, to: null };
}

// ---------- Load picklists ----------
async function loadPicklists() {
  activePicklist = null;
  picklistItems = [];
  picklistId = null;
  allPicklists = [];

  picklistIdLabelEl.textContent = "Loading picklists...";
  setStatusBadge("Loading...", "#edf2f7", "#4a5568");
  wrapperEl.style.display = "none";
  emptyMsgEl.style.display = "none";
  loadingMsgEl.style.display = "block";

  const dateKey = dateFilterEl.value;
  const { from, to } = getRangeForFilter(dateKey);

  try {
    const params = new URLSearchParams();
    if (from) params.append("from", String(from));
    if (to) params.append("to", String(to));

    const url = "/picklists" + (params.toString() ? `?${params}` : "");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error("Server returned " + res.status);
    }

    const data = await res.json();
    allPicklists = Array.isArray(data) ? data : [];

    if (!allPicklists.length) {
      picklistListEl.innerHTML =
        '<div class="empty-list">No picklists found for selected date range.</div>';
      loadingMsgEl.style.display = "none";
      emptyMsgEl.style.display = "block";
      wrapperEl.style.display = "none";
      picklistIdLabelEl.textContent = "No picklist selected.";
      setStatusBadge("No picklists", "#fed7d7", "#c53030");
      return;
    }

    // Pick first picklist (after status filter) as active
    const filtered = filterPicklistsByStatus(allPicklists, statusFilterEl.value);
    if (filtered.length) {
      setActivePicklist(filtered[0], false);
    } else {
      setActivePicklist(allPicklists[0], false);
    }

    renderPicklistList();
    loadingMsgEl.style.display = "none";
  } catch (err) {
    console.error("Error loading picklists:", err);
    loadingMsgEl.style.display = "none";
    emptyMsgEl.style.display = "block";
    emptyMsgEl.textContent =
      "Failed to load picklists from server. Try a different filter or generate a new picklist.";
    wrapperEl.style.display = "none";
    picklistListEl.innerHTML =
      '<div class="empty-list">Error loading picklists.</div>';
    picklistIdLabelEl.textContent = "No picklist selected.";
    setStatusBadge("Error", "#fed7d7", "#c53030");
  }
}

// ---------- Status filter helper ----------
function filterPicklistsByStatus(list, statusFilter) {
  if (statusFilter === "open") {
    return list.filter((pl) => {
      const s = (pl.status || "").toLowerCase();
      return s !== "fulfilled";
    });
  }
  if (statusFilter === "fulfilled") {
    return list.filter(
      (pl) => (pl.status || "").toLowerCase() === "fulfilled"
    );
  }
  return list;
}

// ---------- Render picklist list (left sidebar) ----------
function renderPicklistList() {
  picklistListEl.innerHTML = "";

  if (!allPicklists.length) {
    picklistListEl.innerHTML =
      '<div class="empty-list">No picklists available.</div>';
    return;
  }

  const statusFilter = statusFilterEl.value;
  let list = filterPicklistsByStatus(allPicklists, statusFilter);

  list.sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );

  if (!list.length) {
    picklistListEl.innerHTML =
      '<div class="empty-list">No picklists for selected status.</div>';
    // if current active is not valid under this status filter, clear details
    if (
      !activePicklist ||
      !allPicklists.some((pl) => pl.picklistId === picklistId)
    ) {
      clearDetail();
    }
    return;
  }

  // If active picklist is not in this filtered list, switch to first
  if (!activePicklist || !list.some((pl) => pl.picklistId === picklistId)) {
    setActivePicklist(list[0], false);
  }

  list.forEach((pl) => {
    const card = document.createElement("div");
    card.className = "picklist-card" + (pl.picklistId === picklistId ? " active" : "");
    card.dataset.id = pl.picklistId;

    const createdAt = pl.createdAt ? new Date(pl.createdAt) : null;
    const timeStr = createdAt
      ? createdAt.toLocaleString([], { dateStyle: "short", timeStyle: "short" })
      : "-";

    const status = (pl.status || "pending").toLowerCase();
    let statusLabel = pl.status || "Pending";
    let statusClass = "pl-status-badge";

    if (status === "fulfilled") {
      statusLabel = "Fulfilled";
      statusClass += " pl-status-fulfilled";
    } else if (status === "pending" || status === "all picked" || status === "partial") {
      statusClass += " pl-status-open";
    }

    const totalUnits = pl.totalUnits ?? (Array.isArray(pl.items)
      ? pl.items.reduce((sum, it) => sum + (Number(it.requiredQty) || 0), 0)
      : 0);
    const totalSkus = pl.totalSkus ?? (Array.isArray(pl.items) ? pl.items.length : 0);

    card.innerHTML = `
      <div class="pl-row-1">
        <span class="pl-time">${timeStr}</span>
        <span class="${statusClass}">${statusLabel}</span>
      </div>
      <div class="pl-row-2">${pl.picklistId || ""}</div>
      <div class="pl-row-3">
        SKUs: ${totalSkus} &nbsp;•&nbsp; Units: ${totalUnits}
      </div>
    `;

    card.addEventListener("click", () => {
      setActivePicklist(pl);
    });

    picklistListEl.appendChild(card);
  });
}

// ---------- Clear detail panel ----------
function clearDetail() {
  picklistId = null;
  picklistItems = [];
  activePicklist = null;
  picklistIdLabelEl.textContent = "No picklist selected.";
  setStatusBadge("–", "#edf2f7", "#4a5568");
  wrapperEl.style.display = "none";
  emptyMsgEl.style.display = "block";
  emptyMsgEl.textContent = "Select a picklist from the left.";
}

// ---------- Set active picklist ----------
function setActivePicklist(pl, rerenderList = true) {
  if (!pl) {
    clearDetail();
    return;
  }

  activePicklist = pl;
  picklistId = pl.picklistId;

  // Sort items by requiredQty DESC (big → small)
  picklistItems = (pl.items || [])
    .map((row) => ({
      sku: row.sku,
      product: row.product || "",
      requiredQty: Number(row.requiredQty) || 0,
      pickedQty: Number(row.pickedQty) || 0,
      remaining:
        row.remaining != null
          ? Number(row.remaining)
          : (Number(row.requiredQty) || 0) - (Number(row.pickedQty) || 0),
    }))
    .sort((a, b) => {
      const diff = (b.requiredQty || 0) - (a.requiredQty || 0);
      if (diff !== 0) return diff;
      return (a.sku || "").localeCompare(b.sku || "");
    });

  const createdAt = pl.createdAt ? new Date(pl.createdAt) : null;
  const dateStr = createdAt
    ? createdAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "-";

  const totalUnits = pl.totalUnits ?? picklistItems.reduce(
    (sum, it) => sum + (Number(it.requiredQty) || 0),
    0
  );
  const totalSkus = pl.totalSkus ?? picklistItems.length;

  picklistIdLabelEl.textContent = picklistId
    ? `Picklist ID: ${picklistId} • Created: ${dateStr} • SKUs: ${totalSkus} • Units: ${totalUnits}`
    : "Picklist";

  renderTable();

  if (rerenderList) {
    renderPicklistList();
  }

  loadingMsgEl.style.display = "none";
  emptyMsgEl.style.display = picklistItems.length ? "none" : "block";
  wrapperEl.style.display = picklistItems.length ? "block" : "none";
}

// ---------- Render table ----------
function renderTable() {
  bodyEl.innerHTML = "";

  picklistItems.forEach((row, index) => {
    const tr = document.createElement("tr");

    const remaining = Number(row.remaining) || 0;
    const picked = Number(row.pickedQty) || 0;
    const required = Number(row.requiredQty) || 0;

    let status = "Pending";
    let color = "#718096";

    if (remaining <= 0 && required > 0) {
      status = "Done";
      color = "#38a169";
    } else if (picked > 0 && remaining > 0) {
      status = "Partial";
      color = "#dd6b20";
    }

    tr.innerHTML = `
      <td data-label="S.No">${index + 1}</td>
      <td data-label="SKU" style="font-weight:500;">${row.sku}</td>
      <td data-label="Product" style="max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${row.product}">
        ${row.product}
      </td>
      <td data-label="Required">${required}</td>
      <td data-label="Picked">
        <input
          type="number"
          min="0"
          data-index="${index}"
          value="${picked}"
        />
      </td>
      <td data-label="Remaining">${remaining}</td>
      <td data-label="Status" style="color:${color}; font-weight:500;">${status}</td>
    `;

    bodyEl.appendChild(tr);
  });

  bodyEl.querySelectorAll("input[type=number]").forEach((input) => {
    input.addEventListener("change", onPickedChange);
  });

  const overall = calcOverallStatus(picklistItems);
  let bg = "#edf2f7";
  let color = "#4a5568";

  if (overall === "All Picked") {
    bg = "#c6f6d5";
    color = "#2f855a";
  } else if (overall === "Partial") {
    bg = "#feebc8";
    color = "#dd6b20";
  }

  setStatusBadge(overall, bg, color);
}

// ---------- Picked qty change ----------
function onPickedChange(e) {
  const idx = Number(e.target.getAttribute("data-index"));
  if (Number.isNaN(idx) || !picklistItems[idx]) return;

  let val = Number(e.target.value);
  if (Number.isNaN(val) || val < 0) val = 0;

  const row = picklistItems[idx];
  const required = Number(row.requiredQty) || 0;

  if (val > required) {
    val = required;
    e.target.value = val;
  }

  row.pickedQty = val;
  row.remaining = required - val;

  savePicklistToServer();
}

// ---------- Save to server ----------
async function savePicklistToServer(statusOverride) {
  if (!picklistId) return;

  const status = statusOverride || calcOverallStatus(picklistItems);

  try {
    await fetch(`/picklist/${picklistId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: picklistItems,
        status,
      }),
    });

    // Update in-memory active & list
    if (activePicklist) {
      activePicklist.items = picklistItems;
      activePicklist.status = status;
    }
    const idx = allPicklists.findIndex((pl) => pl.picklistId === picklistId);
    if (idx !== -1) {
      allPicklists[idx].items = picklistItems;
      allPicklists[idx].status = status;
    }

    renderTable();
    renderPicklistList();
  } catch (err) {
    console.error("Error saving picklist:", err);
  }
}

// ---------- Buttons ----------
markDoneBtn.addEventListener("click", () => {
  if (!picklistItems.length) {
    alert("No picklist loaded.");
    return;
  }

  const remainingTotal = picklistItems.reduce(
    (sum, r) => sum + (Number(r.remaining) || 0),
    0
  );

  if (remainingTotal > 0) {
    const ok = confirm(
      `There are still ${remainingTotal} units remaining.\n` +
        `Do you still want to mark this picklist as Fulfilled (closed)?`
    );
    if (!ok) return;
  }

  // Close picklist (Fulfilled) but keep it stored
  savePicklistToServer("Fulfilled");
  alert("Picklist marked as Fulfilled. You can still open it from the list anytime.");
});

resetBtn.addEventListener("click", () => {
  if (!picklistItems.length) return;
  const ok = confirm("Reset picked quantities to 0 for this picklist?");
  if (!ok) return;

  picklistItems = picklistItems.map((r) => ({
    ...r,
    pickedQty: 0,
    remaining: Number(r.requiredQty) || 0,
  }));
  savePicklistToServer("Pending");
});

// ---------- Filter events ----------
dateFilterEl.addEventListener("change", () => {
  loadPicklists();
});

statusFilterEl.addEventListener("change", () => {
  renderPicklistList();
});

// ---------- Initial load ----------
loadPicklists();
