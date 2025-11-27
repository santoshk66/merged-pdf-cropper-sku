// app.js
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import AdmZip from "adm-zip";
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

// ----------------- Helper: wrap product text for picklist & headers -----------------
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
      const safeDocId = oldSku.replace(/\//g, "_");

      const docRef = collectionRef.doc(safeDocId);
      batch.set(
        docRef,
        {
          oldSku,
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
 *    orderIdsByPage:   [ "OD...", "OD...", ... ],
 *    trackingIdsByPage:[ "FMPP...", null, ... ],   // NEW
 *    removeDuplicates: boolean
 *  }
 *
 * Behaviour for duplicates:
 *  - If Order Id appears once in CSV → use that row (ignore tracking).
 *  - If Order Id appears multiple times in CSV → use Tracking ID to pick
 *    the correct row. If still ambiguous → round-robin through rows.
 */
app.post("/crop", async (req, res) => {
  try {
    const {
      pdfFilename,
      mappingFilename,
      labelBox,
      invoiceBox,
      orderIdsByPage = [],
      trackingIdsByPage = [],
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

    const pageCount = inputPdf.getPageCount();

    // ---------- 1) CSV order + tracking maps ----------
    let orderMap = {};
    let trackingMap = {}; // trackingId -> [{ orderId, row }, ...]
    let duplicateOrderIds = [];
    let duplicateTrackingIds = [];

    if (mappingFilename) {
      const csvPath = path.join(UPLOAD_DIR, mappingFilename);
      const csvBuffer = await fsPromises.readFile(csvPath);
      orderMap = buildOrderMapFromCSV(csvBuffer); // should be orderId -> [rows]

      for (const [orderId, rowsOrRow] of Object.entries(orderMap)) {
        const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];

        // Duplicate Order Ids in CSV
        if (rows.length > 1) {
          duplicateOrderIds.push(orderId);
        }

        // Build tracking map
        for (const row of rows) {
          const trackingRaw =
            (row["Tracking ID"] ||
              row["Tracking Id"] ||
              row["tracking id"] ||
              row["TrackingID"] ||
              "").toString().trim();

          if (!trackingRaw) continue;

          if (!trackingMap[trackingRaw]) {
            trackingMap[trackingRaw] = [];
          }
          trackingMap[trackingRaw].push({ orderId, row });
        }
      }

      // Duplicate Tracking IDs in CSV
      for (const [tid, arr] of Object.entries(trackingMap)) {
        if (arr.length > 1) {
          duplicateTrackingIds.push(tid);
        }
      }
    }

    // ---------- 2) SKU corrections from Firestore ----------
    let skuCorrectionMap = {};
    const snapshot = await db.collection("skuCorrections").get();
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.oldSku && data.newSku) {
        skuCorrectionMap[data.oldSku] = data.newSku;
      }
    });

    // ---------- 3) Picklist aggregation: finalSku -> { sku, qty, product } ----------
    const picklistMap = {};

    // Build jobs array, with optional duplicate removal
    const jobs = [];
    const seenOrderIds = new Set();
    const orderUsageCount = {}; // for round-robin when one Order Id has multiple rows

    for (let i = 0; i < pageCount; i++) {
      const orderId = orderIdsByPage[i] || null;
      const trackingId = trackingIdsByPage[i] || null;

      // Optional: remove duplicate labels for the SAME Order Id (per PDF)
      if (removeDuplicates && orderId) {
        if (seenOrderIds.has(orderId)) {
          continue;
        }
        seenOrderIds.add(orderId);
      }

      let row = {};

      if (orderId && orderMap[orderId]) {
        const rowsForOrderRaw = orderMap[orderId];
        const rowsForOrder = Array.isArray(rowsForOrderRaw)
          ? rowsForOrderRaw
          : [rowsForOrderRaw];

        if (rowsForOrder.length === 1) {
          // Simple: unique Order Id in CSV → ignore trackingId completely
          row = rowsForOrder[0];
        } else {
          // 🔁 DUPLICATE Order Id in CSV → NOW we use Tracking ID
          if (trackingId && trackingMap[trackingId]) {
            // Find rows which match both orderId & trackingId
            const candidates = trackingMap[trackingId].filter(
              (entry) => entry.orderId === orderId
            );

            if (candidates.length === 1) {
              row = candidates[0].row;
            } else {
              // Still ambiguous → round-robin over rowsForOrder
              const used = orderUsageCount[orderId] || 0;
              const idx = used % rowsForOrder.length;
              row = rowsForOrder[idx];
              orderUsageCount[orderId] = used + 1;
            }
          } else {
            // No tracking ID / no match → round-robin
            const used = orderUsageCount[orderId] || 0;
            const idx = used % rowsForOrder.length;
            row = rowsForOrder[idx];
            orderUsageCount[orderId] = used + 1;
          }
        }
      } else {
        // Order Id missing or not in CSV.
        // As per your requirement: DO NOT map by tracking-only here.
        row = {};
      }

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
        trackingId,
        rawSku,
        finalSku,
        qtyRaw,
        productName,
      });
    }

    if (jobs.length === 0) {
      return res.status(400).json({
        error:
          "No pages to process after applying duplicate removal / mapping. Check CSV & PDF.",
      });
    }

    // ---- Sort jobs by SKU so labels are in sequence ----
    const withSku = jobs.filter((j) => j.finalSku);
    const withoutSku = jobs.filter((j) => !j.finalSku);

    withSku.sort((a, b) => {
      const cmp = a.finalSku.localeCompare(b.finalSku);
      if (cmp !== 0) return cmp;
      return a.pageIndex - b.pageIndex;
    });

    const sortedJobs = [...withSku, ...withoutSku];

    // ---- Count jobs per SKU for threshold 5 ----
    const skuCounts = {};
    for (const job of jobs) {
      if (!job.finalSku) continue;
      if (!skuCounts[job.finalSku]) skuCounts[job.finalSku] = 0;
      skuCounts[job.finalSku]++;
    }

    // ---- Create PDFs ----
    const fullDoc = await PDFDocument.create();
    const fullFont = await fullDoc.embedFont(StandardFonts.Helvetica);

    const smallDoc = await PDFDocument.create();
    const smallFont = await smallDoc.embedFont(StandardFonts.Helvetica);

    const skuDocs = {}; // sku -> { doc, font }

    async function addCroppedPagesForJob(targetDoc, font, job) {
      const [page] = await targetDoc.copyPages(inputPdf, [job.pageIndex]);
      const { height } = page.getSize();

      const embedded = await targetDoc.embedPage(page);

      // LABEL page
      const labelPage = targetDoc.addPage([label.width, label.height]);
      labelPage.drawPage(embedded, {
        x: -label.x,
        y: -(height - label.y - label.height),
      });

      let labelText = job.finalSku || job.rawSku || "";
      if (labelText && job.qtyRaw) {
        labelText = `${labelText} (${job.qtyRaw})`;
      }
      if (labelText) {
        const fontSize = 6;
        labelPage.drawText(labelText, {
          x: 5,
          y: 4,
          font,
          size: fontSize,
          color: rgb(0, 0, 0),
        });
      }

      // INVOICE page
      const invoicePage = targetDoc.addPage([invoice.width, invoice.height]);
      invoicePage.drawPage(embedded, {
        x: -invoice.x,
        y: -(height - invoice.y - invoice.height),
      });
    }

    // ---- MAIN LOOP over sortedJobs ----
    let lastGroupKey = null;

    for (const job of sortedJobs) {
      const groupKey = job.finalSku || job.rawSku || "NO_SKU";

      if (groupKey !== lastGroupKey) {
        const headerPage = fullDoc.addPage([label.width, label.height]);
        const { width: hpw, height: hph } = headerPage.getSize();

        const headerText =
          groupKey === "NO_SKU" ? "NO SKU / UNKNOWN" : groupKey;

        const headerFontSize = 12;
        const headerLineHeight = headerFontSize * 1.3;

        const maxHeaderWidth = hpw - 40;

        const headerLines = wrapTextIntoLines(
          headerText,
          maxHeaderWidth,
          fullFont,
          headerFontSize
        );

        const totalHeaderHeight = headerLines.length * headerLineHeight;
        let headerY = (hph + totalHeaderHeight) / 2 - headerLineHeight;

        for (const line of headerLines) {
          const lineWidth = fullFont.widthOfTextAtSize(
            line,
            headerFontSize
          );
          const headerX = (hpw - lineWidth) / 2;

          headerPage.drawText(line, {
            x: headerX,
            y: headerY,
            font: fullFont,
            size: headerFontSize,
            color: rgb(0, 0, 0),
          });

          headerY -= headerLineHeight;
        }

        lastGroupKey = groupKey;
      }

      // Full combined
      await addCroppedPagesForJob(fullDoc, fullFont, job);

      const sku = job.finalSku;
      const count = sku ? skuCounts[sku] || 0 : 0;

      if (sku && count >= 5) {
        if (!skuDocs[sku]) {
          const doc = await PDFDocument.create();
          const font = await doc.embedFont(StandardFonts.Helvetica);
          skuDocs[sku] = { doc, font };
        }
        await addCroppedPagesForJob(skuDocs[sku].doc, skuDocs[sku].font, job);
      } else {
        await addCroppedPagesForJob(smallDoc, smallFont, job);
      }
    }

    // -------- Build Picklist PDF (with wrapped product names) --------
    const picklistDoc = await PDFDocument.create();
    const pickFont = await picklistDoc.embedFont(StandardFonts.Helvetica);

    const pageWidth = 595.28;
    const pageHeight = 841.89;
    let pickPage = picklistDoc.addPage([pageWidth, pageHeight]);

    let y = pageHeight - 50;
    const marginX = 40;
    const lineHeight = 14;
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

    // ---- Picklist items sorted by qty DESC (big → small) ----
    const pickItemsArray = Object.values(picklistMap);
    const pickItemsSorted = pickItemsArray.sort((a, b) => {
      const diff = (b.qty || 0) - (a.qty || 0);
      if (diff !== 0) return diff;
      return a.sku.localeCompare(b.sku);
    });

    let index = 1;
    for (const item of pickItemsSorted) {
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

    // -------- Create ZIP with all PDFs in memory --------
    const zip = new AdmZip();

    const fullBytes = await fullDoc.save();
    zip.addFile("1_full_combined.pdf", Buffer.from(fullBytes));

    if (pickItemsSorted.length > 0) {
      const pickBytes = await picklistDoc.save();
      zip.addFile("2_picklist.pdf", Buffer.from(pickBytes));
    }

    if (smallDoc.getPageCount() > 0) {
      const smallBytes = await smallDoc.save();
      zip.addFile("3_combined_small_skus.pdf", Buffer.from(smallBytes));
    }

    const sortedSkuKeys = Object.keys(skuDocs).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const sku of sortedSkuKeys) {
      const { doc } = skuDocs[sku];
      if (doc.getPageCount() === 0) continue;
      const bytes = await doc.save();
      const safeSku = sku.replace(/[^a-zA-Z0-9_\-]+/g, "_");
      const filename = `sku_${safeSku}.pdf`;
      zip.addFile(filename, Buffer.from(bytes));
    }

    const zipName = `bundle-${pdfFilename}.zip`;
    const zipPath = path.join(OUTPUT_DIR, zipName);
    zip.writeZip(zipPath);

    // -------- Build picklist JSON (qty DESC) --------
    const picklistJson = pickItemsSorted.map((item) => ({
      sku: item.sku,
      requiredQty: item.qty,
      pickedQty: 0,
      remaining: item.qty,
      product: item.product || "",
    }));

    const totalUnits = picklistJson.reduce(
      (sum, it) => sum + (Number(it.requiredQty) || 0),
      0
    );
    const totalSkus = picklistJson.length;

    const now = Date.now();
    const picklistId = `pl_${now}`;

    // Save picklist in Firestore (for dashboard)
    await db.collection("picklists").doc(picklistId).set({
      picklistId,
      pdfFilename,
      mappingFilename: mappingFilename || null,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      items: picklistJson,
      totalUnits,
      totalSkus,
    });

    // -------- Respond --------
    res.json({
      zipUrl: `/outputs/${zipName}`,
      picklist: picklistJson,
      picklistId,
      duplicateOrderIds,
      duplicateTrackingIds,
    });
  } catch (err) {
    console.error("Crop error", err);
    res
      .status(500)
      .json({ error: `Crop failed: ${err.message || "Unknown error"}` });
  }
});

