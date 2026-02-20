import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseValues,
  parseCreateTable,
  streamDump,
  discoverSchema,
  buildColumnIndex,
} from "./dump-parser.js";
import type { SqlRow } from "./dump-parser.js";

describe("parseValues", () => {
  it("parses a single row with mixed types", () => {
    const rows = parseValues("(1,'hello',NULL,3.14)");
    expect(rows).toEqual([[1, "hello", null, 3.14]]);
  });

  it("parses multiple rows", () => {
    const rows = parseValues("(1,'a'),(2,'b'),(3,'c');");
    expect(rows).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
  });

  it("handles escaped quotes in strings", () => {
    const rows = parseValues("(1,'it\\'s a test')");
    expect(rows).toEqual([[1, "it's a test"]]);
  });

  it("handles escaped backslashes", () => {
    const rows = parseValues("(1,'path\\\\to\\\\file')");
    expect(rows).toEqual([[1, "path\\to\\file"]]);
  });

  it("handles escape sequences (\\n, \\t, \\r)", () => {
    const rows = parseValues("(1,'line1\\nline2\\ttab\\rret')");
    expect(rows).toEqual([[1, "line1\nline2\ttab\rret"]]);
  });

  it("handles empty string values", () => {
    const rows = parseValues("(1,'')");
    expect(rows).toEqual([[1, ""]]);
  });

  it("handles negative numbers", () => {
    const rows = parseValues("(-33.04488000,-71.60679000)");
    expect(rows).toEqual([[-33.04488, -71.60679]]);
  });

  it("handles integers and floats together", () => {
    const rows = parseValues("(4897711,59.30800000,18.02800000)");
    expect(rows).toEqual([[4897711, 59.308, 18.028]]);
  });

  it("handles real geo_tags row format", () => {
    const rows = parseValues(
      "(34746103,6213657,'earth',1,-33.04488000,-71.60679000,10000,'landmark','',NULL,NULL,-330,NULL)",
    );
    expect(rows).toEqual([
      [
        34746103,
        6213657,
        "earth",
        1,
        -33.04488,
        -71.60679,
        10000,
        "landmark",
        "",
        null,
        null,
        -330,
        null,
      ],
    ]);
  });

  it("handles row with all NULLs", () => {
    const rows = parseValues("(NULL,NULL,NULL)");
    expect(rows).toEqual([[null, null, null]]);
  });

  it("handles Unicode strings", () => {
    const rows = parseValues("(1,'日本語テスト')");
    expect(rows).toEqual([[1, "日本語テスト"]]);
  });

  it("handles strings with commas and parens", () => {
    const rows = parseValues("(1,'hello, (world)')");
    expect(rows).toEqual([[1, "hello, (world)"]]);
  });
});

describe("parseCreateTable", () => {
  it("extracts table name and columns", () => {
    const lines = [
      "CREATE TABLE `geo_tags` (",
      "  `gt_id` int(10) unsigned NOT NULL AUTO_INCREMENT,",
      "  `gt_page_id` int(10) unsigned NOT NULL DEFAULT '0',",
      "  `gt_globe` varbinary(32) NOT NULL DEFAULT 'earth',",
      "  `gt_primary` tinyint(4) NOT NULL DEFAULT '0',",
      "  `gt_lat` float DEFAULT NULL,",
      "  `gt_lon` float DEFAULT NULL,",
      "  PRIMARY KEY (`gt_id`),",
      "  KEY `gt_page_id` (`gt_page_id`)",
      ") ENGINE=InnoDB DEFAULT CHARSET=binary;",
    ];
    const schema = parseCreateTable(lines);
    expect(schema).toEqual({
      tableName: "geo_tags",
      columns: [
        "gt_id",
        "gt_page_id",
        "gt_globe",
        "gt_primary",
        "gt_lat",
        "gt_lon",
      ],
    });
  });

  it("returns null for empty input", () => {
    expect(parseCreateTable([])).toBeNull();
  });

  it("returns null for non-CREATE TABLE lines", () => {
    expect(parseCreateTable(["SELECT * FROM foo;"])).toBeNull();
  });

  it("extracts page table schema", () => {
    const lines = [
      "CREATE TABLE `page` (",
      "  `page_id` int(8) unsigned NOT NULL AUTO_INCREMENT,",
      "  `page_namespace` int(11) NOT NULL DEFAULT '0',",
      "  `page_title` varbinary(255) NOT NULL DEFAULT '',",
      "  `page_is_redirect` tinyint(1) unsigned NOT NULL DEFAULT '0',",
      "  PRIMARY KEY (`page_id`)",
      ") ENGINE=InnoDB;",
    ];
    const schema = parseCreateTable(lines);
    expect(schema?.tableName).toBe("page");
    expect(schema?.columns).toEqual([
      "page_id",
      "page_namespace",
      "page_title",
      "page_is_redirect",
    ]);
  });
});

