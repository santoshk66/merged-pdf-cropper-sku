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

/* --------- OCR: read tracking IDs from uploaded image (robust) --------- */

async function extractTrackingIdsFromImage() {
  const fileInput = document.getElementById("imageInput");
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    setLog("Please select an image file first.", "warn");
    return;
  }

  if (typeof Tesseract === "undefined" || typeof Tesseract.recognize !== "function") {
    setLog(
      "OCR library (Tesseract.js) is not loaded. Please check your internet connection.",
      "error"
    );
    return;
  }

  const file = fileInput.files[0];
  setLog("Reading tracking IDs from image... please wait.", null);

  try {
    // Load into image
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();

    // Upscale into canvas for better OCR
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const scale = 2; // upscale factor
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Run OCR on the upscaled image
    const result = await Tesseract.recognize(canvas.toDataURL("image/png"), "eng", {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: 6, // block of text
    });

    let rawText = (result && result.data && result.data.text) || "";
    rawText = rawText.toUpperCase();
    console.log("RAW OCR TEXT:", rawText);

    // 1) Primary pattern: a few letters + many digits (e.g. FMPC5476348135)
    let matches = Array.from(
      rawText.matchAll(/\b[A-Z]{3,6}\s*\d{6,}\b/g)
    ).map((m) => m[0].replace(/\s+/g, ""));

    // 2) If still nothing, fallback to long digit sequences (11+ digits)
    if (!matches.length) {
      const digitMatches = Array.from(
        rawText.matchAll(/\b\d{9,}\b/g)
      ).map((m) => m[0]);

      // if we find only numbers, we still push them as-is
      matches = digitMatches;
    }

    if (!matches.length) {
      setLog(
        "OCR ran successfully but no tracking IDs were found in the text. Try a slightly clearer / zoomed screenshot.",
        "warn"
      );
      return;
    }

    // Deduplicate + merge with existing textarea IDs
    const textarea = document.getElementById("ids");
    const existing = textarea.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const merged = Array.from(new Set([...existing, ...matches]));
    textarea.value = merged.join("\n");

    // Force search type to tracking
    const trackingRadio = document.querySelector(
      "input[name='searchType'][value='tracking']"
    );
    if (trackingRadio) {
      trackingRadio.checked = true;
    }
    updateIdsUI();

    setLog(`OCR success! Found ${matches.length} ID(s) and added to the list.`, "ok");
  } catch (err) {
    console.error(err);
    setLog("OCR failed: " + err.message, "error");
  }
}

/* --------- init search-type toggle + OCR button --------- */
const searchTypeRadios = document.querySelectorAll("input[name='searchType']");
searchTypeRadios.forEach((r) =>
  r.addEventListener("change", () => updateIdsUI())
);
updateIdsUI();

const ocrButton = document.getElementById("btnOcrFromImage");
if (ocrButton) {
  ocrButton.addEventListener("click", extractTrackingIdsFromImage);
}