// ----------------- Picklist APIs (Firestore-backed) -----------------

// Get a single picklist by id
app.get("/picklist/:id", async (req, res) => {
  try {
    const doc = await db.collection("picklists").doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Picklist not found" });
    }
    res.json(doc.data());
  } catch (err) {
    console.error("Error fetching picklist:", err);
    res.status(500).json({ error: "Failed to fetch picklist" });
  }
});

// Get latest (most recent) picklist – kept for backward compatibility
app.get("/picklist-latest", async (req, res) => {
  try {
    const snap = await db
      .collection("picklists")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "No picklists found" });
    }

    const doc = snap.docs[0];
    res.json(doc.data());
  } catch (err) {
    console.error("Error fetching latest picklist:", err);
    res.status(500).json({ error: "Failed to fetch latest picklist" });
  }
});

// List picklists by createdAt range (for date filters)
app.get("/picklists", async (req, res) => {
  try {
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;

    let q = db.collection("picklists").orderBy("createdAt", "desc");

    if (from) {
      q = q.where("createdAt", ">=", from);
    }
    if (to) {
      q = q.where("createdAt", "<=", to);
    }

    const snap = await q.get();
    const list = snap.docs.map((d) => d.data());

    res.json(list);
  } catch (err) {
    console.error("Error listing picklists:", err);
    res.status(500).json({ error: "Failed to list picklists" });
  }
});