describe("streamDump", () => {
  const testDir = join(tmpdir(), "dump-parser-test-" + Date.now());

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeGzFixture(filename: string, sql: string): string {
    const path = join(testDir, filename);
    writeFileSync(path, gzipSync(Buffer.from(sql, "utf8")));
    return path;
  }

  it("streams rows from a gzipped dump file", async () => {
    const sql = [
      "CREATE TABLE `geo_tags` (",
      "  `gt_id` int(10) unsigned NOT NULL AUTO_INCREMENT,",
      "  `gt_page_id` int(10) unsigned NOT NULL,",
      "  `gt_globe` varbinary(32) NOT NULL,",
      "  `gt_primary` tinyint(4) NOT NULL,",
      "  `gt_lat` float DEFAULT NULL,",
      "  `gt_lon` float DEFAULT NULL,",
      "  PRIMARY KEY (`gt_id`)",
      ") ENGINE=InnoDB;",
      "",
      "INSERT INTO `geo_tags` VALUES (1,100,'earth',1,48.8584,2.2945),(2,200,'earth',0,40.7128,-74.0060);",
    ].join("\n");

    const path = writeGzFixture("geo_tags.sql.gz", sql);
    const rows: SqlRow[] = [];

    for await (const row of streamDump({
      filePath: path,
      tableName: "geo_tags",
      requiredColumns: ["gt_page_id", "gt_lat", "gt_lon"],
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([1, 100, "earth", 1, 48.8584, 2.2945]);
    expect(rows[1]).toEqual([2, 200, "earth", 0, 40.7128, -74.006]);
  });

  it("handles multiple INSERT lines", async () => {
    const sql = [
      "CREATE TABLE `page` (",
      "  `page_id` int(8) unsigned NOT NULL,",
      "  `page_namespace` int(11) NOT NULL,",
      "  `page_title` varbinary(255) NOT NULL,",
      "  PRIMARY KEY (`page_id`)",
      ") ENGINE=InnoDB;",
      "",
      "INSERT INTO `page` VALUES (1,0,'Eiffel_Tower');",
      "INSERT INTO `page` VALUES (2,0,'Statue_of_Liberty');",
    ].join("\n");

    const path = writeGzFixture("page.sql.gz", sql);
    const rows: SqlRow[] = [];

    for await (const row of streamDump({
      filePath: path,
      tableName: "page",
      requiredColumns: ["page_id", "page_title"],
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([1, 0, "Eiffel_Tower"]);
    expect(rows[1]).toEqual([2, 0, "Statue_of_Liberty"]);
  });

  it("throws when required column is missing", async () => {
    const sql = [
      "CREATE TABLE `geo_tags` (",
      "  `gt_id` int(10) unsigned NOT NULL,",
      "  PRIMARY KEY (`gt_id`)",
      ") ENGINE=InnoDB;",
      "",
      "INSERT INTO `geo_tags` VALUES (1);",
    ].join("\n");

    const path = writeGzFixture("missing_col.sql.gz", sql);

    await expect(async () => {
      for await (const _row of streamDump({
        filePath: path,
        tableName: "geo_tags",
        requiredColumns: ["gt_page_id"],
      })) {
        // consume
      }
    }).rejects.toThrow("Required column 'gt_page_id' not found");
  });

  it("calls progress callback", async () => {
    const sql = [
      "CREATE TABLE `test` (",
      "  `id` int NOT NULL,",
      "  PRIMARY KEY (`id`)",
      ") ENGINE=InnoDB;",
      "",
      "INSERT INTO `test` VALUES (1),(2),(3),(4),(5);",
    ].join("\n");

    const path = writeGzFixture("progress.sql.gz", sql);
    const progressCalls: number[] = [];

    for await (const _row of streamDump({
      filePath: path,
      tableName: "test",
      requiredColumns: ["id"],
      onProgress: (count) => progressCalls.push(count),
      progressInterval: 2,
    })) {
      // consume
    }

    // Should be called at 2, 4, and final (5)
    expect(progressCalls).toContain(2);
    expect(progressCalls).toContain(4);
    expect(progressCalls).toContain(5);
  });

  it("throws when table not found in dump", async () => {
    const sql = [
      "CREATE TABLE `other_table` (",
      "  `id` int NOT NULL,",
      "  PRIMARY KEY (`id`)",
      ") ENGINE=InnoDB;",
      "",
      "INSERT INTO `other_table` VALUES (1);",
    ].join("\n");

    const path = writeGzFixture("wrong_table.sql.gz", sql);

    await expect(async () => {
      for await (const _row of streamDump({
        filePath: path,
        tableName: "geo_tags",
        requiredColumns: ["gt_id"],
      })) {
        // consume
      }
    }).rejects.toThrow("Schema for table 'geo_tags' not found");
  });
});

describe("discoverSchema", () => {
  const testDir = join(tmpdir(), "discover-schema-test-" + Date.now());

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("discovers schema without reading full file", async () => {
    const sql = [
      "-- MySQL dump",
      "CREATE TABLE `page_props` (",
      "  `pp_page` int(8) unsigned NOT NULL,",
      "  `pp_propname` varbinary(60) NOT NULL,",
      "  `pp_value` blob NOT NULL,",
      "  `pp_sortkey` float DEFAULT NULL,",
      "  PRIMARY KEY (`pp_page`,`pp_propname`)",
      ") ENGINE=InnoDB;",
      "",
      "INSERT INTO `page_props` VALUES (1,'wikibase_item','Q1',NULL);",
    ].join("\n");

    const path = join(testDir, "page_props.sql.gz");
    writeFileSync(path, gzipSync(Buffer.from(sql, "utf8")));

    const schema = await discoverSchema(path, "page_props");
    expect(schema.tableName).toBe("page_props");
    expect(schema.columns).toEqual([
      "pp_page",
      "pp_propname",
      "pp_value",
      "pp_sortkey",
    ]);
  });
});

describe("buildColumnIndex", () => {
  it("builds a map from column name to index", () => {
    const idx = buildColumnIndex({
      tableName: "test",
      columns: ["id", "name", "value"],
    });
    expect(idx.get("id")).toBe(0);
    expect(idx.get("name")).toBe(1);
    expect(idx.get("value")).toBe(2);
  });
});
