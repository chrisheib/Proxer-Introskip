#!/usr/bin/env sh
set -eu

if command -v zip >/dev/null 2>&1; then
  archiver="zip"
elif command -v 7z >/dev/null 2>&1; then
  archiver="7z"
else
  echo "Error: neither zip nor 7z executable found in PATH." >&2
  exit 1
fi

# Build fresh JavaScript bundles unless explicitly skipped.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  ./build.sh
fi

required_files="
manifest.json
popup.html
data.json
dist/content.js
dist/iframe-content.js
dist/popup.js
"

missing=0
for path in $required_files; do
  if [ ! -f "$path" ]; then
    echo "Error: required file missing: $path" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)"
if [ -z "$version" ]; then
  echo "Error: could not read version from manifest.json" >&2
  exit 1
fi

name="proxer-anime-skip-v${version}.zip"
release_dir="release"
outfile="$release_dir/$name"

mkdir -p "$release_dir"
rm -f "$outfile"

if [ "$archiver" = "zip" ]; then
  zip -r "$outfile" \
    manifest.json \
    popup.html \
    data.json \
    dist \
    -x "*.map"
else
  # 7z writes zip-compatible archives with -tzip.
  7z a -tzip "$outfile" manifest.json popup.html data.json dist -xr!*.map >/dev/null
fi

echo "Pack complete: $outfile"
