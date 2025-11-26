// skuUtils.js
import { parse } from "csv-parse/sync";

/**
 * Small helper to read a field using multiple possible header names.
 */
function getField(record, possibleNames) {
  for (const name of possibleNames) {
    if (record[name] !== undefined && record[name] !== null) {
      return record[name];
    }
  }
  return "";
}

/**
 * Flipkart Order CSV:
 * Build map: Order Id -> ARRAY of rows
 *
 * This supports cases where the SAME order id has multiple SKUs / lines.
 */
export function buildOrderMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const orderMap = {};

  for (const record of records) {
    const idRaw = getField(record, [
      "Order Id",
      "ORDER ID",
      "order id",
      "OrderID",
      "order_id",
    ]);

    const orderId = idRaw?.toString().trim();
    if (!orderId) continue;

    if (!orderMap[orderId]) {
      orderMap[orderId] = [];
    }
    orderMap[orderId].push(record); // push all rows for this order id
  }

  return orderMap;
}

/**
 * SKU DB CSV:
 * Build map: oldSku -> newSku
 * Expected headers like: old sku,new sku  (case-insensitive)
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
