#!/usr/bin/env bash
set -euo pipefail

# Release script — bumps version in package.json, commits, tags, and pushes.
# Usage: ./release.sh <major|minor|patch>
#
# Example:
#   ./release.sh patch   # 0.4.0 → 0.4.1
#   ./release.sh minor   # 0.4.0 → 0.5.0
#   ./release.sh major   # 0.4.0 → 1.0.0
#
# The tag push triggers the GitHub Actions release workflow which
# packages and publishes a new release.

BUMP_TYPE="${1:-}"

if [[ -z "$BUMP_TYPE" ]]; then
  echo "Usage: ./release.sh <major|minor|patch>"
  exit 1
fi

if [[ "$BUMP_TYPE" != "major" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "patch" ]]; then
  echo "Error: argument must be 'major', 'minor', or 'patch'"
  echo "Usage: ./release.sh <major|minor|patch>"
  exit 1
fi

# Ensure we're on main and clean
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch (currently on '$BRANCH')"
  exit 1
fi

if [[ -n "$(git status --porcelain -- ':!.claude' ':!.pi' ':!openspec')" ]]; then
  echo "Error: working tree has uncommitted changes (excluding tooling dirs)"
  echo "Commit or stash changes before releasing."
  git status --short -- ':!.claude' ':!.pi' ':!openspec'
  exit 1
fi

# Read current version from package.json
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' package.json | head -1 | cut -d'"' -f4)

if [[ -z "$CURRENT_VERSION" ]]; then
  echo "Error: could not read version from package.json"
  exit 1
fi

# Parse semver
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Bump
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW_VERSION}"

# Check tag doesn't already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists"
  exit 1
fi

echo "Releasing: $CURRENT_VERSION → $NEW_VERSION ($BUMP_TYPE)"
echo ""

# Update package.json (non-interactive sed)
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" package.json
else
  sed -i "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" package.json
fi

# Verify it changed
VERIFY_VERSION=$(grep -o '"version": "[^"]*"' package.json | head -1 | cut -d'"' -f4)
if [[ "$VERIFY_VERSION" != "$NEW_VERSION" ]]; then
  echo "Error: failed to update version in package.json"
  exit 1
fi

# Commit, tag, push
git add package.json
git commit -m "Release ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"
git push origin main
git push origin "$TAG"

echo ""
echo "✅ Released ${TAG}"
echo "   GitHub Actions will create the release automatically."
