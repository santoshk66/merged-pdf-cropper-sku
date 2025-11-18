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
        mappingFilename,
      });
    } catch (err) {
      console.error("Upload error", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

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

      const labelPage = outPdf.addPage([label.width, label.height]);
      const invoicePage = outPdf.addPage([invoice.width, invoice.height]);

      const embedded = await outPdf.embedPage(page);

      // ===== LABEL CROP =====
      labelPage.drawPage(embedded, {
        x: -label.x,
        y: -(height - label.y - label.height),
      });

      // --- Only map SKU using Order Id ---
      const orderId = orderIdsByPage[i];
      const row = orderId ? orderMap[orderId] || {} : {};
      const sku = (row["SKU"] || "").toString();

      if (sku) {
        // Bottom-left position (a little inset from edges)
        const fontSize = 8;
        const textX = 5;          // left margin
        const textY = 3;          // bottom margin

        labelPage.drawText(`SKU: ${sku}`, {
          x: textX,
          y: textY,
          font,
          size: fontSize,
          color: rgb(0, 0, 0),
        });
      }
      // ===== END LABEL CROP =====

      // ===== INVOICE CROP =====
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
