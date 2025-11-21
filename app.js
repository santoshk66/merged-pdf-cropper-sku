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
 *    orderIdsByPage: [ "OD...", "OD...", ... ],
 *    removeDuplicates: boolean
 *  }
 *
 * Behaviour:
 *  - Crops label + invoice for every page.
 *  - Maps SKUs using CSV + Firestore correction DB.
 *  - Removes duplicate Order Ids if removeDuplicates = true.
 *  - Sorts pages by SKU so same SKU labels come one after another.
 *  - Creates picklist PDF.
 *  - For any SKU with > 5 orders, creates a separate PDF for that SKU.
 *  - Returns a ZIP with: combined.pdf + picklist.pdf + per-SKU PDFs.
 */
app.post("/crop", async (req, res) => {
  try {
    const {
      pdfFilename,
      mappingFilename,
      labelBox,
      invoiceBox,
      orderIdsByPage = [],
      removeDuplicates = false,
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

    // 3) Build metadata per original page
    const pageCount = inputPdf.getPageCount();

    let pagesMeta = [];
    for (let i = 0; i < pageCount; i++) {
      const orderId = orderIdsByPage[i] || null;
      const row = orderId ? orderMap[orderId] || {} : {};

      const rawSku = (row["SKU"] || "").toString().trim();
      let finalSku = rawSku;
      if (rawSku && skuCorrectionMap[rawSku]) {
        finalSku = skuCorrectionMap[rawSku];
      }
      if (!finalSku) finalSku = ""; // some pages may not have mapping

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

      pagesMeta.push({
        pageIndex: i,
        orderId,
        row,
        rawSku,
        finalSku,
        qtyRaw,
        productName,
      });
    }

    // 4) Remove duplicate Order Ids if requested
    if (removeDuplicates) {
      const seenOrders = new Set();
      pagesMeta = pagesMeta.filter((meta) => {
        if (!meta.orderId) return true; // keep pages without Order Id
        if (seenOrders.has(meta.orderId)) return false;
        seenOrders.add(meta.orderId);
        return true;
      });
    }

    // 5) Aggregate per-SKU for picklist & for per-SKU PDFs
    const picklistMap = {}; // finalSku -> { sku, qty, product }
    const skuPages = {}; // finalSku -> [meta]

    for (const meta of pagesMeta) {
      const skuKey = meta.finalSku || "UNKNOWN";

      if (!skuPages[skuKey]) skuPages[skuKey] = [];
      skuPages[skuKey].push(meta);

      const qtyNum = parseInt(meta.qtyRaw || "0", 10) || 0;
      if (skuKey && qtyNum > 0) {
        if (!picklistMap[skuKey]) {
          picklistMap[skuKey] = {
            sku: skuKey,
            qty: 0,
            product: meta.productName || "",
          };
        }
        picklistMap[skuKey].qty += qtyNum;
      }
    }

    // 6) Create combined output PDF, sorted by SKU (and then by order)
    const outPdf = await PDFDocument.create();
    const font = await outPdf.embedFont(StandardFonts.Helvetica);

    const sortedMeta = pagesMeta.slice().sort((a, b) => {
      const skuA = a.finalSku || "";
      const skuB = b.finalSku || "";
      if (skuA !== skuB) return skuA.localeCompare(skuB);
      const orderA = a.orderId || "";
      const orderB = b.orderId || "";
      if (orderA !== orderB) return orderA.localeCompare(orderB);
      return a.pageIndex - b.pageIndex;
    });

    for (const meta of sortedMeta) {
      const [page] = await outPdf.copyPages(inputPdf, [meta.pageIndex]);
      const { height } = page.getSize();
      const embedded = await outPdf.embedPage(page);

      const labelPage = outPdf.addPage([label.width, label.height]);
      const invoicePage = outPdf.addPage([invoice.width, invoice.height]);

      // LABEL CROP
      labelPage.drawPage(embedded, {
        x: -label.x,
        y: -(height - label.y - label.height),
      });

      // Label text: "sku (qty)" or just "sku"
      let labelText = meta.finalSku;
      if (meta.finalSku && meta.qtyRaw) {
        labelText = `${meta.finalSku} (${meta.qtyRaw})`;
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

      // INVOICE CROP
      invoicePage.drawPage(embedded, {
        x: -invoice.x,
        y: -(height - invoice.y - invoice.height),
      });
    }

    // -------- Save combined PDF (labels+invoices) --------
    const combinedBytes = await outPdf.save();
    const combinedName = `output-${pdfFilename}.pdf`;
    const combinedPath = path.join(OUTPUT_DIR, combinedName);
    await fsPromises.writeFile(combinedPath, combinedBytes);

    // 7) Build Picklist PDF (with wrapped product names)
    const picklistDoc = await PDFDocument.create();
    const pickFont = await picklistDoc.embedFont(StandardFonts.Helvetica);

    const pageWidth = 595.28; // A4
    const pageHeight = 841.89;
    let pickPage = picklistDoc.addPage([pageWidth, pageHeight]);

    let y = pageHeight - 50;
    const marginX = 40;
    const lineHeight = 12;
    const fontSize = 8;

    const colSnoX = marginX;
    const colSkuX = marginX + 40;
    const colQtyX = marginX + 200;
    const colProductX = marginX + 240;
    const maxProductWidth = pageWidth - colProductX - 40;

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

    drawHeaders(pickPage);
    y -= lineHeight;

    const pickItems = Object.values(picklistMap).sort((a, b) =>
      a.sku.localeCompare(b.sku)
    );

    let index = 1;
    for (const item of pickItems) {
      const productText = item.product || "";
      const productLines = wrapTextIntoLines(
        productText,
        maxProductWidth,
        pickFont,
        fontSize
      );

      const neededHeight = productLines.length * lineHeight;

      if (y - neededHeight < 40) {
        pickPage = picklistDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - 50;
        drawHeaders(pickPage);
        y -= lineHeight;
      }

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

    // 8) Per-SKU PDFs for SKUs with > 5 orders
    const perSkuFiles = [];
    const skuEntries = Object.entries(skuPages);

    for (const [skuKey, metaList] of skuEntries) {
      if (metaList.length <= 5) continue; // ONLY > 5 orders

      const skuDoc = await PDFDocument.create();
      const skuFont = await skuDoc.embedFont(StandardFonts.Helvetica);

      for (const meta of metaList) {
        const [page] = await skuDoc.copyPages(inputPdf, [meta.pageIndex]);
        const { height } = page.getSize();
        const embedded = await skuDoc.embedPage(page);

        const labelPage = skuDoc.addPage([label.width, label.height]);
        const invoicePage = skuDoc.addPage([invoice.width, invoice.height]);

        // LABEL CROP
        labelPage.drawPage(embedded, {
          x: -label.x,
          y: -(height - label.y - label.height),
        });

        let labelText = meta.finalSku;
        if (meta.finalSku && meta.qtyRaw) {
          labelText = `${meta.finalSku} (${meta.qtyRaw})`;
        }

        if (labelText) {
          labelPage.drawText(labelText, {
            x: 5,
            y: 4,
            font: skuFont,
            size: 6,
            color: rgb(0, 0, 0),
          });
        }

        // INVOICE CROP
        invoicePage.drawPage(embedded, {
          x: -invoice.x,
          y: -(height - invoice.y - invoice.height),
        });
      }

      const skuBytes = await skuDoc.save();
      const safeSku = (skuKey || "UNKNOWN").replace(/[^a-zA-Z0-9-_]/g, "_");
      const skuFilename = `sku-${safeSku}.pdf`;
      const skuPath = path.join(OUTPUT_DIR, skuFilename);
      await fsPromises.writeFile(skuPath, skuBytes);
      perSkuFiles.push(skuFilename);
    }

    // 9) Build ZIP: combined + picklist + per-SKU PDFs
    const zipName = `bundle-${pdfFilename}.zip`;
    const zipPath = path.join(OUTPUT_DIR, zipName);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);

      archive.pipe(output);

      // add main files
      archive.file(combinedPath, {
        name: "combined_labels_invoices.pdf",
      });
      archive.file(pickPath, {
        name: "picklist.pdf",
      });

      // add per-SKU files inside a folder
      for (const f of perSkuFiles) {
        archive.file(path.join(OUTPUT_DIR, f), {
          name: `per_sku/${f}`,
        });
      }

      archive.finalize();
    });

    // -------- Response: ZIP + main URLs (for fallback/debug) --------
    res.json({
      zipUrl: `/outputs/${zipName}`,
      fullOutputUrl: `/outputs/${combinedName}`,
      picklistUrl: `/outputs/${pickName}`,
      perSkuFiles: perSkuFiles.map((f) => `/outputs/${f}`),
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
