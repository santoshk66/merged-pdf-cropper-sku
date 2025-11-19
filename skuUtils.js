import { parse } from "csv-parse/sync";

/**
 * SKU Correction CSV:
 * Columns (case-insensitive):
 *   "old sku"
 *   "new sku"
 *
 * We now RELAX column count so missing values / bad lines are ignored.
 */
export function buildSkuCorrectionMapFromCSV(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,        // ✅ allow short/long rows
    relax_column_count_less: true,   // ✅ specifically allow fewer columns
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

    // ✅ Only add when both are present
    if (oldSku && newSku) {
      skuMap[oldSku] = newSku;
    }
  }

  return skuMap;
}
