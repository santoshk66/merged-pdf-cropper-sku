// skuUtils.js
import { parse } from "csv-parse/sync";

/**
 * Safely get a field from a CSV record with multiple possible header names.
 */
function getField(record, names) {
  for (const name of names) {
    if (name in record && record[name] != null) {
      return record[name];
    }
  }
  return "";
}

/**
 * Flipkart Order CSV:
 * Build map: Order Id -> array of rows
 *
 * Expected headers at minimum:
 *  - "Order Id"
 *  - optionally "Tracking ID"
 *  - "SKU"
 *  - "Quantity"/"Qty"
 *  - "Product"/"Product Name"/"Description"
 */
export function buildOrderMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // orderId -> [record, ...]
  const orderMap = {};

  for (const record of records) {
    const orderIdRaw = getField(record, ["Order Id", "ORDER ID", "OrderID"]);
    const orderId = orderIdRaw?.toString().trim();
    if (!orderId) continue;

    if (!orderMap[orderId]) {
      orderMap[orderId] = [];
    }
    orderMap[orderId].push(record);
  }

  return orderMap;
}

/**
 * SKU correction CSV:
 *  - columns: old sku,new sku  (case-insensitive)
 * Returns: { oldSku -> newSku }
 */
export function buildSkuCorrectionMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const skuMap = {};

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