// Update picklist items + status (Fulfilled, Pending, etc.)
app.post("/picklist/:id", async (req, res) => {
  try {
    const { items, status } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items must be an array" });
    }

    const totalUnits = items.reduce(
      (sum, it) => sum + (Number(it.requiredQty) || 0),
      0
    );
    const totalSkus = items.length;

    await db.collection("picklists").doc(req.params.id).update({
      items,
      status: status || "pending",
      updatedAt: Date.now(),
      totalUnits,
      totalSkus,
    });

    res.json({ message: "Picklist updated" });
  } catch (err) {
    console.error("Error updating picklist:", err);
    res.status(500).json({ error: "Failed to update picklist" });
  }
});

// ----------------- Transfer Tasks (Another Office Picklist) -----------------

/**
 * A "transfer task" = some quantity of a SKU from a picklist
 * that should be brought from another office.
 *
 * Firestore collection: transferTasks
 * Fields:
 *  - picklistId
 *  - sku
 *  - product
 *  - assignedQty
 *  - fulfilledQty
 *  - status: 'pending' | 'partial' | 'fulfilled'
 *  - createdAt, updatedAt
 */

// Create a transfer task from the main picklist page
app.post("/transfer-tasks", async (req, res) => {
  try {
    const { picklistId, sku, product, assignedQty } = req.body;

    if (!picklistId || !sku) {
      return res
        .status(400)
        .json({ error: "picklistId and sku are required" });
    }

    const qtyNum = Number(assignedQty);
    if (!qtyNum || qtyNum <= 0) {
      return res
        .status(400)
        .json({ error: "assignedQty must be a positive number" });
    }

    const now = Date.now();

    const docRef = await db.collection("transferTasks").add({
      picklistId,
      sku,
      product: product || "",
      assignedQty: qtyNum,
      fulfilledQty: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    res.json({
      id: docRef.id,
      message: "Transfer task created successfully",
    });
  } catch (err) {
    console.error("Error creating transfer task:", err);
    res.status(500).json({ error: "Failed to create transfer task" });
  }
});

// List transfer tasks (for other office page)
// Query params:
//   status = pending | partial | fulfilled (optional)
//   from, to = timestamps in ms (optional)
app.get("/transfer-tasks", async (req, res) => {
  try {
    const status = req.query.status || null;
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;

    let q = db.collection("transferTasks").orderBy("createdAt", "desc");

    if (status) {
      q = q.where("status", "==", status);
    }
    if (from) {
      q = q.where("createdAt", ">=", from);
    }
    if (to) {
      q = q.where("createdAt", "<=", to);
    }

    const snap = await q.get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.json(list);
  } catch (err) {
    console.error("Error listing transfer tasks:", err);
    res.status(500).json({ error: "Failed to list transfer tasks" });
  }
});

// Update a transfer task (used by other office when they bring stock)
// Body:
//   fulfilledQty (number) - required
//   status (optional)     - if not provided, auto-calculated
app.post("/transfer-tasks/:id", async (req, res) => {
  try {
    const { fulfilledQty, status } = req.body;

    const qtyNum =
      fulfilledQty !== undefined && fulfilledQty !== null
        ? Number(fulfilledQty)
        : null;

    if (qtyNum === null || Number.isNaN(qtyNum) || qtyNum < 0) {
      return res
        .status(400)
        .json({ error: "fulfilledQty must be a non-negative number" });
    }

    const docRef = db.collection("transferTasks").doc(req.params.id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return res.status(404).json({ error: "Transfer task not found" });
    }

    const data = docSnap.data();
    let newStatus = status || data.status || "pending";

    if (qtyNum >= data.assignedQty) {
      newStatus = "fulfilled";
    } else if (qtyNum > 0) {
      newStatus = "partial";
    } else {
      newStatus = "pending";
    }

    await docRef.update({
      fulfilledQty: qtyNum,
      status: newStatus,
      updatedAt: Date.now(),
    });

    res.json({ message: "Transfer task updated", status: newStatus });
  } catch (err) {
    console.error("Error updating transfer task:", err);
    res.status(500).json({ error: "Failed to update transfer task" });
  }
});

// ----------------- Start server -----------------
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () =>
  console.log(`Server running on port ${port}`)
);
