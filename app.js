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
const UPLOAD_DIR = "uploads"; // temp upload dir (ephemeral)
const OUTPUT_DIR = "outputs"; // outputs (zip + reprint pdfs)
const PERMA_DIR = "data/original_pdfs"; // permanent originals (Solution B)

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, PERMA_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

      // Multer random filename (no extension)
      const pdfFinalName = pdfFile.filename;

      // Save into UPLOAD_DIR (temp)
      const pdfFinalPath = path.join(UPLOAD_DIR, pdfFinalName);
      await fsPromises.writeFile(
        pdfFinalPath,
        await fsPromises.readFile(pdfFile.path)
      );

      // Also save a permanent copy into PERMA_DIR (Solution B)
      const permanentPath = path.join(PERMA_DIR, pdfFinalName);
      try {
        await fsPromises.copyFile(pdfFinalPath, permanentPath);
        console.log("Saved permanent original PDF:", permanentPath);
      } catch (copyErr) {
        console.error("Error copying PDF to permanent dir:", copyErr);
      }

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
 *    trackingIdsByPage:[ "FMPP...", null, ... ],
 *    removeDuplicates: boolean
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

    // Load input PDF from UPLOAD_DIR
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
      orderMap = buildOrderMapFromCSV(csvBuffer); // orderId -> [rows]

      for (const [orderId, rowsOrRow] of Object.entries(orderMap)) {
        const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];

        if (rows.length > 1) {
          duplicateOrderIds.push(orderId);
        }

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

    // ---------- 3) Picklist aggregation ----------
    const picklistMap = {};

    const jobs = [];
    const seenOrderIds = new Set();
    const orderUsageCount = {}; // for round-robin when one Order Id has multiple rows

    for (let i = 0; i < pageCount; i++) {
      const orderId = orderIdsByPage[i] || null;
      let trackingId = trackingIdsByPage[i] || null; // can be backfilled from CSV row

      // Optional: remove duplicate labels for SAME Order Id
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
          row = rowsForOrder[0];
        } else {
          if (trackingId && trackingMap[trackingId]) {
            const candidates = trackingMap[trackingId].filter(
              (entry) => entry.orderId === orderId
            );

            if (candidates.length === 1) {
              row = candidates[0].row;
            } else {
              const used = orderUsageCount[orderId] || 0;
              const idx = used % rowsForOrder.length;
              row = rowsForOrder[idx];
              orderUsageCount[orderId] = used + 1;
            }
          } else {
            const used = orderUsageCount[orderId] || 0;
            const idx = used % rowsForOrder.length;
            row = rowsForOrder[idx];
            orderUsageCount[orderId] = used + 1;
          }
        }
      } else {
        row = {};
      }

      // 🔹 Backfill tracking ID from CSV row if front-end missed it
      const trackingFromRow =
        (row["Tracking ID"] ||
          row["Tracking Id"] ||
          row["tracking id"] ||
          row["TrackingID"] ||
          "").toString().trim();

      if (!trackingId && trackingFromRow) {
        trackingId = trackingFromRow;
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

   // ---- Sort jobs by SKU using total units (descending) ----

  // Build a map: SKU -> total units (from picklistMap)
  const skuTotalUnits = {};
  for (const item of Object.values(picklistMap)) {
    if (!item || !item.sku) continue;
    const skuKey = item.sku;
    const qtyNum = Number(item.qty) || 0;
    skuTotalUnits[skuKey] = (skuTotalUnits[skuKey] || 0) + qtyNum;
  }
  
  const withSku = jobs.filter((j) => j.finalSku);
  const withoutSku = jobs.filter((j) => !j.finalSku);
  
  withSku.sort((a, b) => {
    const totalA = skuTotalUnits[a.finalSku] || 0;
    const totalB = skuTotalUnits[b.finalSku] || 0;
  
    // 1) Bigger total units first
    if (totalA !== totalB) {
      return totalB - totalA; // DESC
    }
  
    // 2) Fallback: alphabetic SKU
    const cmp = a.finalSku.localeCompare(b.finalSku);
    if (cmp !== 0) return cmp;
  
    // 3) Fallback: page index
    return a.pageIndex - b.pageIndex;
  });
  
  // Pages with no SKU info go at the end
  const sortedJobs = [...withSku, ...withoutSku];

    // ---- Count jobs per SKU ----
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

    // ---- MAIN LOOP for fullDoc / smallDoc / skuDocs ----
    let lastGroupKey = null;

    for (const job of sortedJobs) {
      const groupKey = job.finalSku || job.rawSku || "NO_SKU";

      if (groupKey !== lastGroupKey) {
      const headerPage = fullDoc.addPage([label.width, label.height]);
      const { width: hpw, height: hph } = headerPage.getSize();
    
      let headerText;
    
      if (groupKey === "NO_SKU") {
        headerText = "NO SKU / UNKNOWN";
      } else {
        // Try to read total units from picklistMap
        const totalUnitsForSku =
          (picklistMap[groupKey] && Number(picklistMap[groupKey].qty)) || 0;
    
        if (totalUnitsForSku > 0) {
          headerText = `${groupKey} • Total Qty: ${totalUnitsForSku}`;
        } else {
          headerText = groupKey;
        }
      }
    
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

    // -------- Build Picklist PDF --------
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

    const pickItemsArray = Object.values(picklistMap);
    const pickItemsSorted = pickItemsArray.sort((a, b) => {
      const diff = (b.qty || 0) - (a.qty || 0);
      if (diff !== 0) return diff;
      return a.sku.localeCompare(b.sku);
    });

    // ---- Summary stats for label PDF (for last page) ----
    const totalLabels = jobs.length;

    const uniqueOrderIdsSet = new Set(
      jobs
        .map((j) => j.orderId)
        .filter(Boolean)
    );
    const totalUniqueOrders = uniqueOrderIdsSet.size;

    const totalSkusInPicklist = pickItemsSorted.length;

    const totalUnitsInPicklist = pickItemsSorted.reduce(
      (sum, item) => sum + (Number(item.qty) || 0),
      0
    );

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

    // -------- Add SUMMARY PAGE to fullDoc (main labels PDF) --------
    const summaryPage = fullDoc.addPage([label.width, label.height]);
    const { height: summaryH } = summaryPage.getSize();
    let sy = summaryH - 20; // start near top

    const summaryLines = [
      "SUMMARY",
      `Total Labels (Label + Invoice Pairs): ${totalLabels}`,
      `Total Unique Orders: ${totalUniqueOrders}`,
      `Total SKUs in Picklist: ${totalSkusInPicklist}`,
      `Total Units (Qty): ${totalUnitsInPicklist}`,
    ];

    for (let i = 0; i < summaryLines.length; i++) {
      const line = summaryLines[i];
      const size = i === 0 ? 12 : 8; // bigger title

      summaryPage.drawText(line, {
        x: 10,
        y: sy,
        font: fullFont,
        size,
        color: rgb(0, 0, 0),
      });

      sy -= size + 6;
    }

    // -------- Create ZIP with all PDFs --------
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

    // -------- Build picklist JSON --------
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

    // Save picklist in Firestore
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

    // -------- Save processed labels metadata (for reprint) --------
    try {
      const processedAt = now;
      const processedDate = new Date(now).toISOString().split("T")[0];
      const chunkSize = 400;

      for (let i = 0; i < jobs.length; i += chunkSize) {
        const batch = db.batch();
        let ops = 0;

        for (let j = i; j < Math.min(i + chunkSize, jobs.length); j++) {
          const job = jobs[j];
          if (!job.orderId && !job.trackingId) continue;

          const docRef = db.collection("processedLabels").doc();
          batch.set(docRef, {
            pdfFilename,
            mappingFilename: mappingFilename || null,
            pageIndex: job.pageIndex,
            orderId: job.orderId || null,
            trackingId: job.trackingId || null,
            rawSku: job.rawSku || null,
            finalSku: job.finalSku || null,
            qtyRaw: job.qtyRaw || null, // <- store qtyRaw
            productName: job.productName || "",
            labelBox: label,
            invoiceBox: invoice,
            picklistId,
            processedAt,
            processedDate,
          });
          ops++;
        }

        if (ops > 0) {
          await batch.commit();
        }
      }
    } catch (metaErr) {
      console.error("Error saving processed label metadata:", metaErr);
    }

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

// Get latest picklist
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

// List picklists by createdAt range
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

// Update picklist items + status
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

// ----------------- Reprint labels by trackingId / orderId -----------------
/**
 * POST /reprint-labels
 * Body:
 *  {
 *    trackingIds: ["FMPP...", "FMPP..."],   // optional
 *    orderIds: ["OD...", "OD..."],          // optional
 *    date: "YYYY-MM-DD"                     // optional, defaults to today
 *  }
 *
 * At least ONE of trackingIds or orderIds must be non-empty.
 */
app.post("/reprint-labels", async (req, res) => {
  try {
    const { trackingIds, orderIds, date } = req.body;

    const searchDate = date || new Date().toISOString().split("T")[0];

    const cleanedTracking = Array.isArray(trackingIds)
      ? trackingIds
          .map((t) => (t == null ? "" : String(t).trim()))
          .filter(Boolean)
      : [];

    const cleanedOrders = Array.isArray(orderIds)
      ? orderIds
          .map((o) => (o == null ? "" : String(o).trim()))
          .filter(Boolean)
      : [];

    if (cleanedTracking.length === 0 && cleanedOrders.length === 0) {
      return res.status(400).json({
        error: "Provide at least one trackingId or orderId",
      });
    }

    const notFoundTracking = [];
    const notFoundOrders = [];

    // Use map to avoid duplicate pages (same pdfFilename + pageIndex)
    const docMap = new Map(); // key = `${pdfFilename}#${pageIndex}`

    // ---------- Search by trackingIds ----------
    for (const tid of cleanedTracking) {
      const snap = await db
        .collection("processedLabels")
        .where("trackingId", "==", tid)
        .get();

      if (snap.empty) {
        notFoundTracking.push(tid);
        continue;
      }

      const candidates = snap.docs
        .map((d) => d.data())
        .filter((d) => d.processedDate === searchDate);

      if (candidates.length === 0) {
        notFoundTracking.push(tid);
        continue;
      }

      candidates.sort(
        (a, b) => (b.processedAt || 0) - (a.processedAt || 0)
      );

      const best = {
        trackingId: tid,
        ...candidates[0],
      };

      const key = `${best.pdfFilename}#${best.pageIndex}`;
      if (!docMap.has(key)) {
        docMap.set(key, best);
      }
    }

    // ---------- Search by orderIds ----------
    for (const oid of cleanedOrders) {
      const snap = await db
        .collection("processedLabels")
        .where("orderId", "==", oid)
        .get();

      if (snap.empty) {
        notFoundOrders.push(oid);
        continue;
      }

      const candidates = snap.docs
        .map((d) => d.data())
        .filter((d) => d.processedDate === searchDate);

      if (candidates.length === 0) {
        notFoundOrders.push(oid);
        continue;
      }

      candidates.sort(
        (a, b) => (b.processedAt || 0) - (a.processedAt || 0)
      );

      const best = {
        orderId: oid,
        ...candidates[0],
      };

      const key = `${best.pdfFilename}#${best.pageIndex}`;
      if (!docMap.has(key)) {
        docMap.set(key, best);
      }
    }

    const foundDocs = Array.from(docMap.values());

    if (foundDocs.length === 0) {
      return res.json({
        message:
          "No labels found for given tracking / order IDs on specified date",
        notFoundTrackingIds: notFoundTracking,
        notFoundOrderIds: notFoundOrders,
      });
    }

    // ---------- Build output PDF from permanent originals ----------
    const outDoc = await PDFDocument.create();
    const textFont = await outDoc.embedFont(StandardFonts.Helvetica);
    const pdfCache = {}; // pdfFilename -> loaded PDFDocument

    for (const doc of foundDocs) {
      const { pdfFilename, pageIndex, labelBox, invoiceBox } = doc;

      if (
        !pdfFilename ||
        pageIndex === undefined ||
        !labelBox ||
        !invoiceBox
      ) {
        continue;
      }

      if (!pdfCache[pdfFilename]) {
        let srcBytes = null;
        try {
          const srcPath = path.join(PERMA_DIR, pdfFilename);
          srcBytes = await fsPromises.readFile(srcPath);
          console.log("Loaded original PDF from PERMA_DIR:", srcPath);
        } catch (err) {
          console.error("Permanent PDF not found for", pdfFilename, err.message);
          try {
            const srcPathUpload = path.join(UPLOAD_DIR, pdfFilename);
            srcBytes = await fsPromises.readFile(srcPathUpload);
            console.log("Loaded original PDF from UPLOAD_DIR:", srcPathUpload);
          } catch (err2) {
            console.error(
              "Also missing in UPLOAD_DIR for",
              pdfFilename,
              err2.message
            );
            continue;
          }
        }

        pdfCache[pdfFilename] = await PDFDocument.load(srcBytes);
      }

      const srcPdf = pdfCache[pdfFilename];

      const [page] = await outDoc.copyPages(srcPdf, [pageIndex]);
      const { height } = page.getSize();
      const embedded = await outDoc.embedPage(page);

      // Label page
      const labelPage = outDoc.addPage([
        labelBox.width,
        labelBox.height,
      ]);
      labelPage.drawPage(embedded, {
        x: -labelBox.x,
        y: -(height - labelBox.y - labelBox.height),
      });

      // Draw SKU + qty like in /crop
      let labelText = doc.finalSku || doc.rawSku || "";
      if (labelText && doc.qtyRaw) {
        labelText = `${labelText} (${doc.qtyRaw})`;
      }
      if (labelText) {
        labelPage.drawText(labelText, {
          x: 5,
          y: 4,
          font: textFont,
          size: 6,
          color: rgb(0, 0, 0),
        });
      }

      // Invoice page
      const invoicePage = outDoc.addPage([
        invoiceBox.width,
        invoiceBox.height,
      ]);
      invoicePage.drawPage(embedded, {
        x: -invoiceBox.x,
        y: -(height - invoiceBox.y - invoiceBox.height),
      });
    }

    if (outDoc.getPageCount() === 0) {
      return res.json({
        message: "No valid label pages were generated",
        notFoundTrackingIds: notFoundTracking,
        notFoundOrderIds: notFoundOrders,
      });
    }

    const outName = `reprint-${searchDate}-${Date.now()}.pdf`;
    const outPath = path.join(OUTPUT_DIR, outName);
    const outBytes = await outDoc.save();
    await fsPromises.writeFile(outPath, outBytes);

    res.json({
      url: `/outputs/${outName}`,
      foundCount: outDoc.getPageCount() / 2,
      notFoundTrackingIds: notFoundTracking,
      notFoundOrderIds: notFoundOrders,
    });
  } catch (err) {
    console.error("Error in /reprint-labels:", err);
    res.status(500).json({ error: "Failed to reprint labels" });
  }
});

// ----------------- Reprint labels from uploaded PDFs only (no history) -----------------
/**
 * POST /reprint-from-pdfs
 * multipart/form-data:
 *  - pdfs: multiple PDF files (label PDFs processed in that day)
 *  - index: JSON string {
 *        pages: [{ fileIndex, pageIndex, orderId, trackingId }, ...],
 *        trackingIds: [...],
 *        orderIds: [...]
 *    }
 *
 * We only use the pages[] (already filtered on frontend) + pdfs[].
 */
app.post("/reprint-from-pdfs", upload.array("pdfs"), async (req, res) => {
  try {
    const indexJson = req.body.index;
    if (!indexJson) {
      return res.status(400).json({ error: "Missing index mapping" });
    }

    const { pages = [] } = JSON.parse(indexJson || "{}");
    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({
        error: "No page mapping received. Please scan PDFs first.",
      });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No PDF files uploaded" });
    }

    // Group pages by fileIndex for efficiency
    const byFile = new Map(); // key = fileIndex, val = array of { pageIndex }
    for (const p of pages) {
      const fileIndex = Number(p.fileIndex);
      const pageIndex = Number(p.pageIndex);
      if (Number.isNaN(fileIndex) || Number.isNaN(pageIndex)) continue;
      if (!byFile.has(fileIndex)) byFile.set(fileIndex, []);
      byFile.get(fileIndex).push(pageIndex);
    }

    if (!byFile.size) {
      return res.status(400).json({
        error: "No valid page indices in mapping.",
      });
    }

    const outDoc = await PDFDocument.create();

    // Use same fixed crop coordinates as in frontend auto-mode
    const LABEL_BOX = { x: 189.6, y: 27.3, width: 216.0, height: 356.0 };
    const INVOICE_BOX = { x: 35.6, y: 388.0, width: 521.0, height: 395.0 };

    for (const [fileIndex, pageIndexes] of byFile.entries()) {
      const file = files[fileIndex];
      if (!file) continue;

      const pdfBytes = await fsPromises.readFile(file.path);
      const srcPdf = await PDFDocument.load(pdfBytes);

      for (const pageIndex of pageIndexes) {
        if (pageIndex < 0 || pageIndex >= srcPdf.getPageCount()) continue;

        const [page] = await outDoc.copyPages(srcPdf, [pageIndex]);
        const { height } = page.getSize();
        const embedded = await outDoc.embedPage(page);

        // Label page
        const labelPage = outDoc.addPage([LABEL_BOX.width, LABEL_BOX.height]);
        labelPage.drawPage(embedded, {
          x: -LABEL_BOX.x,
          y: -(height - LABEL_BOX.y - LABEL_BOX.height),
        });

        // Invoice page
        const invoicePage = outDoc.addPage([
          INVOICE_BOX.width,
          INVOICE_BOX.height,
        ]);
        invoicePage.drawPage(embedded, {
          x: -INVOICE_BOX.x,
          y: -(height - INVOICE_BOX.y - INVOICE_BOX.height),
        });
      }
    }

    if (outDoc.getPageCount() === 0) {
      return res.status(400).json({
        error: "No pages were generated from uploaded PDFs.",
      });
    }

    const outName = `reprint-from-pdfs-${Date.now()}.pdf`;
    const outPath = path.join(OUTPUT_DIR, outName);
    const outBytes = await outDoc.save();
    await fsPromises.writeFile(outPath, outBytes);

    res.json({
      url: `/outputs/${outName}`,
      pagePairs: outDoc.getPageCount() / 2, // each pair = label + invoice
    });
  } catch (err) {
    console.error("Error in /reprint-from-pdfs:", err);
    res.status(500).json({ error: "Failed to reprint from uploaded PDFs" });
  }
});

// ----------------- Transfer Tasks (Another Office Picklist) -----------------

/**
 * A "transfer task" = some quantity of a SKU from a picklist
 * that should be brought from another office.
 *
 * Firestore collection: transferTasks
 */

// Create a transfer task
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

// List transfer tasks
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

// Update a transfer task
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
