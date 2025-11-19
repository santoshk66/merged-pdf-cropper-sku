// skuUtils.js
import { parse } from "csv-parse/sync";

/**
 * Flipkart Order CSV:
 * Build map: Order Id -> full row
 * We expect a column: "Order Id"
 */
export function buildOrderMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
  });

  const orderMap = {};

  for (const record of records) {
    const orderId = record["Order Id"]?.toString().trim();
    if (orderId) {
      orderMap[orderId] = record;
    }
  }

  return orderMap;
}

/**
 * SKU Correction CSV:
 * Exactly 2 columns (case-insensitive, spaces allowed):
 *   "old sku"
 *   "new sku"
 *
 * Example:
 *   old sku,new sku
 *   A-GrouK8Mic,A-GrouK8MIC-NEW
 *
 * Returns: { [oldSku]: newSku }
 */
export function buildSkuCorrectionMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
  });

  const skuMap = {};

  const getField = (record, patterns) => {
    const keys = Object.keys(record);
    for (const key of keys) {
      const normalizedKey = key.toLowerCase().trim();
      if (patterns.includes(normalizedKey)) {
        return record[key];
      }
    }
    return "";
  };

  for (const record of records) {
    const oldSkuRaw = getField(record, ["old sku", "old_sku", "oldsku"]);
    const newSkuRaw = getField(record, ["new sku", "new_sku", "newsku"]);

    const oldSku = oldSkuRaw?.toString().trim();
    const newSku = newSkuRaw?.toString().trim();

    if (oldSku && newSku) {
      skuMap[oldSku] = newSku;
    }
  }

  return skuMap;
}
