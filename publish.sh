#!/usr/bin/env sh
set -eu

LOCAL_JSON="${1:-firefox-update/addons.json}"
LOCAL_XPI_DIR="${LOCAL_XPI_DIR:-firefox-update/xpi}"
REMOTE_HOST="${REMOTE_HOST:-minischiff}"
REMOTE_UPDATE_DIR="${REMOTE_UPDATE_DIR:-~/docker/sites/extensions.stschiff.de/firefox/proxer-skip}"
REMOTE_TMP_DIR="${REMOTE_TMP_DIR:-/tmp/proxer-skip-upload}"
BASE_UPDATE_URL="${BASE_UPDATE_URL:-https://extensions.stschiff.de/firefox/proxer-skip}"
REMOTE_XPI_PREFIX="${REMOTE_XPI_PREFIX:-proxer-anime-skip}"

if [ ! -f "$LOCAL_JSON" ]; then
  echo "Error: local file not found: $LOCAL_JSON" >&2
  exit 1
fi

if [ ! -d "$LOCAL_XPI_DIR" ]; then
  echo "Error: local xpi directory not found: $LOCAL_XPI_DIR" >&2
  exit 1
fi

latest_xpi_file="$(find "$LOCAL_XPI_DIR" -maxdepth 1 -type f -name '*.xpi' -printf '%f\n' | sort -V | tail -n 1)"
if [ -z "$latest_xpi_file" ]; then
  echo "Error: no .xpi files found in $LOCAL_XPI_DIR" >&2
  exit 1
fi

latest_version="$(printf '%s' "$latest_xpi_file" | sed -nE 's/.*-([0-9]+(\.[0-9]+)*)\.xpi$/\1/p')"
if [ -z "$latest_version" ]; then
  echo "Error: could not parse version from xpi file name: $latest_xpi_file" >&2
  echo "Expected name like anything-1.2.xpi" >&2
  exit 1
fi

local_xpi_path="$LOCAL_XPI_DIR/$latest_xpi_file"
remote_xpi_name="$REMOTE_XPI_PREFIX-$latest_version.xpi"
remote_xpi_url="$BASE_UPDATE_URL/$remote_xpi_name"

escaped_version="$(printf '%s' "$latest_version" | sed 's/[&|]/\\&/g')"
escaped_update_url="$(printf '%s' "$remote_xpi_url" | sed 's/[&|]/\\&/g')"

tmp_json="$(mktemp)"
trap 'rm -f "$tmp_json"' EXIT INT TERM

sed -E \
  -e "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/s|\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"|\"version\": \"$escaped_version\"|" \
  -e "0,/\"update_link\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/s|\"update_link\"[[:space:]]*:[[:space:]]*\"[^\"]+\"|\"update_link\": \"$escaped_update_url\"|" \
  "$LOCAL_JSON" > "$tmp_json"

cp "$tmp_json" "$LOCAL_JSON"

echo "Publishing $LOCAL_JSON to $REMOTE_HOST:$REMOTE_UPDATE_DIR/addons.json"
echo "Publishing latest XPI $local_xpi_path as $REMOTE_HOST:$REMOTE_UPDATE_DIR/$remote_xpi_name"
ssh "$REMOTE_HOST" "mkdir -p $REMOTE_TMP_DIR"
scp "$LOCAL_JSON" "$REMOTE_HOST:$REMOTE_TMP_DIR/addons.json"
scp "$local_xpi_path" "$REMOTE_HOST:$REMOTE_TMP_DIR/$remote_xpi_name"
ssh "$REMOTE_HOST" "sudo mkdir -p $REMOTE_UPDATE_DIR && sudo install -m 0644 $REMOTE_TMP_DIR/addons.json $REMOTE_UPDATE_DIR/addons.json && sudo install -m 0644 $REMOTE_TMP_DIR/$remote_xpi_name $REMOTE_UPDATE_DIR/$remote_xpi_name"
ssh "$REMOTE_HOST" "rm -f $REMOTE_TMP_DIR/addons.json $REMOTE_TMP_DIR/$remote_xpi_name"

echo "Done."
