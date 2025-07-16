import { parse } from "csv-parse/sync";

export function parseMappingCSV(buffer) {
  const records = parse(buffer, { columns: true, skip_empty_lines: true });
  const mapping = {};
  for (const record of records) {
    const flipkart = record["Flipkart SKU"]?.trim();
    const custom = record["Custom SKU"]?.trim();
    if (flipkart && custom) {
      mapping[flipkart] = custom;
    }
  }
  return mapping;
}

export function extractSkusFromRawText(text, mapping = {}) {
  const lines = text.split("\n");
  const skuData = {};
  for (const line of lines) {
    const parts = line.split("|").map(p => p.trim());
    if (parts.length < 2) continue;
    let flipkartSku = parts[0].replace(/^\d+(?=[A-Za-z])/, "");
    if (/^\d+$/.test(flipkartSku) || flipkartSku.length < 3) continue;
    if (!/[A-Za-z]/.test(flipkartSku) || !flipkartSku.includes("-")) continue;
    const customSku = mapping[flipkartSku] || "default";
    if (!skuData[flipkartSku]) skuData[flipkartSku] = { customSku, qty: 0 };
    skuData[flipkartSku].qty += 1;
  }
  return skuData;
}

export function generatePicklistCSV(skuData) {
  const headers = "Flipkart SKU,Custom SKU,Total Qty\n";
  const rows = Object.entries(skuData).map(
    ([fk, data]) => `${fk},${data.customSku},${data.qty}`
  );
  return headers + rows.join("\n");
}
