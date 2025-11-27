// public/office-picklist.js

let allTasks = [];
let filteredTasks = [];

const statusFilterEl = document.getElementById("statusFilter");
const dateFilterEl = document.getElementById("dateFilter");

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

  // "all"
  return { from: null, to: null };
}

// ---------- Fetch tasks from server ----------
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

// ---------- Apply date + status filters ----------
function applyFilterAndRender() {
  const statusFilter = statusFilterEl.value;
  const dateKey = dateFilterEl.value;
  const { from, to } = getRangeForFilter(dateKey);

  let list = [...allTasks];

  // Date filter (uses createdAt, or assignedAt/updatedAt backup)
  if (from && to) {
    list = list.filter((t) => {
      const ts =
        t.createdAt ||
        t.assignedAt ||
        t.updatedAt ||
        null;
      if (!ts) return false;
      const tNum = Number(ts);
      return tNum >= from && tNum <= to;
    });
  }

  // Status filter
  if (statusFilter === "pending") {
    list = list.filter(
      (t) => (t.status || "pending").toLowerCase() === "pending"
    );
  } else if (statusFilter === "in-progress") {
    list = list.filter((t) => {
      const s = (t.status || "").toLowerCase();
      return s === "in-progress" || s === "inprogress";
    });
  } else if (statusFilter === "completed") {
    list = list.filter((t) => {
      const s = (t.status || "").toLowerCase();
      return s === "completed" || s === "complete" || s === "done";
    });
  }

  const statusOrder = {
    pending: 0,
    "in-progress": 1,
    inprogress: 1,
    completed: 2,
    complete: 2,
    done: 2,
  };

  list.sort((a, b) => {
    const sa = statusOrder[(a.status || "pending").toLowerCase()] ?? 0;
    const sb = statusOrder[(b.status || "pending").toLowerCase()] ?? 0;
    if (sa !== sb) return sa - sb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  }).reverse(); // newest first

  filteredTasks = list;
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
    showEmpty(true, "No tasks for selected filters.");
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

  taskBodyEl.querySelectorAll("input[type=number]").forEach((input) => {
    input.addEventListener("change", onPickedChange);
  });

  taskBodyEl.querySelectorAll("button[data-complete-id]").forEach((btn) => {
    btn.addEventListener("click", onMarkDoneClick);
  });
}

// ---------- Picked qty change ----------
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
      fulfilledQty: val,       // keep backend happy
      remaining,
      status: newStatus,
    });

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
      fulfilledQty: assigned,
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
  } catch (e) {}

  if (!res.ok) {
    console.error("Update error response:", data);
    throw new Error(data.error || `Update failed with status ${res.status}`);
  }

  return data;
}

// ---------- Auto-refresh ----------
function startAutoRefresh() {
  setInterval(() => {
    loadTasksFromServer();
  }, 30000);
}

// ---------- Events ----------
statusFilterEl.addEventListener("change", () => {
  applyFilterAndRender();
});

dateFilterEl.addEventListener("change", () => {
  applyFilterAndRender();
});

// ---------- Initial load ----------
loadTasksFromServer();
startAutoRefresh();
