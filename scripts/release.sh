#!/usr/bin/env bash
# release.sh — build and package the extension for a GitHub Release
#
# Usage:
#   ./scripts/release.sh 2.0.0
#
# What it does:
#   1. Sets the version in package.json
#   2. Runs the full verification suite
#   3. Packages the .vsix
#   4. Prints next steps for creating the GitHub Release

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>  (e.g. $0 2.0.0)"
  exit 1
fi

echo "==> Setting version to $VERSION"
npm version "$VERSION" --no-git-tag-version

echo "==> Running verification suite"
npm run compile
npm run lint
npm run test:unit

echo "==> Packaging extension"
npm run package

VSIX_FILE="zgx-toolkit-${VERSION}.vsix"
echo ""
echo "✓ Build complete: $VSIX_FILE"
echo ""
echo "Next steps:"
echo "  1. Commit the version bump:"
echo "     git add package.json package-lock.json"
echo "     git commit -m \"chore: release v${VERSION}\""
echo "  2. Tag the release:"
echo "     git tag v${VERSION}"
echo "     git push origin main --tags"
echo "  3. On GitHub, go to Releases → Draft a new release"
echo "     → Choose tag v${VERSION}"
echo "     → Attach ${VSIX_FILE} as a release asset"
echo "     → Publish release"
echo ""
echo "Users install with:"
echo "  code --install-extension ${VSIX_FILE}"
