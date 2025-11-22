let pdfDoc = null;
let pageNum = 1;

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
    updateBox(labelBoxEl, labelBox);
  } else if (isDrawing === "invoice") {
    invoiceBox = box;
    updateBox(invoiceBoxEl, invoiceBox);
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
    updateBox(boxEl, box);
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

    updateBox(boxEl, box);
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
async function extractOrderIdsFromPdf(pdfFile) {
  const arrayBuffer = await pdfFile.arrayBuffer();

  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdfDoc.numPages;
  orderIdsByPage = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const fullText = textContent.items.map((it) => it.str).join(" ");

    // UPDATED: detect ODxxxx... even without "Order Id"
    const match = fullText.match(/OD\d{9,}/i);
    if (match) {
      orderIdsByPage.push(match[0]);
    } else {
      orderIdsByPage.push(null);
    }
  }

  console.log("Detected orderIdsByPage:", orderIdsByPage);

  // === NEW: check duplicates
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
      `Duplicate Order Ids detected in this PDF:\n${list}\n\n` +
        `Press OK to KEEP duplicates.\n` +
        `Press Cancel to REMOVE duplicates and process only unique orders.`
    );
    if (!keep) {
      removeDuplicates = true;
    }
  }

  await renderFirstPage();
}

// ===== Upload Label PDF + Full CSV =====
uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const formData = new FormData(uploadForm);

  const pdfFile = formData.get("pdf");
  if (!pdfFile) {
    alert("Please select a PDF file.");
    return;
  }

  const csvFile = formData.get("skuMapping");
  if (!csvFile) {
    alert("Please select the full CSV mapping file.");
    return;
  }

  try {
    // Detect order IDs locally
    await extractOrderIdsFromPdf(pdfFile);

    if (!orderIdsByPage.some((id) => !!id)) {
      const proceed = confirm(
        "No Order Id was detected in the PDF pages. Do you still want to upload and continue?"
      );
      if (!proceed) return;
    }

    // Upload to backend
    const response = await fetch("/upload", {
      method: "POST",
      body: formData,
    });

    const json = await response.json();
    if (!response.ok) {
      alert("Upload failed: " + (json.error || "Unknown error"));
      return;
    }

    pdfFilename = json.pdfFilename;
    mappingFilename = json.mappingFilename || null;

    console.log("Uploaded pdfFilename:", pdfFilename);
    console.log("Uploaded mappingFilename:", mappingFilename);

    updateProcessButtonState();
  } catch (err) {
    console.error(err);
    alert("Error while processing PDF or uploading files.");
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
    const res = await fetch("/upload-sku-db", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      alert("SKU DB upload failed: " + (data.error || "Unknown error"));
      return;
    }

    alert(data.message || "SKU DB uploaded successfully.");
  } catch (err) {
    console.error(err);
    alert("Error uploading SKU DB.");
  }
});

// ===== Process PDF (crop + mapping + picklist) =====
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

    const res = await fetch("/crop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      alert("Crop failed: " + (data.error || "Unknown error"));
      return;
    }

    if (!data.zipUrl) {
      alert("Crop succeeded but ZIP URL is missing in response.");
      console.error("Response data:", data);
      return;
    }

    // Download single ZIP containing all PDFs
    const zipLink = document.createElement("a");
    zipLink.href = data.zipUrl;
    zipLink.download = "orders_bundle.zip";
    document.body.appendChild(zipLink);
    zipLink.click();
    document.body.removeChild(zipLink);

  } catch (err) {
    console.error(err);
    alert("Error while calling crop API.");
  }
});
