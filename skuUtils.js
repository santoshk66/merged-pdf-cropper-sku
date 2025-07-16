
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
