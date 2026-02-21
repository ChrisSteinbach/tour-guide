/**
 * Stream-parse gzipped MySQL dump files from Wikipedia/Wikidata.
 *
 * Dumps use extended-insert format:
 *   INSERT INTO `table` VALUES (v1,v2,...),(v1,v2,...);
 *
 * We stream line-by-line, extract column names from CREATE TABLE,
 * and yield typed rows from INSERT statements.
 */

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

/** A single parsed SQL value: string, number, or null. */
export type SqlValue = string | number | null;
export type SqlRow = SqlValue[];

/** Column schema discovered from CREATE TABLE. */
export interface TableSchema {
  tableName: string;
  columns: string[];
}

/**
 * Parse the VALUES clause of a MySQL extended-insert line.
 *
 * Handles: quoted strings with escaping (\' \\), NULL, unquoted numbers,
 * nested parentheses for tuple boundaries.
 *
 * @returns Array of row tuples.
 */
export function parseValues(valuesStr: string): SqlRow[] {
  const rows: SqlRow[] = [];
  let i = 0;
  const len = valuesStr.length;

  while (i < len) {
    // Skip to opening paren
    while (i < len && valuesStr[i] !== "(") i++;
    if (i >= len) break;
    i++; // skip '('

    const row: SqlRow = [];
    while (i < len && valuesStr[i] !== ")") {
      if (valuesStr[i] === "'") {
        // Quoted string
        i++; // skip opening quote
        let val = "";
        while (i < len) {
          if (valuesStr[i] === "\\") {
            // Escaped character
            i++;
            if (i < len) {
              const esc = valuesStr[i];
              if (esc === "n") val += "\n";
              else if (esc === "t") val += "\t";
              else if (esc === "r") val += "\r";
              else if (esc === "0") val += "\0";
              else val += esc; // \' \\ and anything else
              i++;
            }
          } else if (valuesStr[i] === "'") {
            i++; // skip closing quote
            break;
          } else {
            val += valuesStr[i];
            i++;
          }
        }
        row.push(val);
      } else if (
        valuesStr[i] === "N" &&
        valuesStr.substring(i, i + 4) === "NULL"
      ) {
        row.push(null);
        i += 4;
      } else {
        // Unquoted number or other value
        let val = "";
        while (i < len && valuesStr[i] !== "," && valuesStr[i] !== ")") {
          val += valuesStr[i];
          i++;
        }
        const num = Number(val);
        row.push(Number.isNaN(num) ? val : num);
      }

      // Skip comma between values
      if (i < len && valuesStr[i] === ",") i++;
    }

    if (i < len && valuesStr[i] === ")") i++; // skip ')'
    rows.push(row);

    // Skip comma between tuples or semicolon
    if (i < len && valuesStr[i] === ",") i++;
  }

  return rows;
}

/**
 * Parse column names from a CREATE TABLE statement block.
 *
 * Expects lines like:
 *   CREATE TABLE `geo_tags` (
 *     `gt_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
 *     ...
 *   ) ENGINE=InnoDB ...;
 */
export function parseCreateTable(lines: string[]): TableSchema | null {
  let tableName = "";
  const columns: string[] = [];

  for (const line of lines) {
    const tableMatch = line.match(/CREATE TABLE\s+`(\w+)`/);
    if (tableMatch) {
      tableName = tableMatch[1];
      continue;
    }

    const colMatch = line.match(/^\s+`(\w+)`/);
    if (colMatch) {
      columns.push(colMatch[1]);
    }
  }

  if (!tableName || columns.length === 0) return null;
  return { tableName, columns };
}

/** Options for streaming a dump file. */
export interface DumpStreamOptions {
  /** Path to the .sql.gz file */
  filePath: string;
  /** Expected table name (for validation) */
  tableName: string;
  /** Columns we need from this table */
  requiredColumns: string[];
  /** Optional callback for progress reporting */
  onProgress?: (rowCount: number) => void;
  /** Progress report interval in rows (default: 100_000) */
  progressInterval?: number;
}

/**
 * Stream-parse a gzipped MySQL dump file, yielding projected rows.
 *
 * First discovers the schema from CREATE TABLE, then streams INSERT lines
 * and yields row tuples containing only the requiredColumns, in the order
 * they were specified.
 */
export async function* streamDump(
  opts: DumpStreamOptions,
): AsyncGenerator<SqlRow> {
  const {
    filePath,
    tableName,
    requiredColumns,
    onProgress,
    progressInterval = 100_000,
  } = opts;

  const gunzip = createGunzip();
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity,
  });

  let schema: TableSchema | null = null;
  let createTableLines: string[] | null = null;
  let projectionIndices: number[] | null = null;
  let rowCount = 0;

  const insertPrefix = `INSERT INTO \`${tableName}\` VALUES `;

  for await (const line of rl) {
    // Collect CREATE TABLE block
    if (line.includes("CREATE TABLE")) {
      createTableLines = [line];
      continue;
    }

    if (createTableLines !== null) {
      createTableLines.push(line);
      if (line.includes(";")) {
        schema = parseCreateTable(createTableLines);
        createTableLines = null;

        if (schema && schema.tableName === tableName) {
          const columnIndex = new Map(schema.columns.map((c, i) => [c, i]));
          projectionIndices = requiredColumns.map((col) => {
            const idx = columnIndex.get(col);
            if (idx === undefined) {
              throw new Error(
                `Required column '${col}' not found in ${tableName}. Available: ${schema!.columns.join(", ")}`,
              );
            }
            return idx;
          });
        }
      }
      continue;
    }

    // Parse INSERT lines and project to required columns
    if (line.startsWith(insertPrefix) && projectionIndices) {
      const valuesStr = line.substring(insertPrefix.length);
      const rows = parseValues(valuesStr);
      for (const row of rows) {
        yield projectionIndices.map((i) => row[i]);
        rowCount++;
        if (onProgress && rowCount % progressInterval === 0) {
          onProgress(rowCount);
        }
      }
    }
  }

  if (!projectionIndices) {
    throw new Error(`Schema for table '${tableName}' not found in ${filePath}`);
  }

  if (onProgress) onProgress(rowCount);
}
