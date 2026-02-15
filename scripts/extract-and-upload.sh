#!/usr/bin/env bash
set -euo pipefail

# Extract articles from Wikidata and upload to GitHub release.
# Run locally (no timeout constraints) — the GitHub Actions pipeline
# downloads these files instead of running extraction itself.
#
# Usage:
#   ./scripts/extract-and-upload.sh              # all languages
#   ./scripts/extract-and-upload.sh sv           # just Swedish
#   ./scripts/extract-and-upload.sh sv ja        # Swedish and Japanese
#   ./scripts/extract-and-upload.sh --upload-only # skip extraction, upload existing files

cd "$(git rev-parse --show-toplevel)"

ALL_LANGS=(en sv ja)
UPLOAD_ONLY=false
LANGS=()

for arg in "$@"; do
  if [[ "$arg" == "--upload-only" ]]; then
    UPLOAD_ONLY=true
  else
    LANGS+=("$arg")
  fi
done

if [[ ${#LANGS[@]} -eq 0 ]]; then
  LANGS=("${ALL_LANGS[@]}")
fi

RELEASE_TAG="extraction-latest"

if [[ "$UPLOAD_ONLY" == false ]]; then
  echo "=== Extracting: ${LANGS[*]} ==="

  for lang in "${LANGS[@]}"; do
    echo ""
    echo "--- Extracting: $lang ---"
    npm run extract -- --lang="$lang"

    echo "--- Compressing: articles-$lang.json ---"
    gzip --keep --force "data/articles-$lang.json"
  done
else
  echo "=== Skipping extraction (--upload-only) ==="

  for lang in "${LANGS[@]}"; do
    echo "--- Compressing: articles-$lang.json ---"
    gzip --keep --force "data/articles-$lang.json"
  done
fi

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
