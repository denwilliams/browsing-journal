#!/bin/sh
# Build the Safari app that contains the extension: safari/build/Browsing Journal.app
#
# Safari extensions live inside a small macOS app. This assembles the shared extension files (from chrome/) with
# Safari's own manifest, runs Apple's converter and builds the result. By default it is signed ad hoc,
# which Safari only loads with Develop > Allow Unsigned Extensions turned on. Set TEAM_ID=<your team id>
# to sign it with your own Apple Development certificate instead (see the README).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/safari/build
APP=${APP_NAME:-Browsing Journal}
# The converter derives the app id from the app name, so the last part must match it.
BUNDLE_ID=${BUNDLE_ID:-com.den.Browsing-Journal}

# The converter and the build need Xcode, not just the Command Line Tools.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

rm -rf "$OUT"
mkdir -p "$OUT/extension"
cp "$ROOT"/chrome/background.js "$ROOT"/chrome/shared.js "$ROOT"/chrome/popup.js \
   "$ROOT"/chrome/popup.html "$OUT/extension/"
cp "$ROOT/safari/manifest.json" "$ROOT/safari/activity.js" "$OUT/extension/"

xcrun safari-web-extension-converter "$OUT/extension" \
  --project-location "$OUT" --app-name "$APP" --bundle-identifier "$BUNDLE_ID" \
  --macos-only --swift --copy-resources --no-open --no-prompt --force

build() {
  xcodebuild -project "$OUT/$APP/$APP.xcodeproj" -scheme "$APP" -configuration Release \
    -derivedDataPath "$OUT/derived" "$@" build
}
if [ -n "${TEAM_ID:-}" ]; then
  # Signed with your own Apple Development certificate (needs your Apple ID added in Xcode).
  build -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic
else
  # Ad hoc: Safari only loads this with Develop > Allow Unsigned Extensions turned on.
  build CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES
fi

cp -R "$OUT/derived/Build/Products/Release/$APP.app" "$OUT/"
echo "Built $OUT/$APP.app"
