let pdfDoc = null;
let pageNum = 1;

// ✅ Fixed crop dimensions (your original dimensions)
const USE_FIXED_DIMENSIONS = true;  // keep true for auto mode

const FIXED_LABEL_BOX = {
  x: 189.6,
  y: 27.3,
  width: 216.0,
  height: 356.0,
};

const FIXED_INVOICE_BOX = {
  x: 35.6,
  y: 388.0,
  width: 521.0,
  height: 395.0,
};

let labelBox = null;
let invoiceBox = null;

let isDrawing = null; // 'label' | 'invoice' | null
let startX, startY;

let pdfFilename = null;
let mappingFilename = null;
let orderIdsByPage = [];
let removeDuplicates = false; // NEW FLAG

const canvas = document.getElementById("pdfCanvas");
const ctx = canvas.getContext("2d");

const labelBoxEl = document.getElementById("labelBox");
const invoiceBoxEl = document.getElementById("invoiceBox");

const setLabelBtn = document.getElementById("setLabel");
const setInvoiceBtn = document.getElementById("setInvoice");
const processBtn = document.getElementById("processPDF");

const uploadForm = document.getElementById("uploadForm");
const skuDbForm = document.getElementById("skuDbForm");

// Dimension display elements
const labelDimsEl = document.getElementById("labelDims");
const invoiceDimsEl = document.getElementById("invoiceDims");

// 🔹 Status log & loading overlay elements
const statusLogEl = document.getElementById("statusLog");
const loadingOverlayEl = document.getElementById("loadingOverlay");
const loadingTextEl = loadingOverlayEl
  ? loadingOverlayEl.querySelector(".loading-text")
  : null;

function logStatus(message) {
  if (!statusLogEl) return;

  const line = document.createElement("div");
  line.className = "log-line";

  const timeSpan = document.createElement("span");
  timeSpan.className = "time";
  timeSpan.textContent = `[${new Date().toLocaleTimeString()}]`;

  const msgSpan = document.createElement("span");
  msgSpan.textContent = " " + message;

  line.appendChild(timeSpan);
  line.appendChild(msgSpan);

  statusLogEl.appendChild(line);
  statusLogEl.scrollTop = statusLogEl.scrollHeight;
}

function setLoading(isLoading, message) {
  if (!loadingOverlayEl) return;
  if (isLoading) {
    if (loadingTextEl && message) {
      loadingTextEl.textContent = message;
    }
    loadingOverlayEl.style.display = "flex";
  } else {
    loadingOverlayEl.style.display = "none";
  }
}

// Drag/resize state
let activeBoxType = null; // 'label' | 'invoice'
let isDraggingBox = false;
let isResizingBox = false;
let resizeDir = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

function updateBox(el, box, type) {
  el.style.left = box.x + "px";
  el.style.top = box.y + "px";
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.display = "block";

  // 🔍 Update dimension text
  const text = `x: ${box.x.toFixed(1)}, y: ${box.y.toFixed(1)}, w: ${box.width.toFixed(
    1
  )}, h: ${box.height.toFixed(1)}`;

  if (type === "label" && labelDimsEl) {
    labelDimsEl.textContent = text;
  } else if (type === "invoice" && invoiceDimsEl) {
    invoiceDimsEl.textContent = text;
  }
}

function updateProcessButtonState() {
  processBtn.disabled = !(
    labelBox &&
    invoiceBox &&
    pdfFilename &&
    orderIdsByPage.length > 0
  );
}

// ===== DRAW MODE on canvas (initial box selection) =====
canvas.addEventListener("mousedown", (e) => {
  if (!isDrawing) return;

  const rect = canvas.getBoundingClientRect();
  startX = e.clientX - rect.left;
  startY = e.clientY - rect.top;
});

canvas.addEventListener("mousemove", (e) => {
  if (!isDrawing) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const box = {
    x: Math.min(startX, x),
    y: Math.min(startY, y),
    width: Math.abs(x - startX),
    height: Math.abs(y - startY),
  };

  if (isDrawing === "label") {
    labelBox = box;
    updateBox(labelBoxEl, labelBox, "label");
  } else if (isDrawing === "invoice") {
    invoiceBox = box;
    updateBox(invoiceBoxEl, invoiceBox, "invoice");
  }
  updateProcessButtonState();
});

canvas.addEventListener("mouseup", () => {
  isDrawing = null;
});

// Buttons to start drawing new boxes
setLabelBtn.onclick = () => {
  isDrawing = "label";
};

setInvoiceBtn.onclick = () => {
  isDrawing = "invoice";
};

