let picklistItems = [];
let picklistId = null;

const bodyEl = document.getElementById("picklistBody");
const wrapperEl = document.getElementById("tableWrapper");
const emptyMsgEl = document.getElementById("emptyMsg");
const loadingMsgEl = document.getElementById("loadingMsg");
const statusBadgeEl = document.getElementById("statusBadge");
const picklistIdLabelEl = document.getElementById("picklistIdLabel");
const markDoneBtn = document.getElementById("markDoneBtn");
const resetBtn = document.getElementById("resetBtn");

// manual id input
const manualRowEl = document.getElementById("manualLoadRow");
const manualFormEl = document.getElementById("manualPicklistForm");
const manualInputEl = document.getElementById("manualPicklistId");

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

// Get picklistId from URL ?picklistId= / ?id=, then localStorage
function resolvePicklistId() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("picklistId") || params.get("id");
  if (fromQuery) {
    localStorage.setItem("current_picklist_id", fromQuery);
    return fromQuery;
  }
  const stored = localStorage.getItem("current_picklist_id");
  if (stored) return stored;
  return null;
}

async function loadPicklistFromServer(idOverride) {
  picklistId = idOverride || resolvePicklistId();

  if (!picklistId) {
    // show manual input UI
    loadingMsgEl.style.display = "none";
    emptyMsgEl.style.display = "block";
    emptyMsgEl.textContent =
      "No picklist found in this browser. Enter a Picklist ID above.";
    manualRowEl.style.display = "block";
    setStatusBadge("No picklist ID in browser", "#fed7d7", "#c53030");
    return;
  }

  picklistIdLabelEl.textContent = `Picklist ID: ${picklistId}`;
  manualRowEl.style.display = "block"; // keep visible so user can change ID if needed

  try {
    const res = await fetch(`/picklist/${picklistId}`);
    if (!res.ok) {
      throw new Error("Server returned " + res.status);
    }
    const data = await res.json();

    picklistItems = (data.items || []).map((row) => ({
      sku: row.sku,
      product: row.product || "",
      requiredQty: Number(row.requiredQty) || 0,
      pickedQty: Number(row.pickedQty) || 0,
      remaining:
        row.remaining != null
          ? Number(row.remaining)
          : (Number(row.requiredQty) || 0) - (Number(row.pickedQty) || 0),
    }));

    if (!picklistItems.length) {
      loadingMsgEl.style.display = "none";
      emptyMsgEl.style.display = "block";
      emptyMsgEl.textContent = "This picklist has no items.";
      wrapperEl.style.display = "none";
      setStatusBadge("Empty picklist", "#fed7d7", "#c53030");
      return;
    }

    loadingMsgEl.style.display = "none";
    emptyMsgEl.style.display = "none";
    wrapperEl.style.display = "block";
    renderTable();
  } catch (err) {
    console.error("Error loading picklist:", err);
    loadingMsgEl.style.display = "none";
    emptyMsgEl.style.display = "block";
    emptyMsgEl.textContent =
      "Failed to load picklist from server. Check the ID or try again.";
    wrapperEl.style.display = "none";
    setStatusBadge("Error loading picklist", "#fed7d7", "#c53030");
  }
}

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

  // Inputs
  bodyEl.querySelectorAll("input[type=number]").forEach((input) => {
    input.addEventListener("change", onPickedChange);
  });

  // Update status badge
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

  // Save immediately
  savePicklistToServer();
}

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

    // mirror to localStorage for quick reload on this device
    localStorage.setItem("picklist_state", JSON.stringify(picklistItems));

    renderTable();
  } catch (err) {
    console.error("Error saving picklist:", err);
  }
}

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
        `Do you still want to mark picklist as fulfilled?`
    );
    if (!ok) return;
  }

  savePicklistToServer("Fulfilled");
  alert("Picklist marked as fulfilled and saved to server.");
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

// manual ID form
if (manualFormEl) {
  manualFormEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = (manualInputEl.value || "").trim();
    if (!val) return;

    localStorage.setItem("current_picklist_id", val);

    // reset UI then load
    loadingMsgEl.style.display = "block";
    loadingMsgEl.textContent = "Loading picklist from server...";
    emptyMsgEl.style.display = "none";
    wrapperEl.style.display = "none";

    loadPicklistFromServer(val);
  });
}

// Initial load
loadPicklistFromServer();
