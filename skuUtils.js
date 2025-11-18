// skuUtils.js
import { parse } from "csv-parse/sync";

/**
 * Build a map:
 *   Order Id (string) → full CSV row (object with all columns)
 *
 * CSV must have a column named exactly "Order Id"
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
