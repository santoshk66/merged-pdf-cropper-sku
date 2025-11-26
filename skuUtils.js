// skuUtils.js
import { parse } from "csv-parse/sync";

/**
 * Flipkart Order CSV:
 * Build map: Order Id -> full row
 *
 * Expected header: "Order Id"
 */
export function buildOrderMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
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
 * SKU Correction CSV (old sku,new sku):
 *
 * Headers (case-insensitive):
 *   "old sku"
 *   "new sku"
 *
 * Example:
 *   old sku,new sku
 *   A-GrouK8Mic,A-GrouK8Mic-NEW
 *
 * Returns: { [oldSku]: newSku }
 */
export function buildSkuCorrectionMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_column_count_less: true,
    trim: true,
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
