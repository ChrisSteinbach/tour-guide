/**
 * Shared test fixtures for creating Wikipedia SQL dump files.
 *
 * Hides the SQL schema boilerplate so tests only specify
 * the fields that matter for each scenario.
 */

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

// ---------- Schemas (match real Wikipedia dump format) ----------

const PAGE_SCHEMA = [
  "CREATE TABLE `page` (",
  "  `page_id` int(8) unsigned NOT NULL AUTO_INCREMENT,",
  "  `page_namespace` int(11) NOT NULL DEFAULT '0',",
  "  `page_title` varbinary(255) NOT NULL DEFAULT '',",
  "  `page_is_redirect` tinyint(1) unsigned NOT NULL DEFAULT '0',",
  "  `page_is_new` tinyint(1) unsigned NOT NULL DEFAULT '0',",
  "  `page_random` double unsigned NOT NULL DEFAULT '0',",
  "  `page_touched` varbinary(14) NOT NULL DEFAULT '',",
  "  `page_links_updated` varbinary(14) DEFAULT NULL,",
  "  `page_latest` int(8) unsigned NOT NULL DEFAULT '0',",
  "  `page_len` int(8) unsigned NOT NULL DEFAULT '0',",
  "  `page_content_model` varbinary(32) DEFAULT NULL,",
  "  `page_lang` varbinary(35) DEFAULT NULL,",
  "  PRIMARY KEY (`page_id`)",
  ") ENGINE=InnoDB;",
].join("\n");

const GEO_SCHEMA = [
  "CREATE TABLE `geo_tags` (",
  "  `gt_id` int(10) unsigned NOT NULL AUTO_INCREMENT,",
  "  `gt_page_id` int(10) unsigned NOT NULL DEFAULT '0',",
  "  `gt_globe` varbinary(32) NOT NULL DEFAULT 'earth',",
  "  `gt_primary` tinyint(4) NOT NULL DEFAULT '0',",
  "  `gt_lat` float DEFAULT NULL,",
  "  `gt_lon` float DEFAULT NULL,",
  "  `gt_dim` int(11) DEFAULT NULL,",
  "  `gt_type` varbinary(32) DEFAULT NULL,",
  "  `gt_name` varbinary(255) DEFAULT NULL,",
  "  `gt_country` varbinary(2) DEFAULT NULL,",
  "  `gt_region` varbinary(10) DEFAULT NULL,",
  "  `gt_lat_int` smallint(6) DEFAULT NULL,",
  "  `gt_lon_int` smallint(6) DEFAULT NULL,",
  "  PRIMARY KEY (`gt_id`)",
  ") ENGINE=InnoDB;",
].join("\n");

// ---------- Row types with sensible defaults ----------

export interface PageRow {
  id: number;
  title: string;
  ns?: number; // default: 0 (article namespace)
  redirect?: number; // default: 0 (not a redirect)
}

export interface GeoRow {
  pageId: number;
  lat: number;
  lon: number;
  id?: number; // default: auto-increment
  globe?: string; // default: "earth"
  primary?: number; // default: 1
}

// ---------- Dump builders ----------

export function makePageDump(rows: PageRow[]): string {
  const values = rows
    .map((r) => {
      const ns = r.ns ?? 0;
      const redirect = r.redirect ?? 0;
      return `(${r.id},${ns},'${r.title}',${redirect},0,0.5,'20260101000000',NULL,1,100,'wikitext',NULL)`;
    })
    .join(",");
  return `${PAGE_SCHEMA}\n\nINSERT INTO \`page\` VALUES ${values};`;
}

export function makeGeoDump(rows: GeoRow[]): string {
  const values = rows
    .map((r, i) => {
      const id = r.id ?? i + 1;
      const globe = r.globe ?? "earth";
      const primary = r.primary ?? 1;
      return `(${id},${r.pageId},'${globe}',${primary},${r.lat},${r.lon},10000,'landmark','',NULL,NULL,0,NULL)`;
    })
    .join(",");
  return `${GEO_SCHEMA}\n\nINSERT INTO \`geo_tags\` VALUES ${values};`;
}

/** Write gzipped SQL content to a file and return its path. */
export function gzFile(dir: string, name: string, sql: string): string {
  const path = join(dir, name);
  writeFileSync(path, gzipSync(Buffer.from(sql, "utf8")));
  return path;
}
