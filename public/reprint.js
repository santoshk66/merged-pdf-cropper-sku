// ================== BASIC HELPERS: DATE + UI ==================

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
  const idsEl = document.getElementById("ids");
  const dateEl = document.getElementById("dateInput");
  if (idsEl) idsEl.value = "";
  if (dateEl) dateEl.value = "";
  const what = getSearchType() === "tracking" ? "tracking IDs" : "order IDs";
  setLog(`Cleared input. Waiting for ${what}...`);
}

function setLog(message, type) {
  const log = document.getElementById("log");
  if (!log) return;

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

// ================== FLOW 1: OLD REPRINT USING SAVED DATA ==================
// Uses /reprint-labels and DOES NOT detect SKU text.

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
    if (btn) btn.disabled = true;
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
      if (btn) btn.disabled = false;
      return;
    }

    const notFoundTracking = data.notFoundTrackingIds || [];
    const notFoundOrders = data.notFoundOrderIds || [];

    if (data.url) {
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
    if (btn) btn.disabled = false;
  }
}

// ================== OCR FROM IMAGE (TRACKING IDs ONLY) ==================

async function extractTrackingIdsFromImage() {
  const fileInput = document.getElementById("imageInput");
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    setLog("Please select an image file first.", "warn");
    return;
  }

  if (
    typeof Tesseract === "undefined" ||
    typeof Tesseract.recognize !== "function"
  ) {
    setLog(
      "OCR library (Tesseract.js) is not loaded. Please check your internet connection.",
      "error"
    );
    return;
  }

  const file = fileInput.files[0];
  setLog("Reading tracking IDs from image... please wait.", null);

  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const scale = 2;
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/png");

    const result = await Tesseract.recognize(dataUrl, "eng", {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: 6,
    });

    const rawText = (result && result.data && result.data.text) || "";
    const text = rawText.toUpperCase();
    console.log("OCR raw text:", text);

    let matches =
      text.match(/\b[A-Z]{3,6}\s*\d{6,}\b/g) ||
      text.match(/\b\d{9,}\b/g); // fallback: long numbers

    if (!matches || matches.length === 0) {
      setLog(
        "OCR ran successfully but no tracking IDs were found. Try a clearer / zoomed screenshot.",
        "warn"
      );
      return;
    }

    const unique = Array.from(new Set(matches.map((m) => m.trim())));

    const textarea = document.getElementById("ids");
    const old = (textarea.value || "").trim();
    const merged = old ? old + "\n" + unique.join("\n") : unique.join("\n");
    textarea.value = merged;

    const radio = document.querySelector(
      'input[name="searchType"][value="tracking"]'
    );
    if (radio) radio.checked = true;
    updateIdsUI();

    setLog(
      `OCR success! Found ${unique.length} tracking ID(s) and added to the list.`,
      "ok"
    );
  } catch (err) {
    console.error("OCR error:", err);
    setLog("OCR failed: " + err.message, "error");
  }
}

// ================== FLOW 2: REPRINT FROM UPLOADED PDFs ONLY ==================
// Here we ALSO read SKU text (rawSku) from labels.
// SKU mapping itself is done on the backend using skuCorrections.

// State for flow 2
let uploadedPdfFiles = []; // File[]
let uploadedPageIndex = []; // { fileIndex, pageIndex, orderId, trackingId, rawSku }

// Detect orderId inside page text
function detectOrderId(text) {
  if (!text) return "";
  const m = text.match(/\bOD[0-9]{10,}\b/i);
  return m ? m[0].toUpperCase() : "";
}

// Detect trackingId inside page text
function detectTrackingId(text) {
  if (!text) return "";
  const m1 = text.match(/\b(FMPP|FMPC|SF|SPC|BLUEDART|ECOM)\s*\d{6,}\b/i);
  if (m1) return m1[0].toUpperCase();

  const m2 = text.match(/\b\d{9,}\b/g);
  if (m2 && m2.length > 0) {
    return m2[0].toUpperCase();
  }

  return "";
}

// 🔴 Detect raw SKU ONLY for this flow (does not affect old flow)
function detectRawSku(text) {
  if (!text) return "";

  // 1) Try exact pattern "SKU: XYZ" – keep as fallback
  const m1 = text.match(/SKU\s*[:\-]\s*([A-Z0-9\-_.]+)/i);
  if (m1 && m1[1]) {
    return m1[1].trim().toUpperCase();
  }

  // 2) Try detecting first part of description:
  //    Example: "1sIndian-wifi-Bulb-camera | Maizic Smarthome..."
  const pipeMatch = text.match(/([A-Za-z0-9\-\._]+)\s*\|/);
  if (pipeMatch && pipeMatch[1]) {
    const sku = pipeMatch[1].trim().toUpperCase();
    if (sku.length > 2) return sku;
  }

  // 3) Try first token of the long product description line
  const firstWordMatch = text.match(/\b([A-Za-z0-9\-_.]{4,})/);
  if (firstWordMatch) {
    return firstWordMatch[1].trim().toUpperCase();
  }

  return "";
}

