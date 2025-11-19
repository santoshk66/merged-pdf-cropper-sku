let pdfDoc = null;
let pageNum = 1;

let labelBox = null;
let invoiceBox = null;

let isDragging = null;
let startX, startY;

let pdfFilename = null;
let mappingFilename = null;
let orderIdsByPage = [];

const canvas = document.getElementById("pdfCanvas");
const ctx = canvas.getContext("2d");
const labelBoxEl = document.getElementById("labelBox");
const invoiceBoxEl = document.getElementById("invoiceBox");
const setLabelBtn = document.getElementById("setLabel");
const setInvoiceBtn = document.getElementById("setInvoice");
const processBtn = document.getElementById("processPDF");
const uploadForm = document.getElementById("uploadForm");
const skuDbForm = document.getElementById("skuDbForm");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

function updateBox(el, box) {
  el.style.left = box.x + "px";
  el.style.top = box.y + "px";
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.display = "block";
}

function updateProcessButtonState() {
  processBtn.disabled = !(
    labelBox &&
    invoiceBox &&
    pdfFilename &&
    orderIdsByPage.length > 0
  );
}

// ===== Crop selection =====
canvas.addEventListener("mousedown", (e) => {
  if (!isDragging) return;
  const rect = canvas.getBoundingClientRect();
  startX = e.clientX - rect.left;
  startY = e.clientY - rect.top;
});

canvas.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const box = {
    x: Math.min(startX, x),
    y: Math.min(startY, y),
    width: Math.abs(x - startX),
    height: Math.abs(y - startY),
  };

  if (isDragging === "label") {
    labelBox = box;
    updateBox(labelBoxEl, labelBox);
  } else if (isDragging === "invoice") {
    invoiceBox = box;
    updateBox(invoiceBoxEl, invoiceBox);
  }

  updateProcessButtonState();
});

canvas.addEventListener("mouseup", () => {
  isDragging = null;
});

setLabelBtn.onclick = () => (isDragging = "label");
setInvoiceBtn.onclick = () => (isDragging = "invoice");

// ===== Render first page (high-res, same visual size) =====
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

    const match = fullText.match(/Order Id[:\s]*?(OD\d+)/i);
    if (match) {
      orderIdsByPage.push(match[1]);
    } else {
      orderIdsByPage.push(null);
    }
  }

  console.log("Detected orderIdsByPage:", orderIdsByPage);

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

// ===== Process PDF (crop + mapping) =====
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

    const link = document.createElement("a");
    link.href = data.outputUrl;
    link.download = "cropped_output.pdf";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    console.error(err);
    alert("Error while calling crop API.");
  }
});
