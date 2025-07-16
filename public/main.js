let pdfDoc = null;
let pageNum = 1;
let labelBox = null;
let invoiceBox = null;
let isDragging = null;
let startX, startY;
let uploadedFilename = null;
let skuList = [];

const canvas = document.getElementById("pdfCanvas");
const ctx = canvas.getContext("2d");
const labelBoxEl = document.getElementById("labelBox");
const invoiceBoxEl = document.getElementById("invoiceBox");
const setLabelBtn = document.getElementById("setLabel");
const setInvoiceBtn = document.getElementById("setInvoice");
const processBtn = document.getElementById("processPDF");
const uploadForm = document.getElementById("uploadForm");

function updateBox(el, box) {
  el.style.left = box.x + "px";
  el.style.top = box.y + "px";
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.display = "block";
}

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
  processBtn.disabled = !(labelBox && invoiceBox && uploadedFilename);
});

canvas.addEventListener("mouseup", () => {
  isDragging = null;
});

setLabelBtn.onclick = () => (isDragging = "label");
setInvoiceBtn.onclick = () => (isDragging = "invoice");

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(uploadForm);
  const response = await fetch("/upload", { method: "POST", body: formData });
  const json = await response.json();
  uploadedFilename = json.filename;
  skuList = json.skuList;

  const file = uploadForm.querySelector('input[type="file"]').files[0];
  const arrayBuffer = await file.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument(arrayBuffer).promise;
  const page = await pdfDoc.getPage(1);
  const viewport = page.getViewport({ scale: 1.0 });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  processBtn.disabled = !(labelBox && invoiceBox && uploadedFilename);
});

processBtn.addEventListener("click", async () => {
  if (!labelBox || !invoiceBox || !uploadedFilename) return;
  const res = await fetch("/crop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: uploadedFilename,
      labelBox,
      invoiceBox,
      skuList,
    }),
  });
  const data = await res.json();
  const link = document.createElement("a");
  link.href = data.outputUrl;
  link.download = "cropped_output.pdf";
  link.click();
});
