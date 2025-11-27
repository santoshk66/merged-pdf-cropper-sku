// public/office-picklist.js

let allTasks = [];
let filteredTasks = [];

const statusFilterEl = document.getElementById("statusFilter");
const taskBodyEl = document.getElementById("taskBody");
const tableWrapperEl = document.getElementById("tableWrapper");

const loadingMsgEl = document.getElementById("loadingMsg");
const emptyMsgEl = document.getElementById("emptyMsg");
const errorMsgEl = document.getElementById("errorMsg");
const statusSummaryEl = document.getElementById("statusSummary");

let isLoading = false;
let lastFetchTime = null;

// ---------- Helpers ----------
function showLoading(show) {
  isLoading = show;
  loadingMsgEl.style.display = show ? "block" : "none";
}

function showError(msg) {
  if (!msg) {
    errorMsgEl.style.display = "none";
    errorMsgEl.textContent = "";
    return;
  }
  errorMsgEl.style.display = "block";
  errorMsgEl.textContent = msg;
}

function showEmpty(show, textOverride) {
  if (show) {
    emptyMsgEl.style.display = "block";
    if (textOverride) emptyMsgEl.textContent = textOverride;
  } else {
    emptyMsgEl.style.display = "none";
  }
}

function formatStatusTag(status) {
  const s = (status || "pending").toLowerCase();
  if (s === "completed" || s === "complete" || s === "done") {
    return `<span class="tag tag-completed">Completed</span>`;
  }
  if (s === "in-progress" || s === "inprogress") {
    return `<span class="tag tag-inprogress">In-Progress</span>`;
  }
  return `<span class="tag tag-pending">Pending</span>`;
}

// ---------- Fetch tasks from server (NO status param) ----------
async function loadTasksFromServer() {
  if (isLoading) return;
  showError("");
  showEmpty(false);
  showLoading(true);

  try {
    const res = await fetch("/transfer-tasks");
    const data = await res.json();

    if (!res.ok) {
      const msg = data && data.error ? data.error : "Failed to list transfer tasks";
      throw new Error(msg);
    }

    // 🔑 Normalize ID field so we ALWAYS have task._id
    allTasks = (Array.isArray(data) ? data : []).map((t) => {
      const _id = t.id || t.taskId || t.transferId || t.docId || null;
      return { ...t, _id };
    });

    lastFetchTime = new Date();
    applyFilterAndRender();
  } catch (err) {
    console.error("Failed to load tasks:", err);
    showError("Failed to load tasks: " + (err.message || "Unknown error"));
    allTasks = [];
    filteredTasks = [];
    renderTable();
  } finally {
    showLoading(false);
  }
}

