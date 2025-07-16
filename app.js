
import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import cors from 'cors';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import pdfParse from 'pdf-parse';
import { fileURLToPath } from 'url';
import { parseMappingCSV, extractSkusFromText, generatePicklistCSV } from './skuUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

await fs.mkdir('uploads', { recursive: true });
await fs.mkdir('outputs', { recursive: true });

app.post('/upload', upload.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'skuMapping', maxCount: 1 }
]), async (req, res) => {
  try {
    const pdfFile = req.files['pdf']?.[0];
    const mappingFile = req.files['skuMapping']?.[0];
    if (!pdfFile) return res.status(400).json({ error: 'No PDF uploaded' });

    let mapping = {};
    if (mappingFile) mapping = await parseMappingCSV(mappingFile.path);

    const pdfBuffer = await fs.readFile(pdfFile.path);
    const parsedText = await pdfParse(pdfBuffer);
    const skuData = extractSkusFromText(parsedText.text, mapping);
    const skuList = Object.entries(skuData).flatMap(([sku, data]) => Array(data.qty).fill(mapping[sku] || 'default'));

    const filename = pdfFile.filename;
    await fs.writeFile(path.join('uploads', filename), pdfBuffer);
    res.json({ filename, skuList });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload and parse' });
  }
});

app.post('/crop', async (req, res) => {
  try {
    const { filename, labelBox, invoiceBox, skuList } = req.body;
    const data = await fs.readFile(path.join('uploads', filename));
    const srcPdf = await PDFDocument.load(data);
    const outPdf = await PDFDocument.create();
    const font = await outPdf.embedFont(StandardFonts.Helvetica);

    for (let i = 0; i < srcPdf.getPageCount(); i++) {
      const [sourcePage] = await outPdf.copyPages(srcPdf, [i]);
      const { height } = sourcePage.getSize();

      // Label
      const labelPage = outPdf.addPage([labelBox.width, labelBox.height]);
      const labelCrop = await outPdf.embedPage(sourcePage, {
        left: labelBox.x,
        bottom: height - labelBox.y - labelBox.height,
        right: labelBox.x + labelBox.width,
        top: height - labelBox.y,
      });
      labelPage.drawPage(labelCrop, { x: 0, y: 0 });

      const sku = skuList[i] || 'default';
      labelPage.drawText(`SKU: ${sku}`, {
        x: 10,
        y: 10,
        font,
        size: 10,
        color: rgb(0, 0, 0)
      });

      // Invoice
      const invoicePage = outPdf.addPage([invoiceBox.width, invoiceBox.height]);
      const invoiceCrop = await outPdf.embedPage(sourcePage, {
        left: invoiceBox.x,
        bottom: height - invoiceBox.y - invoiceBox.height,
        right: invoiceBox.x + invoiceBox.width,
        top: height - invoiceBox.y,
      });
      invoicePage.drawPage(invoiceCrop, { x: 0, y: 0 });
    }

    const outputBytes = await outPdf.save();
    const outputPath = path.join('outputs', `output-${filename}.pdf`);
    await fs.writeFile(outputPath, outputBytes);
    res.json({ outputUrl: `/outputs/output-${filename}.pdf` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Crop error' });
  }
});

app.post('/picklist', express.json(), async (req, res) => {
  try {
    const { text, mapping } = req.body;
    const skuData = extractSkusFromText(text, mapping);
    const csv = generatePicklistCSV(skuData);
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to generate picklist');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on port ${port}`));
