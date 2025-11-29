function setPresetDate(preset) {
  const input = document.getElementById("dateInput");
  const today = new Date();

  if (preset === "today") {
    input.value = today.toISOString().slice(0, 10);
  } else if (preset === "yesterday") {
    const y = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    input.value = y.toISOString().slice(0, 10);
  }
}

function getSearchType() {
  const el = document.querySelector("input[name='searchType']:checked");
  return el ? el.value : "tracking"; // default
}

function updateIdsUI() {
  const type = getSearchType();
  const labelEl = document.getElementById("idsLabel");
  const textarea = document.getElementById("ids");

  if (!labelEl || !textarea) return;

  if (type === "tracking") {
    labelEl.textContent = "Tracking IDs";
    textarea.placeholder = "Example:\nFMPP1234567\nFMPP7654321\nFMPP9998887";
    setLog("Waiting for tracking IDs...", null);
  } else {
    labelEl.textContent = "Order IDs";
    textarea.placeholder =
      "Example:\nOD436117203254710100\nOD123456789012345000\n...";
    setLog("Waiting for order IDs...", null);
  }
}

function clearForm() {
  document.getElementById("ids").value = "";
  document.getElementById("dateInput").value = "";
  const type = getSearchType();
  const what = type === "tracking" ? "tracking IDs" : "order IDs";
  setLog(`Cleared input. Waiting for ${what}...`);
}

function setLog(message, type) {
  const log = document.getElementById("log");
  const className =
    type === "ok"
      ? "log-line-ok"
      : type === "warn"
      ? "log-line-warn"
      : type === "error"
      ? "log-line-error"
      : "";

  log.innerHTML =
    '<div class="log-title">Status</div>' +
    `<div class="${className}">${message}</div>`;
}

async function reprint() {
  const btn = document.getElementById("btnReprint");
  const type = getSearchType();

  let idsRaw = document.getElementById("ids").value.trim();
  let date = document.getElementById("dateInput").value;

  if (!idsRaw) {
    const what = type === "tracking" ? "tracking ID" : "order ID";
    setLog(`Please enter at least one ${what}.`, "warn");
    return;
  }

  // convert input to array of IDs
  const ids = idsRaw
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    const what = type === "tracking" ? "tracking IDs" : "order IDs";
    setLog(`No valid ${what} found in input.`, "warn");
    return;
  }

  const body = {};
  if (type === "tracking") {
    body.trackingIds = ids;
  } else {
    body.orderIds = ids;
  }
  if (date) {
    body.date = date;
  }

  try {
    btn.disabled = true;
    const what = type === "tracking" ? "tracking ID(s)" : "order ID(s)";
    setLog(
      `Processing ${ids.length} ${what}...\n• Date: ${
        date || "today (server default)"
      }`,
      "ok"
    );

    const res = await fetch("/reprint-labels", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    console.log("Reprint result:", data);

    if (data.error) {
      setLog(`Error: ${data.error}`, "error");
      btn.disabled = false;
      return;
    }

    const notFoundTracking = data.notFoundTrackingIds || [];
    const notFoundOrders = data.notFoundOrderIds || [];

    if (data.url) {
      // auto trigger download
      const a = document.createElement("a");
      a.href = data.url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();

      let msg = `✅ Download ready.\n\nFile: ${data.url}`;
      if (typeof data.foundCount === "number") {
        msg += `\nLabels found: ${data.foundCount}`;
      }

      if (type === "tracking" && notFoundTracking.length > 0) {
        msg += `\n\n⚠ Tracking IDs not found (${notFoundTracking.length}):\n${notFoundTracking.join(
          ", "
        )}`;
        setLog(msg, "warn");
      } else if (type === "order" && notFoundOrders.length > 0) {
        msg += `\n\n⚠ Order IDs not found (${notFoundOrders.length}):\n${notFoundOrders.join(
          ", "
        )}`;
        setLog(msg, "warn");
      } else {
        setLog(msg, "ok");
      }
    } else if (data.message) {
      let msg = data.message;

      if (type === "tracking" && notFoundTracking.length > 0) {
        msg += `\n\nTracking IDs not found (${notFoundTracking.length}):\n${notFoundTracking.join(
          ", "
        )}`;
      } else if (type === "order" && notFoundOrders.length > 0) {
        msg += `\n\nOrder IDs not found (${notFoundOrders.length}):\n${notFoundOrders.join(
          ", "
        )}`;
      }

      setLog(msg, "warn");
    } else {
      setLog("No data returned from server.", "warn");
    }
  } catch (err) {
    console.error(err);
    setLog("Unexpected error: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* --------- init search-type toggle --------- */
const searchTypeRadios = document.querySelectorAll("input[name='searchType']");
searchTypeRadios.forEach((r) =>
  r.addEventListener("change", () => updateIdsUI())
);
updateIdsUI();
