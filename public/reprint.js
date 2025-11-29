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

function clearForm() {
  document.getElementById("ids").value = "";
  document.getElementById("dateInput").value = "";
  setLog("Cleared input. Waiting for tracking IDs...");
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
  let idsRaw = document.getElementById("ids").value.trim();
  let date = document.getElementById("dateInput").value;

  if (!idsRaw) {
    setLog("Please enter at least one tracking ID.", "warn");
    return;
  }

  // convert input to array of tracking IDs
  const trackingIds = idsRaw
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (trackingIds.length === 0) {
    setLog("No valid tracking IDs found in input.", "warn");
    return;
  }

  // if no date, backend will assume today
  const body = {
    trackingIds,
  };
  if (date) {
    body.date = date;
  }

  try {
    btn.disabled = true;
    setLog(
      `Processing ${trackingIds.length} tracking ID(s)...\n• Date: ${
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

    if (data.url) {
      // auto trigger download
      const a = document.createElement("a");
      a.href = data.url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();

      const notFound = data.notFoundTrackingIds || [];
      let msg = `✅ Download ready.\n\nFile: ${data.url}`;
      if (typeof data.foundCount === "number") {
        msg += `\nLabels found: ${data.foundCount}`;
      }

      if (notFound.length > 0) {
        msg += `\n\n⚠ Not found (${notFound.length}):\n${notFound.join(
          ", "
        )}`;
        setLog(msg, "warn");
      } else {
        setLog(msg, "ok");
      }
    } else if (data.message) {
      const notFound = data.notFoundTrackingIds || [];
      let msg = data.message;
      if (notFound.length > 0) {
        msg += `\n\nNot found (${notFound.length}):\n${notFound.join(", ")}`;
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