// ---------- Apply status filter (client-side) ----------
function applyFilterAndRender() {
  const statusFilter = statusFilterEl.value; // all / pending / in-progress / completed

  if (!allTasks.length) {
    filteredTasks = [];
    renderTable();
    return;
  }

  if (statusFilter === "all") {
    filteredTasks = [...allTasks];
  } else {
    filteredTasks = allTasks.filter((t) => {
      const st = (t.status || "pending").toLowerCase();
      if (statusFilter === "pending") {
        return st === "pending";
      }
      if (statusFilter === "in-progress") {
        return st === "in-progress" || st === "inprogress";
      }
      if (statusFilter === "completed") {
        return (
          st === "completed" ||
          st === "complete" ||
          st === "done"
        );
      }
      return true;
    });
  }

  // Sort: pending -> in-progress -> completed, then newest first
  const statusOrder = {
    pending: 0,
    "in-progress": 1,
    inprogress: 1,
    completed: 2,
    complete: 2,
    done: 2,
  };
  filteredTasks.sort((a, b) => {
    const sa = statusOrder[(a.status || "pending").toLowerCase()] ?? 0;
    const sb = statusOrder[(b.status || "pending").toLowerCase()] ?? 0;
    if (sa !== sb) return sa - sb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  renderTable();
}

// ---------- Render table ----------
function renderTable() {
  taskBodyEl.innerHTML = "";

  const total = allTasks.length;
  const visible = filteredTasks.length;

  if (!total) {
    tableWrapperEl.style.display = "none";
    showEmpty(true, "No transfer tasks found. Ask main office to assign some SKUs first.");
    statusSummaryEl.textContent = "No tasks loaded.";
    return;
  }

  if (!visible) {
    tableWrapperEl.style.display = "none";
    showEmpty(true, "No tasks for selected status.");
    statusSummaryEl.textContent = `Tasks loaded: ${total} total • 0 visible (filter applied).`;
    return;
  }

  tableWrapperEl.style.display = "block";
  showEmpty(false);

  const pendingCount = allTasks.filter(
    (t) => (t.status || "pending").toLowerCase() === "pending"
  ).length;
  const completedCount = allTasks.filter((t) => {
    const s = (t.status || "").toLowerCase();
    return s === "completed" || s === "complete" || s === "done";
  }).length;

  const lastFetchStr = lastFetchTime
    ? `Last updated: ${lastFetchTime.toLocaleTimeString()}`
    : "Just updated";

  statusSummaryEl.textContent = `${visible} tasks visible • ${pendingCount} pending • ${completedCount} completed • ${lastFetchStr}`;

  filteredTasks.forEach((task, index) => {
    const tr = document.createElement("tr");

    const assigned = Number(task.assignedQty) || 0;
    const picked = Number(task.pickedQty) || 0;
    const remaining =
      task.remaining != null
        ? Number(task.remaining)
        : Math.max(assigned - picked, 0);

    const assignee = task.assigneeName || task.assignee || "—";
    const sku = task.sku || "";
    const product = task.product || "";
    const sTag = formatStatusTag(task.status);

    tr.innerHTML = `
      <td data-label="S.No">${index + 1}</td>
      <td data-label="SKU" style="font-weight:500;">${sku}</td>
      <td data-label="Product" title="${product}" style="max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
        ${product}
      </td>
      <td data-label="Assigned">${assigned}</td>
      <td data-label="Picked">
        <input
          type="number"
          min="0"
          max="${assigned}"
          data-id="${task._id || ""}"
          data-index="${index}"
          value="${picked}"
        />
      </td>
      <td data-label="Remaining">${remaining}</td>
      <td data-label="Assignee">${assignee}</td>
      <td data-label="Task Status">${sTag}</td>
      <td data-label="Actions">
        <button
          type="button"
          class="action-btn btn-complete"
          data-complete-id="${task._id || ""}"
          data-complete-index="${index}"
        >
          Mark Done
        </button>
      </td>
    `;

    taskBodyEl.appendChild(tr);
  });

  // Attach listeners
  taskBodyEl.querySelectorAll("input[type=number]").forEach((input) => {
    input.addEventListener("change", onPickedChange);
  });

  taskBodyEl.querySelectorAll("button[data-complete-id]").forEach((btn) => {
    btn.addEventListener("click", onMarkDoneClick);
  });
}

// ---------- Update picked quantity ----------
async function onPickedChange(e) {
  const id = e.target.getAttribute("data-id");
  const localIndex = Number(e.target.getAttribute("data-index"));
  if (!id || Number.isNaN(localIndex) || !filteredTasks[localIndex]) {
    console.warn("Missing id or index on picked change", { id, localIndex });
    alert("Cannot update this row because task id is missing. Check API data.");
    return;
  }

  let val = Number(e.target.value);
  if (Number.isNaN(val) || val < 0) val = 0;

  const task = filteredTasks[localIndex];
  const assigned = Number(task.assignedQty) || 0;
  if (val > assigned) {
    val = assigned;
    e.target.value = val;
  }

  const remaining = Math.max(assigned - val, 0);
  const newStatus =
    remaining === 0 ? "completed" : val > 0 ? "in-progress" : "pending";

  try {
    await updateTaskOnServer(id, {
      pickedQty: val,
      remaining,
      status: newStatus,
    });

    // Update in memory
    task.pickedQty = val;
    task.remaining = remaining;
    task.status = newStatus;

    const global = allTasks.find((t) => t._id === task._id);
    if (global) {
      global.pickedQty = val;
      global.remaining = remaining;
      global.status = newStatus;
    }

    applyFilterAndRender();
  } catch (err) {
    console.error("Failed to update picked qty:", err);
    alert("Failed to update picked quantity: " + (err.message || "Unknown error"));
  }
}

// ---------- Mark task as done ----------
async function onMarkDoneClick(e) {
  const id = e.currentTarget.getAttribute("data-complete-id");
  const localIndex = Number(e.currentTarget.getAttribute("data-complete-index"));
  if (!id || Number.isNaN(localIndex) || !filteredTasks[localIndex]) {
    console.warn("Missing id or index on mark done", { id, localIndex });
    alert("Cannot complete this row because task id is missing. Check API data.");
    return;
  }

  const task = filteredTasks[localIndex];
  const assigned = Number(task.assignedQty) || 0;

  if (!assigned) {
    alert("Assigned quantity is 0. Nothing to complete.");
    return;
  }

  if (
    !confirm(
      `Mark this task as completed?\nSKU: ${task.sku}\nQty: ${assigned}`
    )
  ) {
    return;
  }

  try {
    await updateTaskOnServer(id, {
      pickedQty: assigned,
      remaining: 0,
      status: "completed",
    });

    task.pickedQty = assigned;
    task.remaining = 0;
    task.status = "completed";

    const global = allTasks.find((t) => t._id === task._id);
    if (global) {
      global.pickedQty = assigned;
      global.remaining = 0;
      global.status = "completed";
    }

    applyFilterAndRender();
  } catch (err) {
    console.error("Failed to mark task done:", err);
    alert("Failed to mark task as completed: " + (err.message || "Unknown error"));
  }
}

// ---------- Update task on server ----------
async function updateTaskOnServer(id, payload) {
  const url = `/transfer-tasks/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    // ignore JSON parse error
  }

  if (!res.ok) {
    console.error("Update error response:", data);
    throw new Error(data.error || `Update failed with status ${res.status}`);
  }

  return data;
}

// ---------- Auto-refresh (every 30s) ----------
function startAutoRefresh() {
  setInterval(() => {
    loadTasksFromServer();
  }, 30000);
}

// ---------- Events ----------
statusFilterEl.addEventListener("change", () => {
  applyFilterAndRender();
});

// ---------- Initial load ----------
loadTasksFromServer();
startAutoRefresh();