// Scan uploaded PDFs using pdf.js and build index
async function indexUploadedPdfs() {
  const input = document.getElementById("pdfFiles");
  if (!input || !input.files || input.files.length === 0) {
    setLog("Please select at least one PDF to scan.", "warn");
    return;
  }

  if (!window.pdfjsLib) {
    setLog("pdf.js is not loaded. Please check internet connection.", "error");
    return;
  }

  uploadedPdfFiles = Array.from(input.files);
  uploadedPageIndex = [];

  setLog(
    `Scanning ${uploadedPdfFiles.length} PDF(s) for order IDs and tracking IDs... this may take some time.`,
    "ok"
  );

  try {
    let totalPages = 0;

    for (let i = 0; i < uploadedPdfFiles.length; i++) {
      const file = uploadedPdfFiles[i];
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const text = textContent.items.map((it) => it.str).join(" ");

        const orderId = detectOrderId(text);
        const trackingId = detectTrackingId(text);
        const rawSku = detectRawSku(text); // 🔴 NEW: only here

        uploadedPageIndex.push({
          fileIndex: i,
          pageIndex: pageNum - 1,
          orderId,
          trackingId,
          rawSku,
        });

        totalPages++;
      }
    }

    const mappedWithId = uploadedPageIndex.filter(
      (p) => p.orderId || p.trackingId
    );

    setLog(
      `Scan completed.\nTotal pages scanned: ${totalPages}.\nPages with detected IDs: ${mappedWithId.length}.\n\nNow enter the tracking IDs or order IDs above and click "Reprint from Uploaded PDFs".`,
      "ok"
    );
  } catch (err) {
    console.error("Index PDFs error:", err);
    setLog("Failed to scan PDFs: " + err.message, "error");
  }
}

// Use uploaded PDFs + index to reprint selected IDs
async function reprintFromUploadedPdfs() {
  if (!uploadedPdfFiles.length || !uploadedPageIndex.length) {
    setLog("First upload and scan PDFs using 'Scan PDFs for IDs'.", "warn");
    return;
  }

  const type = getSearchType();
  const idsRaw = (document.getElementById("ids").value || "").trim();

  if (!idsRaw) {
    const what = type === "tracking" ? "tracking ID" : "order ID";
    setLog(`Please enter at least one ${what}.`, "warn");
    return;
  }

  const ids = idsRaw
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!ids.length) {
    const what = type === "tracking" ? "tracking IDs" : "order IDs";
    setLog(`No valid ${what} found in input.`, "warn");
    return;
  }

  let requestedTracking = [];
  let requestedOrders = [];
  if (type === "tracking") {
    requestedTracking = ids;
  } else {
    requestedOrders = ids;
  }

  const neededPages = uploadedPageIndex.filter((p) => {
    const t = (p.trackingId || "").trim();
    const o = (p.orderId || "").trim();

    const matchTracking =
      requestedTracking.length && t && requestedTracking.includes(t);
    const matchOrder =
      requestedOrders.length && o && requestedOrders.includes(o);

    return matchTracking || matchOrder;
  });

  if (!neededPages.length) {
    setLog(
      "No matching pages found in uploaded PDFs for given IDs. Check IDs or scan again.",
      "warn"
    );
    return;
  }

  const btn = document.getElementById("btnReprintFromPdfs");
  if (btn) btn.disabled = true;

  try {
    setLog(
      `Sending PDFs to server and building reprint PDF...\nMatching pages: ${neededPages.length}.`,
      "ok"
    );

    const fd = new FormData();
    uploadedPdfFiles.forEach((file) => fd.append("pdfs", file));

    fd.append(
      "index",
      JSON.stringify({
        pages: neededPages, // includes fileIndex, pageIndex, orderId, trackingId, rawSku
        // trackingIds / orderIds arrays are not mandatory now since we already filtered
      })
    );

    const res = await fetch("/reprint-from-pdfs", {
      method: "POST",
      body: fd,
    });

    const data = await res.json();
    console.log("Reprint-from-pdfs result:", data);

    if (!res.ok || data.error) {
      throw new Error(data.error || `Server error: ${res.status}`);
    }

    if (data.url) {
      const a = document.createElement("a");
      a.href = data.url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();

      setLog(
        `✅ Reprint PDF ready from uploaded PDFs.\nFile: ${data.url}\nLabel+Invoice pairs: ${
          data.pagePairs || "?"
        }`,
        "ok"
      );
    } else {
      setLog("Server did not return a PDF URL.", "warn");
    }
  } catch (err) {
    console.error("reprintFromUploadedPdfs error:", err);
    setLog("Reprint from PDFs failed: " + err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ================== WIRE EVENTS ==================

window.addEventListener("DOMContentLoaded", () => {
  const radios = document.querySelectorAll("input[name='searchType']");
  radios.forEach((r) => {
    r.addEventListener("change", updateIdsUI);
  });
  updateIdsUI();

  const btnReprint = document.getElementById("btnReprint");
  if (btnReprint) {
    btnReprint.addEventListener("click", reprint);
  }

  const ocrBtn = document.getElementById("btnOcrFromImage");
  if (ocrBtn) {
    ocrBtn.addEventListener("click", extractTrackingIdsFromImage);
  }

  const btnIndexPdfs = document.getElementById("btnIndexPdfs");
  if (btnIndexPdfs) {
    btnIndexPdfs.addEventListener("click", indexUploadedPdfs);
  }

  const btnReprintFromPdfs = document.getElementById("btnReprintFromPdfs");
  if (btnReprintFromPdfs) {
    btnReprintFromPdfs.addEventListener("click", reprintFromUploadedPdfs);
  }
});
