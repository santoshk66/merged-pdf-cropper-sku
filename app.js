// app.js
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { buildOrderMapFromCSV } from "./skuUtils.js";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());

// Serve static frontend and outputs
app.use(express.static("public"));
app.use("/outputs", express.static("outputs"));

/**
 * POST /upload
 * Expects: multipart/form-data with fields:
 *  - pdf (Flipkart label PDF)
 *  - skuMapping (CSV file with Order Id, SKU, etc.)
 *
 * Response:
 *  {
 *    pdfFilename: "xxx",
 *    mappingFilename: "yyy" | null
 *  }
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

      // Save PDF
      const pdfFinalName = pdfFile.filename;
      const pdfFinalPath = path.join("uploads", pdfFinalName);
      await fs.writeFile(pdfFinalPath, await fs.readFile(pdfFile.path));

      let mappingFilename = null;

      // Save CSV if present
      if (csvFile) {
        const csvFinalName = csvFile.filename;
        const csvFinalPath = path.join("uploads", csvFinalName);
        await fs.writeFile(csvFinalPath, await fs.readFile(csvFile.path));
        mappingFilename = csvFinalName;
      }

      res.json({
        pdfFilename: pdfFinalName,
        mappingFilename, // can be null if CSV not provided
      });
    } catch (err) {
      console.error("Upload error", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

/**
 * POST /crop
 * JSON body:
 *  {
 *    pdfFilename: "xxx",
 *    mappingFilename: "yyy" | null,
 *    labelBox: { x, y, width, height },
 *    invoiceBox: { x, y, width, height },
 *    orderIdsByPage: [ "OD...", "OD...", null, ...]
 *  }
 *
 * Creates a new PDF, each original page -> 2 pages:
 *   - Cropped label with SKU & mapping info text
 *   - Cropped invoice
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

    const pdfPath = path.join("uploads", pdfFilename);
    const pdfData = await fs.readFile(pdfPath);
    const inputPdf = await PDFDocument.load(pdfData);
    const outPdf = await PDFDocument.create();
    const font = await outPdf.embedFont(StandardFonts.Helvetica);

    // Build Order Id → row map from CSV (if provided)
    let orderMap = {};
    if (mappingFilename) {
      const csvPath = path.join("uploads", mappingFilename);
      const csvBuffer = await fs.readFile(csvPath);
      orderMap = buildOrderMapFromCSV(csvBuffer);
    }

    const pageCount = inputPdf.getPageCount();

    for (let i = 0; i < pageCount; i++) {
      const [page] = await outPdf.copyPages(inputPdf, [i]);
      const { height } = page.getSize();

      // Create new pages for cropped label & invoice
      const labelPage = outPdf.addPage([label.width, label.height]);
      const invoicePage = outPdf.addPage([invoice.width, invoice.height]);

      const embedded = await outPdf.embedPage(page);

      // ---- LABEL CROP ----
      // Note: pdf-lib coordinates origin is bottom-left
      // We have label.y from top in canvas; convert
      labelPage.drawPage(embedded, {
        x: -label.x,
        y: -(height - label.y - label.height),
      });

      // Mapping via Order Id
      const orderId = orderIdsByPage[i];
      const row = orderId ? orderMap[orderId] || {} : {};

      // Pull columns from CSV row
      const sku = (row["SKU"] || "").toString();
      const fsn = (row["FSN"] || "").toString();
      const product = (row["Product"] || "").toString();
      const qty = (row["Quantity"] || "").toString();
      const invoiceAmt = (row["Invoice Amount"] || "").toString();
      const shipName = (row["Ship to name"] || "").toString();
      const city = (row["City"] || "").toString();
      const state = (row["State"] || "").toString();
      const pincode = (row["PIN Code"] || "").toString();

      const lines = [
        orderId ? `Order: ${orderId}` : null,
        sku ? `SKU: ${sku}` : null,
        fsn ? `FSN: ${fsn}` : null,
        product ? `Prod: ${product}` : null,
        (qty || invoiceAmt) ? `Qty: ${qty}   Amt: ${invoiceAmt}` : null,
        (city || state || pincode)
          ? `City: ${city}, ${state} - ${pincode}`
          : null,
        shipName ? `Ship To: ${shipName}` : null,
      ].filter(Boolean);

      const fontSize = 7;
      let textY = label.height - 10; // start near top
      const textX = 5;

      for (const line of lines) {
        labelPage.drawText(line, {
          x: textX,
          y: textY,
          font,
          size: fontSize,
          color: rgb(0, 0, 0),
        });
        textY -= fontSize + 2;
      }

      // ---- INVOICE CROP ----
      invoicePage.drawPage(embedded, {
        x: -invoice.x,
        y: -(height - invoice.y - invoice.height),
      });
    }

    const pdfBytes = await outPdf.save();
    const outputName = `output-${pdfFilename}.pdf`;
    const outputPath = path.join("outputs", outputName);
    await fs.writeFile(outputPath, pdfBytes);

    res.json({ outputUrl: `/outputs/${outputName}` });
  } catch (err) {
    console.error("Crop error", err);
    res.status(500).json({ error: "Crop failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
