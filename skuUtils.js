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

export function extractSkusFromCSV(buffer) {
  const records = parse(buffer, { columns: true, skip_empty_lines: true });
  const skus = [];
  for (const record of records) {
    const custom = record["Custom SKU"]?.trim();
    if (custom) skus.push(custom);
  }
  return skus;
}

// ✅ NEW FUNCTION: Create a picklist with SKU counts
export function generatePicklistCSV(skuList) {
  const skuCounts = {};

  for (const sku of skuList) {
    if (!skuCounts[sku]) skuCounts[sku] = 0;
    skuCounts[sku] += 1;
  }

  const headers = "SKU,Total Qty\n";
  const rows = Object.entries(skuCounts).map(
    ([sku, qty]) => `${sku},${qty}`
  );

  return headers + rows.join("\n");
}
