let pdfDoc = null;
let labelBox = null;
let invoiceBox = null;

let pdfFilename = null;
let mappingFilename = null;

let orderIdsByPage = [];

let activeCropBox = null;
let isDraggingBox = false;
let isResizing = false;
let resizeHandle = null;

let offsetX = 0;
let offsetY = 0;

const canvas = document.getElementById("pdfCanvas");
const ctx = canvas.getContext("2d");

const labelBoxEl = document.getElementById("labelBox");
const invoiceBoxEl = document.getElementById("invoiceBox");

const uploadForm = document.getElementById("uploadForm");

const setLabelBtn = document.getElementById("setLabel");
const setInvoiceBtn = document.getElementById("setInvoice");
const processBtn = document.getElementById("processPDF");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";


// --- Render High Resolution PDF ---
async function renderPDF(file) {
  const buffer = await file.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;

  const page = await pdfDoc.getPage(1);

  const dpi = window.devicePixelRatio || 2;
  const viewport = page.getViewport({ scale: dpi });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = viewport.width / dpi + "px";
  canvas.style.height = viewport.height / dpi + "px";

  await page.render({ canvasContext: ctx, viewport }).promise;
}


// --- Extract Order Ids ---
async function extractOrderIds(file) {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;

  orderIdsByPage = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const text = await page.getTextContent();
    const fullText = text.items.map(t => t.str).join(" ");

    const match = fullText.match(/OD\d+/);
    orderIdsByPage.push(match ? match[0] : null);
  }
}


// --- Update Crop Box Position ---
function updateCropBox(el, box) {
  el.style.left = box.x + "px";
  el.style.top = box.y + "px";
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.display = "block";
}


// --- Enable Drag + Resize ---
function setupDragResize(el, boxObj) {
  el.addEventListener("mousedown", e => {
    const rect = el.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    if (e.target.classList.contains("resize-handle")) {
      isResizing = true;
      resizeHandle = e.target.classList[1]; // tl, tr, bl, br
      activeCropBox = el;
      return;
    }

    isDraggingBox = true;
    activeCropBox = el;

    offsetX = e.clientX - rect.left + canvasRect.left;
    offsetY = e.clientY - rect.top + canvasRect.top;
  });

  window.addEventListener("mousemove", e => {
    if (activeCropBox !== el) return;

    const canvasRect = canvas.getBoundingClientRect();

    if (isDraggingBox) {
      boxObj.x = e.clientX - canvasRect.left - offsetX;
      boxObj.y = e.clientY - canvasRect.top - offsetY;

      boxObj.x = Math.max(0, boxObj.x);
      boxObj.y = Math.max(0, boxObj.y);

      updateCropBox(el, boxObj);
    }

    if (isResizing) {
      const mouseX = e.clientX - canvasRect.left;
      const mouseY = e.clientY - canvasRect.top;

      let bx = boxObj.x;
      let by = boxObj.y;

      if (resizeHandle === "br") {
        boxObj.width = mouseX - bx;
        boxObj.height = mouseY - by;
      }
      if (resizeHandle === "tr") {
        boxObj.height = (by + boxObj.height) - mouseY;
        boxObj.y = mouseY;
      }
      if (resizeHandle === "bl") {
        boxObj.width = (bx + boxObj.width) - mouseX;
        boxObj.x = mouseX;
      }
      if (resizeHandle === "tl") {
        boxObj.x = mouseX;
        boxObj.y = mouseY;
        boxObj.width = (bx + boxObj.width) - mouseX;
        boxObj.height = (by + boxObj.height) - mouseY;
      }

      boxObj.width = Math.max(20, boxObj.width);
      boxObj.height = Math.max(20, boxObj.height);

      updateCropBox(el, boxObj);
    }
  });

  window.addEventListener("mouseup", () => {
    isDraggingBox = false;
    isResizing = false;
    resizeHandle = null;
  });
}


// --- PDF & CSV Upload ---
uploadForm.addEventListener("submit", async e => {
  e.preventDefault();

  const formData = new FormData(uploadForm);
  const pdfFile = formData.get("pdf");
  const csvFile = formData.get("skuMapping");

  await extractOrderIds(pdfFile);
  await renderPDF(pdfFile);

  const res = await fetch("/upload", { method: "POST", body: formData });
  const json = await res.json();

  pdfFilename = json.pdfFilename;
  mappingFilename = json.mappingFilename;

  processBtn.disabled = false;
});


// --- Selecting Label Crop ---
setLabelBtn.onclick = () => {
  activeCropBox = labelBoxEl;

  labelBox = { x: 50, y: 50, width: 200, height: 200 };
  updateCropBox(labelBoxEl, labelBox);

  setupDragResize(labelBoxEl, labelBox);
};


// --- Selecting Invoice Crop ---
setInvoiceBtn.onclick = () => {
  activeCropBox = invoiceBoxEl;

  invoiceBox = { x: 300, y: 50, width: 250, height: 200 };
  updateCropBox(invoiceBoxEl, invoiceBox);

  setupDragResize(invoiceBoxEl, invoiceBox);
};


// --- Send Crop Data ---
processBtn.addEventListener("click", async () => {
  if (!labelBox || !invoiceBox) {
    alert("Please create both crop boxes first.");
    return;
  }

  const payload = {
    pdfFilename,
    mappingFilename,
    labelBox,
    invoiceBox,
    orderIdsByPage
  };

  const res = await fetch("/crop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json = await res.json();

  const a = document.createElement("a");
  a.href = json.outputUrl;
  a.download = "cropped_output.pdf";
  a.click();
});
