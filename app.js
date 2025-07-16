
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseMappingCSV, extractSkusFromCSV } from "./skuUtils.js";

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.static("public"));
app.use(express.json());
app.use("/outputs", express.static("outputs"));

app.post("/upload", upload.fields([{ name: "pdf" }, { name: "skuMapping" }]), async (req, res) => {
  try {
    const pdfFile = req.files["pdf"]?.[0];
    const csvFile = req.files["skuMapping"]?.[0];
    if (!pdfFile) return res.status(400).json({ error: "Missing PDF" });

    let skuList = [];
    if (csvFile) {
      const csvBuffer = await fs.readFile(csvFile.path);
      skuList = extractSkusFromCSV(csvBuffer);
    }

    await fs.writeFile(`uploads/${pdfFile.filename}`, await fs.readFile(pdfFile.path));
    res.json({ filename: pdfFile.filename, skuList });
  } catch (err) {
    console.error("Upload error", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.post("/crop", async (req, res) => {
  try {
    const { filename, labelBox, invoiceBox, skuList } = req.body;
    const data = await fs.readFile(`uploads/${filename}`);
    const inputPdf = await PDFDocument.load(data);
    const outPdf = await PDFDocument.create();
    const font = await outPdf.embedFont(StandardFonts.Helvetica);

    for (let i = 0; i < inputPdf.getPageCount(); i++) {
      const [page] = await outPdf.copyPages(inputPdf, [i]);
      const { height } = page.getSize();

      const labelPage = outPdf.addPage([labelBox.width, labelBox.height]);
      const invoicePage = outPdf.addPage([invoiceBox.width, invoiceBox.height]);

      const embedded = await outPdf.embedPage(page);
      labelPage.drawPage(embedded, {
        x: -labelBox.x,
        y: -(height - labelBox.y - labelBox.height),
      });

      const sku = skuList[i] || "default";
      labelPage.drawText(`SKU: ${sku}`, {
          x: 5,
          y: 1,
          font,
          size: 8,
          color: rgb(0, 0, 0)
        });

      invoicePage.drawPage(embedded, {
        x: -invoiceBox.x,
        y: -(height - invoiceBox.y - invoiceBox.height),
      });
    }

    const pdfBytes = await outPdf.save();
    const outputPath = `outputs/output-${filename}`;
    await fs.writeFile(outputPath, pdfBytes);
    res.json({ outputUrl: `/outputs/output-${filename}` });
  } catch (err) {
    console.error("Crop error", err);
    res.status(500).json({ error: "Crop failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