// ===== Drag + Resize logic on box divs =====
function attachDragResize(boxEl, boxType) {
  boxEl.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const box = boxType === "label" ? labelBox : invoiceBox;
    if (!box) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const handle = e.target.closest(".resize-handle");
    activeBoxType = boxType;

    if (handle) {
      // Resize mode
      isResizingBox = true;
      resizeDir = handle.getAttribute("data-dir"); // tl, tr, bl, br
    } else {
      // Drag mode
      isDraggingBox = true;
      dragOffsetX = mouseX - box.x;
      dragOffsetY = mouseY - box.y;
    }
  });
}

// Global mousemove for dragging/resizing
window.addEventListener("mousemove", (e) => {
  if (!isDraggingBox && !isResizingBox) return;
  if (!activeBoxType) return;

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const box = activeBoxType === "label" ? labelBox : invoiceBox;
  const boxEl = activeBoxType === "label" ? labelBoxEl : invoiceBoxEl;
  if (!box) return;

  const minSize = 20;

  if (isDraggingBox) {
    let newX = mouseX - dragOffsetX;
    let newY = mouseY - dragOffsetY;

    // Clamp to canvas
    newX = Math.max(0, Math.min(newX, canvas.width - box.width));
    newY = Math.max(0, Math.min(newY, canvas.height - box.height));

    box.x = newX;
    box.y = newY;
    updateBox(boxEl, box, activeBoxType);
  }

  if (isResizingBox) {
    let { x, y, width, height } = box;

    if (resizeDir === "br") {
      width = mouseX - x;
      height = mouseY - y;
    } else if (resizeDir === "bl") {
      width = (x + width) - mouseX;
      x = mouseX;
      height = mouseY - y;
    } else if (resizeDir === "tr") {
      width = mouseX - x;
      height = (y + height) - mouseY;
      y = mouseY;
    } else if (resizeDir === "tl") {
      width = (x + width) - mouseX;
      x = mouseX;
      height = (y + height) - mouseY;
      y = mouseY;
    }

    width = Math.max(minSize, width);
    height = Math.max(minSize, height);

    x = Math.max(0, Math.min(x, canvas.width - width));
    y = Math.max(0, Math.min(y, canvas.height - height));

    box.x = x;
    box.y = y;
    box.width = width;
    box.height = height;

    updateBox(boxEl, box, activeBoxType);
  }

  updateProcessButtonState();
});

// Reset flags on mouseup
window.addEventListener("mouseup", () => {
  isDraggingBox = false;
  isResizingBox = false;
  resizeDir = null;
});

// Attach interactions
attachDragResize(labelBoxEl, "label");
attachDragResize(invoiceBoxEl, "invoice");

// ===== Render first page (high-res but same visual size) =====
async function renderFirstPage() {
  if (!pdfDoc) return;
  pageNum = 1;

  const page = await pdfDoc.getPage(pageNum);

  const dpr = window.devicePixelRatio || 1;
  const baseScale = 1.0;
  const viewport = page.getViewport({ scale: baseScale * dpr });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = viewport.width / dpr + "px";
  canvas.style.height = viewport.height / dpr + "px";

  await page.render({ canvasContext: ctx, viewport }).promise;
}

// ===== Extract Order Id from each page =====
// ✅ New helper that works with Blob OR URL string
async function extractOrderIdsFromPdfSource(source) {
  let arrayBuffer;

  if (source instanceof Blob) {
    arrayBuffer = await source.arrayBuffer();
  } else if (typeof source === "string") {
    const res = await fetch(source);
    if (!res.ok) throw new Error("Failed to fetch merged PDF from server");
    arrayBuffer = await res.arrayBuffer();
  } else {
    throw new Error("Unsupported PDF source");
  }

  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdfDoc.numPages;
  orderIdsByPage = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const fullText = textContent.items.map((it) => it.str).join(" ");

    const match = fullText.match(/OD\d{9,}/i);
    if (match) {
      orderIdsByPage.push(match[0]);
    } else {
      orderIdsByPage.push(null);
    }
  }

  console.log("Detected orderIdsByPage (merged):", orderIdsByPage);

  // duplicate detection logic stays the same
  const seen = new Set();
  const dups = new Set();

  for (const id of orderIdsByPage) {
    if (!id) continue;
    if (seen.has(id)) dups.add(id);
    else seen.add(id);
  }

  removeDuplicates = false;

  if (dups.size > 0) {
    const list = Array.from(dups).join(", ");
    const keep = confirm(
      `Duplicate Order Ids detected in this merged PDF:\n${list}\n\n` +
        `Press OK to KEEP duplicates.\n` +
        `Press Cancel to REMOVE duplicates and process only unique orders.`
    );
    if (!keep) {
      removeDuplicates = true;
    }
  }

  // finally render page 1 of merged PDF for preview
  await renderFirstPage();
}

