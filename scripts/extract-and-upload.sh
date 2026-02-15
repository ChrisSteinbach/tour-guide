#!/usr/bin/env bash
set -euo pipefail

# Extract articles from Wikidata and upload to GitHub release.
# Run locally (no timeout constraints) — the GitHub Actions pipeline
# downloads these files instead of running extraction itself.
#
# Usage:
#   ./scripts/extract-and-upload.sh          # all languages
#   ./scripts/extract-and-upload.sh sv       # just Swedish
#   ./scripts/extract-and-upload.sh sv ja    # Swedish and Japanese

cd "$(git rev-parse --show-toplevel)"

ALL_LANGS=(en sv ja)
LANGS=("${@:-${ALL_LANGS[@]}}")
RELEASE_TAG="extraction-latest"

echo "=== Extracting: ${LANGS[*]} ==="

for lang in "${LANGS[@]}"; do
  echo ""
  echo "--- Extracting: $lang ---"
  npm run extract -- --lang="$lang"

  echo "--- Compressing: articles-$lang.json ---"
  gzip --keep --force "data/articles-$lang.json"
done

echo ""
echo "=== Uploading to $RELEASE_TAG release ==="

# Create the release if it doesn't exist
if ! gh release view "$RELEASE_TAG" &>/dev/null; then
  gh release create "$RELEASE_TAG" \
    --title "Extraction Data" \
    --notes "Pre-extracted article data for the build pipeline. Updated by scripts/extract-and-upload.sh."
fi

# Upload (--clobber replaces existing files for that language without affecting others)
for lang in "${LANGS[@]}"; do
  echo "Uploading articles-$lang.json.gz"
  gh release upload "$RELEASE_TAG" "data/articles-$lang.json.gz" --clobber
done

echo ""
echo "=== Done ==="
echo "Uploaded: ${LANGS[*]}"
echo "Pipeline can now be triggered: gh workflow run pipeline.yml"
