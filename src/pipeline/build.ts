// Offline build pipeline
// Extracts Wikipedia coordinates, builds Delaunay triangulation, outputs static data files
// Run with: npm run pipeline

import { extractArticles } from "./extract.js";

async function main() {
  console.log("tour-guide build pipeline\n");

  // Step 1: Extract geotagged articles from Wikidata
  console.log("Step 1: Extracting Wikipedia coordinates...");
  const result = await extractArticles({
    onBatch({ batch, articlesInBatch, totalSoFar }) {
      console.log(`  Batch ${batch}: ${articlesInBatch} articles (${totalSoFar} total)`);
    },
  });
  console.log(`  → ${result.articles.length} unique articles extracted\n`);

  // Step 2: Build Delaunay triangulation (not yet implemented)
  console.log("Step 2: Delaunay triangulation — not yet implemented");
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
