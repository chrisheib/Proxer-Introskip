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
manifest.firefox.json
popup.html
icon.png
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
firefox_name="proxer-anime-skip-firefox-v${version}.zip"
release_dir="release"
outfile="$release_dir/$name"
firefox_outfile="$release_dir/$firefox_name"

archive_files="
manifest.json
popup.html
icon.png
dist
"

pack_zip() {
  output_file="$1"
  shift
  if [ "$archiver" = "zip" ]; then
    zip -r "$output_file" "$@" -x "*.map"
  else
    # 7z writes zip-compatible archives with -tzip.
    7z a -tzip "$output_file" "$@" -xr!*.map >/dev/null
  fi
}

mkdir -p "$release_dir"
rm -f "$outfile"
rm -f "$firefox_outfile"

pack_zip "$outfile" $archive_files

# Firefox package uses Firefox-specific metadata as manifest.json.
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM
mkdir -p "$tmp_dir/dist"
cp manifest.firefox.json "$tmp_dir/manifest.json"
cp popup.html icon.png "$tmp_dir/"
cp dist/content.js dist/iframe-content.js dist/popup.js "$tmp_dir/dist/"

pack_zip "$firefox_outfile" \
  "$tmp_dir/manifest.json" \
  "$tmp_dir/popup.html" \
  "$tmp_dir/icon.png" \
  "$tmp_dir/dist"

echo "Pack complete: $outfile"
echo "Pack complete: $firefox_outfile"
