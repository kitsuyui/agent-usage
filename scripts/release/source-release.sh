#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${GITHUB_REF:?}" "${RELEASE_TAG:?}" "${CI_WORKFLOW:?}"
[[ "$GITHUB_REF" == refs/heads/main ]] || { echo 'Dispatch from main.' >&2; exit 1; }
[[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Expected a stable version tag such as v1.2.3.' >&2; exit 1; }
repo="$GITHUB_REPOSITORY"
sha="$GITHUB_SHA"
current=$(gh api "repos/$repo/commits/main" --jq .sha)
[[ "$sha" == "$current" ]] || { echo 'main changed since dispatch; restart validation.' >&2; exit 1; }
result=$(gh api "repos/$repo/actions/workflows/$CI_WORKFLOW/runs?head_sha=$sha&event=push&per_page=1" --jq '.workflow_runs[0] | if . == null then "missing" else .status + ":" + (.conclusion // "") end')
[[ "$result" == completed:success ]] || { echo "Required main CI has not succeeded: $result" >&2; exit 1; }
# Creating the ref is atomic: an existing tag causes the API call to fail.
gh api --method POST "repos/$repo/git/refs" -f "ref=refs/tags/$RELEASE_TAG" -f "sha=$sha" >/dev/null
actual=$(gh api "repos/$repo/git/ref/tags/$RELEASE_TAG" --jq .object.sha)
[[ "$actual" == "$sha" ]] || { echo 'Tag target mismatch.' >&2; exit 1; }
gh release create "$RELEASE_TAG" --verify-tag --repo "$repo" --title "$RELEASE_TAG" --notes "Source release for $RELEASE_TAG. See the repository README for setup and usage."
actual=$(gh api "repos/$repo/git/ref/tags/$RELEASE_TAG" --jq .object.sha)
[[ "$actual" == "$sha" ]] || { echo 'Tag target changed during release creation.' >&2; exit 1; }
