let picklistItems = [];
const bodyEl = document.getElementById("picklistBody");
const wrapperEl = document.getElementById("tableWrapper");
const emptyMsgEl = document.getElementById("emptyMsg");
const statusBadgeEl = document.getElementById("statusBadge");
const markDoneBtn = document.getElementById("markDoneBtn");
const resetBtn = document.getElementById("resetBtn");

function loadState() {
  try {
    const raw = localStorage.getItem("picklist_state");
    if (!raw) {
      picklistItems = [];
      return;
    }
    picklistItems = JSON.parse(raw) || [];
  } catch (e) {
    console.error("Error parsing picklist_state:", e);
    picklistItems = [];
  }
}

function saveState() {
  localStorage.setItem("picklist_state", JSON.stringify(picklistItems));
}

function loadStatus() {
  try {
    const raw = localStorage.getItem("picklist_status");
    if (!raw) return { fulfilled: false };
    return JSON.parse(raw);
  } catch {
    return { fulfilled: false };
  }
}

function saveStatus(statusObj) {
  localStorage.setItem("picklist_status", JSON.stringify(statusObj));
}

function calcOverallStatus() {
  if (!picklistItems.length) return "No Data";

  const remainingTotal = picklistItems.reduce(
    (sum, r) => sum + (Number(r.remaining) || 0),
    0
  );

  if (remainingTotal === 0) return "All Picked";
  const pickedSome = picklistItems.some(
    (r) => Number(r.pickedQty) > 0 && Number(r.remaining) > 0
  );
  return pickedSome ? "Partial" : "Pending";
}

function render() {
  loadState(); // always sync with localStorage

  if (!picklistItems.length) {
    wrapperEl.style.display = "none";
    emptyMsgEl.style.display = "block";
    statusBadgeEl.textContent = "No picklist found";
    statusBadgeEl.style.background = "#fed7d7";
    statusBadgeEl.style.color = "#c53030";
    return;
  }

  wrapperEl.style.display = "block";
  emptyMsgEl.style.display = "none";

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
      <td>${index + 1}</td>
      <td style="font-weight:500;">${row.sku}</td>
      <td style="max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${row.product || ""}">
        ${row.product || ""}
      </td>
      <td>${required}</td>
      <td>
        <input
          type="number"
          min="0"
          data-index="${index}"
          value="${picked}"
        />
      </td>
      <td>${remaining}</td>
      <td style="color:${color}; font-weight:500;">${status}</td>
    `;

    bodyEl.appendChild(tr);
  });

  // bind inputs
  bodyEl.querySelectorAll("input[type=number]").forEach((input) => {
    input.addEventListener("change", onPickedChange);
  });

  // update badge
  const overall = calcOverallStatus();
  const statusObj = loadStatus();

  let badgeText = overall;
  if (statusObj.fulfilled) {
    badgeText = overall === "All Picked" ? "Fulfilled" : "Fulfilled (manual)";
  }

  statusBadgeEl.textContent = badgeText;

  if (statusObj.fulfilled || overall === "All Picked") {
    statusBadgeEl.style.background = "#c6f6d5";
    statusBadgeEl.style.color = "#2f855a";
  } else if (overall === "Partial") {
    statusBadgeEl.style.background = "#feebc8";
    statusBadgeEl.style.color = "#dd6b20";
  } else {
    statusBadgeEl.style.background = "#edf2f7";
    statusBadgeEl.style.color = "#4a5568";
  }
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

  saveState();
  render();
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

  saveStatus({ fulfilled: true, fulfilledAt: Date.now() });
  alert("Picklist marked as fulfilled.");
  render();
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
  saveState();
  saveStatus({ fulfilled: false });
  render();
});

// initial load
loadState();
render();
