#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/gh" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *'/commits/main'*) printf '%s\n' "$MOCK_SHA" ;;
  *'/actions/workflows/'*) printf '%s\n' "$MOCK_CI" ;;
  *'/git/refs'*) test "$MOCK_CREATE" = success ;;
  *'/git/ref/tags/'*) printf '%s\n' "$MOCK_TAG_SHA" ;;
  'release create '*) exit 0 ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$tmp/gh"
export PATH="$tmp:$PATH" GH_TOKEN=test GITHUB_REPOSITORY=example/example GITHUB_REF=refs/heads/main
export GITHUB_SHA=abc RELEASE_TAG=v1.2.3 CI_WORKFLOW=test.yml
export MOCK_LOG="$tmp/log" MOCK_SHA=abc MOCK_TAG_SHA=abc MOCK_CI=completed:success MOCK_CREATE=success
bash "$root/scripts/release/source-release.sh" >/dev/null
grep -q '^release create' "$MOCK_LOG"
: > "$MOCK_LOG"
MOCK_CI=completed:failure bash "$root/scripts/release/source-release.sh" >/dev/null 2>&1 && exit 1
if grep -q 'git/refs' "$MOCK_LOG"; then exit 1; fi
: > "$MOCK_LOG"
MOCK_CREATE=failure bash "$root/scripts/release/source-release.sh" >/dev/null 2>&1 && exit 1
if grep -q '^release create' "$MOCK_LOG"; then exit 1; fi
: > "$MOCK_LOG"
MOCK_TAG_SHA=other bash "$root/scripts/release/source-release.sh" >/dev/null 2>&1 && exit 1
if grep -q '^release create' "$MOCK_LOG"; then exit 1; fi
echo 'source release checks passed'
