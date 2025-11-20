// app.js
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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
 *    orderIdsByPage: [ "OD...", "OD...", ... ],
 *    removeDuplicates: true | false
 *  }
 */
app.post("/crop", async (req, res) => {
  try {
    const {
      pdfFilename,
      mappingFilename,
      labelBox,
      invoiceBox,
      orderIdsByPage = [],
      removeDuplicates = false, // NEW
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
    const outPdf = await PDFDocument.create();
    const font = await outPdf.embedFont(StandardFonts.Helvetica);

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
    const seenOrderIds = new Set(); // NEW

    for (let i = 0; i < pageCount; i++) {
      const orderId = orderIdsByPage[i];

      // NEW: skip duplicate orders if user chose to remove
      if (removeDuplicates && orderId && seenOrderIds.has(orderId)) {
        console.log("Skipping duplicate order:", orderId, "on page", i + 1);
        continue;
      }
      if (orderId) {
        seenOrderIds.add(orderId);
      }

      const [page] = await outPdf.copyPages(inputPdf, [i]);
      const { height } = page.getSize();

      const labelPage = outPdf.addPage([label.width, label.height]);
      const invoicePage = outPdf.addPage([invoice.width, invoice.height]);

      const embedded = await outPdf.embedPage(page);

      // ===== LABEL CROP =====
      labelPage.drawPage(embedded, {
        x: -label.x,
        y: -(height - label.y - label.height),
      });

      // Get row via Order Id
      const row = orderId ? orderMap[orderId] || {} : {};

      // --- SKU & quantity for this page/order ---
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

      // Try to get product name
      const productName =
        (row["Product"] ||
          row["Product Name"] ||
          row["Description"] ||
          "").toString().trim();

      // Label text: "k8 microphone (10)" or just "k8 microphone"
      let labelText = finalSku;
      if (finalSku && qtyRaw) {
        labelText = `${finalSku} (${qtyRaw})`;
      }

      if (labelText) {
        const fontSize = 6;
        const textX = 5;
        const textY = 4; // bottom-left-ish

        labelPage.drawText(labelText, {
          x: textX,
          y: textY,
          font,
          size: fontSize,
          color: rgb(0, 0, 0),
        });
      }

      // --- Aggregate into picklist map ---
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

      // ===== INVOICE CROP =====
      invoicePage.drawPage(embedded, {
        x: -invoice.x,
        y: -(height - invoice.y - invoice.height),
      });
    }

    // -------- Save cropped PDF (labels+invoices) --------
    const pdfBytes = await outPdf.save();
    const outputName = `output-${pdfFilename}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, outputName);
    await fsPromises.writeFile(outputPath, pdfBytes);

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
    const fontSize = 8;

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
      page.drawText("S.No", { x: colSnoX, y, size: fontSize, font: pickFont });
      page.drawText("SKU", { x: colSkuX, y, size: fontSize, font: pickFont });
      page.drawText("Qty", { x: colQtyX, y, size: fontSize, font: pickFont });
      page.drawText("Product", {
        x: colProductX,
        y,
        size: fontSize,
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
        fontSize
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
        size: fontSize,
        font: pickFont,
      });
      pickPage.drawText(item.sku, {
        x: colSkuX,
        y,
        size: fontSize,
        font: pickFont,
      });
      pickPage.drawText(String(item.qty), {
        x: colQtyX,
        y,
        size: fontSize,
        font: pickFont,
      });
      pickPage.drawText(productLines[0] || "", {
        x: colProductX,
        y,
        size: fontSize,
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
          size: fontSize,
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

    // -------- Response: both PDFs --------
    res.json({
      outputUrl: `/outputs/${outputName}`,
      picklistUrl: `/outputs/${pickName}`,
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
