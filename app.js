// app.js 
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import archiver from "archiver";
import {
  buildOrderMapFromCSV,
  buildSkuCorrectionMapFromCSV,
} from "./skuUtils.js";
import { db } from "./firebaseAdmin.js";

const app = express();

// ----------------- Directories -----------------
const UPLOAD_DIR = "uploads";
const OUTPUT_DIR = "outputs";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOAD_DIR });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve frontend & outputs
app.use(express.static("public"));
app.use("/outputs", express.static(OUTPUT_DIR));

// ----------------- Helper: wrap product text for picklist -----------------
function wrapTextIntoLines(text, maxWidth, font, fontSize) {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? currentLine + " " + word : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    if (width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

// ----------------- /upload (PDF + full CSV) -----------------
/**
 * POST /upload
 * Fields:
 *  - pdf        (label PDF)
 *  - skuMapping (full Flipkart CSV: Order Id, SKU, Quantity, Product...)
 */
app.post(
  "/upload",
  upload.fields([
    { name: "pdf", maxCount: 1 },
    { name: "skuMapping", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const pdfFile = req.files["pdf"]?.[0];
      const csvFile = req.files["skuMapping"]?.[0];

      if (!pdfFile) {
        return res.status(400).json({ error: "Missing PDF file" });
      }

      // Save PDF into uploads dir (by multer filename)
      const pdfFinalName = pdfFile.filename;
      const pdfFinalPath = path.join(UPLOAD_DIR, pdfFinalName);
      await fsPromises.writeFile(
        pdfFinalPath,
        await fsPromises.readFile(pdfFile.path)
      );

      let mappingFilename = null;

      if (csvFile) {
        const csvFinalName = csvFile.filename;
        const csvFinalPath = path.join(UPLOAD_DIR, csvFinalName);
        await fsPromises.writeFile(
          csvFinalPath,
          await fsPromises.readFile(csvFile.path)
        );
        mappingFilename = csvFinalName;
      }

      res.json({
        pdfFilename: pdfFinalName,
        mappingFilename,
      });
    } catch (err) {
      console.error("Upload error", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// ----------------- /upload-sku-db (SKU DB CSV -> Firestore) -----------------
/**
 * POST /upload-sku-db
 * Field:
 *  - skuDb (CSV with columns: old sku,new sku)
 * Collection in Firestore: skuCorrections
 */
app.post("/upload-sku-db", upload.single("skuDb"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Missing skuDb CSV file" });
    }

    const buffer = await fsPromises.readFile(file.path);
    const skuMap = buildSkuCorrectionMapFromCSV(buffer);
    const entries = Object.entries(skuMap);

    if (entries.length === 0) {
      return res
        .status(400)
        .json({ error: "No valid SKU mappings found in CSV" });
    }

    const batch = db.batch();
    const collectionRef = db.collection("skuCorrections");

    for (const [oldSku, newSku] of entries) {
      // Firestore doc IDs cannot contain '/'
      const safeDocId = oldSku.replace(/\//g, "_");

      const docRef = collectionRef.doc(safeDocId);
      batch.set(
        docRef,
        {
          oldSku, // original with '/'
          newSku,
          safeDocId,
        },
        { merge: true }
      );
    }

    await batch.commit();

    res.json({
      message: `Uploaded ${entries.length} SKU mappings to Firestore`,
    });
  } catch (err) {
    console.error("SKU DB upload error", err);
    res.status(500).json({
      error: `Failed to upload SKU DB: ${err.message || "Unknown error"}`,
    });
  }
});

// ----------------- /crop (main processing) -----------------
/**
 * POST /crop
 * JSON body:
 *  {
 *    pdfFilename,
 *    mappingFilename,
 *    labelBox: { x, y, width, height },
 *    invoiceBox: { x, y, width, height },
 *    orderIdsByPage: [ "OD...", "OD...", ... ]
 *  }
 *
 * Behavior:
 *  - Uses Order Id -> CSV row -> SKU, Qty, Product, with Firestore skuCorrections
 *  - Creates:
 *      1) Combined PDF (all labels+invoices)
 *      2) Per-SKU PDFs (labels+invoices)
 *      3) Picklist PDF
 *      4) ZIP with all of the above
 */
app.post("/crop", async (req, res) => {
  try {
    const {
      pdfFilename,
      mappingFilename,
      labelBox,
      invoiceBox,
      orderIdsByPage = [],
    } = req.body;

    if (!pdfFilename) {
      return res.status(400).json({ error: "Missing pdfFilename" });
    }
    if (!labelBox || !invoiceBox) {
      return res.status(400).json({ error: "Missing crop boxes" });
    }

    const normalizeBox = (box) => ({
      x: Number(box.x),
      y: Number(box.y),
      width: Number(box.width),
      height: Number(box.height),
    });

    const label = normalizeBox(labelBox);
    const invoice = normalizeBox(invoiceBox);

    if (
      !label.width ||
      !label.height ||
      !invoice.width ||
      !invoice.height ||
      label.width <= 0 ||
      label.height <= 0 ||
      invoice.width <= 0 ||
      invoice.height <= 0
    ) {
      return res.status(400).json({
        error: "Invalid crop dimensions (width/height must be > 0)",
      });
    }

    // Load input PDF
    const pdfPath = path.join(UPLOAD_DIR, pdfFilename);
    const pdfData = await fsPromises.readFile(pdfPath);
    const inputPdf = await PDFDocument.load(pdfData);

    // Combined output PDF
    const combinedPdf = await PDFDocument.create();
    const combinedFont = await combinedPdf.embedFont(StandardFonts.Helvetica);

    // 1) Order Id → CSV row map
    let orderMap = {};
    if (mappingFilename) {
      const csvPath = path.join(UPLOAD_DIR, mappingFilename);
      const csvBuffer = await fsPromises.readFile(csvPath);
      orderMap = buildOrderMapFromCSV(csvBuffer);
    }

    // 2) SKU corrections from Firestore
    let skuCorrectionMap = {};
    const snapshot = await db.collection("skuCorrections").get();
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.oldSku && data.newSku) {
        skuCorrectionMap[data.oldSku] = data.newSku;
      }
    });

    // 3) Picklist aggregation: finalSku -> { sku, qty, product }
    const picklistMap = {};

    const pageCount = inputPdf.getPageCount();

    // ---- Prepare jobs (one per original page) ----
    const jobs = [];

    for (let i = 0; i < pageCount; i++) {
      const orderId = orderIdsByPage[i];
      const row = orderId ? orderMap[orderId] || {} : {};

      const rawSku = (row["SKU"] || "").toString().trim();

      let finalSku = rawSku;
      if (rawSku && skuCorrectionMap[rawSku]) {
        finalSku = skuCorrectionMap[rawSku];
      }

      const qtyRaw =
        (row["Quantity"] ||
          row["Qty"] ||
          row["quantity"] ||
          row["qty"] ||
          "").toString().trim();

      const productName =
        (row["Product"] ||
          row["Product Name"] ||
          row["Description"] ||
          "").toString().trim();

      const qtyNum = parseInt(qtyRaw || "0", 10) || 0;
      if (finalSku && qtyNum > 0) {
        if (!picklistMap[finalSku]) {
          picklistMap[finalSku] = {
            sku: finalSku,
            qty: 0,
            product: productName || "",
          };
        }
        picklistMap[finalSku].qty += qtyNum;
      }

      jobs.push({
        pageIndex: i,
        orderId,
        rawSku,
        finalSku,
        qtyRaw,
        productName,
      });
    }

    // ---- Sort jobs: group by SKU, then by original page index ----
    const withSku = jobs.filter((j) => j.finalSku);
    const withoutSku = jobs.filter((j) => !j.finalSku);

    withSku.sort((a, b) => {
      const cmp = a.finalSku.localeCompare(b.finalSku);
      if (cmp !== 0) return cmp;
      return a.pageIndex - b.pageIndex;
    });

    const sortedJobs = [...withSku, ...withoutSku];

    // ---- Per-SKU docs: skuKey -> { pdfDoc, font } ----
    const perSkuDocs = {};

    const getSkuKey = (finalSku) => {
      if (finalSku && finalSku.trim() !== "") return finalSku.trim();
      return "NO_SKU";
    };

    const sanitizeFileName = (name) => {
      return name.replace(/[^a-zA-Z0-9_\-]+/g, "-").substring(0, 80) || "UNKNOWN";
    };

    // ---- Generate combined & per-SKU PDFs ----
    for (const job of sortedJobs) {
      const i = job.pageIndex;

      // ---------- Combined PDF ----------
      const [combinedSrcPage] = await combinedPdf.copyPages(inputPdf, [i]);
      const { height } = combinedSrcPage.getSize();
      const combinedEmbedded = await combinedPdf.embedPage(combinedSrcPage);

      const combinedLabelPage = combinedPdf.addPage([
        label.width,
        label.height,
      ]);
      const combinedInvoicePage = combinedPdf.addPage([
        invoice.width,
        invoice.height,
      ]);

      // Label crop combined
      combinedLabelPage.drawPage(combinedEmbedded, {
        x: -label.x,
        y: -(height - label.y - label.height),
      });

      // Invoice crop combined
      combinedInvoicePage.drawPage(combinedEmbedded, {
        x: -invoice.x,
        y: -(height - invoice.y - invoice.height),
      });

      // Label text
      let labelText = job.finalSku;
      if (job.finalSku && job.qtyRaw) {
        labelText = `${job.finalSku} (${job.qtyRaw})`;
      }

      if (labelText) {
        const fontSize = 6;
        const textX = 5;
        const textY = 4;

        combinedLabelPage.drawText(labelText, {
          x: textX,
          y: textY,
          font: combinedFont,
          size: fontSize,
          color: rgb(0, 0, 0),
        });
      }

      // ---------- Per-SKU PDF ----------
      const skuKey = getSkuKey(job.finalSku);

      if (!perSkuDocs[skuKey]) {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        perSkuDocs[skuKey] = { pdfDoc, font };
      }

      const { pdfDoc: skuDoc, font: skuFont } = perSkuDocs[skuKey];

      const [skuSrcPage] = await skuDoc.copyPages(inputPdf, [i]);
      const { height: skuHeight } = skuSrcPage.getSize();
      const skuEmbedded = await skuDoc.embedPage(skuSrcPage);

      const skuLabelPage = skuDoc.addPage([label.width, label.height]);
      const skuInvoicePage = skuDoc.addPage([invoice.width, invoice.height]);

      // Label crop per-SKU
      skuLabelPage.drawPage(skuEmbedded, {
        x: -label.x,
        y: -(skuHeight - label.y - label.height),
      });

      // Invoice crop per-SKU
      skuInvoicePage.drawPage(skuEmbedded, {
        x: -invoice.x,
        y: -(skuHeight - invoice.y - invoice.height),
      });

      // Label text per-SKU
      if (labelText) {
        const fontSize = 6;
        const textX = 5;
        const textY = 4;

        skuLabelPage.drawText(labelText, {
          x: textX,
          y: textY,
          font: skuFont,
          size: fontSize,
          color: rgb(0, 0, 0),
        });
      }
    }

    // -------- Save combined PDF --------
    const combinedBytes = await combinedPdf.save();
    const combinedName = `output-${pdfFilename}.pdf`;
    const combinedPath = path.join(OUTPUT_DIR, combinedName);
    await fsPromises.writeFile(combinedPath, combinedBytes);

    // -------- Save per-SKU PDFs --------
    const perSkuFileNames = [];
    for (const [skuKey, { pdfDoc }] of Object.entries(perSkuDocs)) {
      const safeSku = sanitizeFileName(skuKey);
      const fileName = `labels_invoices_${safeSku}.pdf`;
      const filePath = path.join(OUTPUT_DIR, fileName);
      const bytes = await pdfDoc.save();
      await fsPromises.writeFile(filePath, bytes);
      perSkuFileNames.push(fileName);
    }

    // -------- Build Picklist PDF (with wrapped product names) --------
    const picklistDoc = await PDFDocument.create();
    const pickFont = await picklistDoc.embedFont(StandardFonts.Helvetica);

    // A4 size in points
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    let pickPage = picklistDoc.addPage([pageWidth, pageHeight]);

    let y = pageHeight - 50;
    const marginX = 40;
    const lineHeight = 14;
    const pickFontSize = 8;

    // Column X positions
    const colSnoX = marginX;
    const colSkuX = marginX + 40;
    const colQtyX = marginX + 200;
    const colProductX = marginX + 240;
    const maxProductWidth = pageWidth - colProductX - 40;

    // Title
    pickPage.drawText("Picklist", {
      x: marginX,
      y,
      size: 16,
      font: pickFont,
      color: rgb(0, 0, 0),
    });
    y -= lineHeight * 2;

    function drawHeaders(page) {
      page.drawText("S.No", { x: colSnoX, y, size: pickFontSize, font: pickFont });
      page.drawText("SKU", { x: colSkuX, y, size: pickFontSize, font: pickFont });
      page.drawText("Qty", { x: colQtyX, y, size: pickFontSize, font: pickFont });
      page.drawText("Product", {
        x: colProductX,
        y,
        size: pickFontSize,
        font: pickFont,
      });
    }

    // Headers – first page
    drawHeaders(pickPage);
    y -= lineHeight;

    const pickItems = Object.values(picklistMap).sort((a, b) =>
      a.sku.localeCompare(b.sku)
    );

    let index = 1;
    for (const item of pickItems) {
      const productText = item.product || "";

      // Wrap product text into multiple lines
      const productLines = wrapTextIntoLines(
        productText,
        maxProductWidth,
        pickFont,
        pickFontSize
      );

      const neededHeight = productLines.length * lineHeight;

      // If not enough space, new page
      if (y - neededHeight < 40) {
        pickPage = picklistDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - 50;
        drawHeaders(pickPage);
        y -= lineHeight;
      }

      // First line: S.No, SKU, Qty, first product line
      pickPage.drawText(String(index), {
        x: colSnoX,
        y,
        size: pickFontSize,
        font: pickFont,
      });
      pickPage.drawText(item.sku, {
        x: colSkuX,
        y,
        size: pickFontSize,
        font: pickFont,
      });
      pickPage.drawText(String(item.qty), {
        x: colQtyX,
        y,
        size: pickFontSize,
        font: pickFont,
      });
      pickPage.drawText(productLines[0] || "", {
        x: colProductX,
        y,
        size: pickFontSize,
        font: pickFont,
      });

      // Additional product lines (only product column)
      for (let li = 1; li < productLines.length; li++) {
        y -= lineHeight;

        if (y < 40) {
          pickPage = picklistDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - 50;
          drawHeaders(pickPage);
          y -= lineHeight;
        }

        pickPage.drawText(productLines[li], {
          x: colProductX,
          y,
          size: pickFontSize,
          font: pickFont,
        });
      }

      y -= lineHeight;
      index++;
    }

    const pickBytes = await picklistDoc.save();
    const pickName = `picklist-${pdfFilename}.pdf`;
    const pickPath = path.join(OUTPUT_DIR, pickName);
    await fsPromises.writeFile(pickPath, pickBytes);

    // -------- Build ZIP with all PDFs --------
    const zipName = `batch-${pdfFilename}.zip`;
    const zipPath = path.join(OUTPUT_DIR, zipName);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);

      archive.pipe(output);

      // Add combined PDF
      archive.file(combinedPath, { name: combinedName });

      // Add picklist PDF
      archive.file(pickPath, { name: pickName });

      // Add per-SKU PDFs
      for (const fileName of perSkuFileNames) {
        archive.file(path.join(OUTPUT_DIR, fileName), { name: fileName });
      }

      archive.finalize();
    });

    // -------- Response --------
    res.json({
      fullOutputUrl: `/outputs/${combinedName}`,
      picklistUrl: `/outputs/${pickName}`,
      zipUrl: `/outputs/${zipName}`,
      skuFiles: perSkuFileNames.map((f) => `/outputs/${f}`),
    });
  } catch (err) {
    console.error("Crop error", err);
    res
      .status(500)
      .json({ error: `Crop failed: ${err.message || "Unknown error"}` });
  }
});

// ----------------- Start server -----------------
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () =>
  console.log(`Server running on port ${port}`)
);