// ===== Upload MULTI Label PDFs + Full CSV =====
uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const pdfInput = uploadForm.querySelector('input[name="pdfs"]');
  if (!pdfInput || pdfInput.files.length === 0) {
    alert("Please select at least one label PDF.");
    return;
  }

  const csvFile = uploadForm.querySelector('input[name="skuMapping"]').files[0];
  if (!csvFile) {
    alert("Please select the full CSV mapping file.");
    return;
  }

  const formData = new FormData(uploadForm);

  try {
    // 1️⃣ Upload all PDFs + CSV → backend merges & returns merged filename
    // (your spinner / logs code can be around this if you added it)
    const response = await fetch("/upload", {
      method: "POST",
      body: formData,
    });

    const json = await response.json();
    if (!response.ok) {
      alert("Upload failed: " + (json.error || "Unknown error"));
      return;
    }

    pdfFilename = json.pdfFilename;              // merged PDF filename
    mappingFilename = json.mappingFilename || null;

    console.log("Merged pdfFilename:", pdfFilename);
    console.log("Uploaded mappingFilename:", mappingFilename);

    // 2️⃣ Load merged PDF from server for order ID detection + preview
    const mergedUrl = `/uploads/${pdfFilename}`;
    await extractOrderIdsFromPdfSource(mergedUrl);

    // 3️⃣ Auto-apply your fixed label/invoice boxes if enabled
    if (USE_FIXED_DIMENSIONS) {
      labelBox = { ...FIXED_LABEL_BOX };
      invoiceBox = { ...FIXED_INVOICE_BOX };
      updateBox(labelBoxEl, labelBox, "label");
      updateBox(invoiceBoxEl, invoiceBox, "invoice");
    }

    updateProcessButtonState();
  } catch (err) {
    console.error(err);
    alert("Error while uploading or processing merged PDF.");
  }
});

// ===== Upload SKU DB CSV (old sku,new sku) to Firestore =====
skuDbForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const formData = new FormData(skuDbForm);
  const file = formData.get("skuDb");
  if (!file) {
    alert("Please select a SKU DB CSV file.");
    return;
  }

  try {
    logStatus("⬆️ Uploading SKU DB CSV to Firestore...");
    const res = await fetch("/upload-sku-db", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      logStatus("❌ SKU DB upload failed.");
      alert("SKU DB upload failed: " + (data.error || "Unknown error"));
      return;
    }

    logStatus("✅ " + (data.message || "SKU DB uploaded successfully."));
    alert(data.message || "SKU DB uploaded successfully.");
  } catch (err) {
    console.error(err);
    logStatus("❌ Error uploading SKU DB: " + err.message);
    alert("Error uploading SKU DB.");
  }
});

// ===== Process PDF (crop + mapping + picklist + zip) =====
processBtn.addEventListener("click", async () => {
  if (!labelBox || !invoiceBox || !pdfFilename) {
    alert("Please set label & invoice crop and upload files first.");
    return;
  }

  try {
    const payload = {
      pdfFilename,
      mappingFilename,
      labelBox,
      invoiceBox,
      orderIdsByPage,
      removeDuplicates, // NEW
    };

    logStatus("⚙️ Starting crop and PDF generation on server...");
    setLoading(true, "Generating cropped PDFs and ZIP...");

    const res = await fetch("/crop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      logStatus("❌ Crop failed: " + (data.error || "Unknown error"));
      alert("Crop failed: " + (data.error || "Unknown error"));
      setLoading(false);
      return;
    }

    if (!data.zipUrl) {
      logStatus("ℹ️ Processing succeeded but ZIP URL missing in response.");
      alert("Crop succeeded but ZIP URL is missing in response.");
      setLoading(false);
      return;
    }

    logStatus("📦 Processing complete. Preparing ZIP download...");
    const zipLink = document.createElement("a");
    zipLink.href = data.zipUrl;
    zipLink.download = "orders_bundle.zip";
    document.body.appendChild(zipLink);
    zipLink.click();
    document.body.removeChild(zipLink);
    logStatus("⬇️ Download started: orders_bundle.zip");
  } catch (err) {
    console.error(err);
    logStatus("❌ Error while calling crop API: " + err.message);
    alert("Error while calling crop API.");
  } finally {
    setLoading(false);
  }
});
