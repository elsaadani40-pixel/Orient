#!/usr/bin/env bash
set -euo pipefail

project_key="${SONAR_PROJECT_KEY:-elsaadani40-pixel_Orient}"
pull_request="${SONAR_PULL_REQUEST:-394}"
base_url="${SONAR_HOST_URL:-https://sonarcloud.io}"
out_dir="${SONAR_REPORT_DIR:-artifacts/sonarcloud}"
mkdir -p "$out_dir"

if ! [[ "$pull_request" =~ ^[0-9]+$ ]]; then
  echo "SONAR_PULL_REQUEST must be a numeric pull request number" >&2
  exit 2
fi

api_get() {
  local endpoint="$1"
  shift
  curl --silent --show-error --fail-with-body --retry 3 --retry-all-errors \
    --get "${base_url%/}/api/$endpoint" "$@" \
    -H 'Accept: application/json'
}

write_json() {
  local name="$1"
  local endpoint="$2"
  shift 2
  local tmp="$out_dir/$name.tmp"
  if ! api_get "$endpoint" "$@" > "$tmp"; then
    echo "SonarCloud API request failed for endpoint '$endpoint'. Check project key, project visibility, and whether an authorized read-only SONAR_TOKEN is required." >&2
    rm -f "$tmp"
    return 1
  fi
  if ! jq -e 'type == "object" and (has("errors") | not)' "$tmp" >/dev/null; then
    echo "SonarCloud API returned an error payload for endpoint '$endpoint': $(jq -c '.errors // .' "$tmp" | head -c 1000)" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$out_dir/$name.json"
}

echo "Exporting SonarCloud diagnostics for project=$project_key pullRequest=$pull_request"

write_json quality-gate qualitygates/project_status \
  --data-urlencode "projectKey=$project_key" \
  --data-urlencode "pullRequest=$pull_request"

write_json measures measures/component \
  --data-urlencode "component=$project_key" \
  --data-urlencode "pullRequest=$pull_request" \
  --data-urlencode "metricKeys=new_duplicated_lines_density,new_security_rating,new_issues,new_vulnerabilities,new_security_hotspots"

# Export every issue page, bounded to avoid an unbounded CI job.
page=1
page_size=500
total=0
: > "$out_dir/issues-pages.jsonl"
while (( page <= 20 )); do
  response="$out_dir/issues-page-$page.tmp"
  api_get issues/search \
    --data-urlencode "componentKeys=$project_key" \
    --data-urlencode "pullRequest=$pull_request" \
    --data-urlencode "resolved=false" \
    --data-urlencode "ps=$page_size" \
    --data-urlencode "p=$page" \
    --data-urlencode "additionalFields=rules,transitions,actions" > "$response"
  jq -e 'type == "object" and has("issues") and has("paging")' "$response" >/dev/null
  jq -c '{paging,issues}' "$response" >> "$out_dir/issues-pages.jsonl"
  total="$(jq -r '.paging.total' "$response")"
  rm "$response"
  (( page * page_size >= total )) && break
  page=$((page + 1))
done
if (( page > 20 && page * page_size < total )); then
  echo "Issue export exceeded the 10,000-result safety bound; refusing to claim completeness" >&2
  exit 3
fi
jq -s '{total: (.[0].paging.total // 0), issues: [.[].issues[]]}' \
  "$out_dir/issues-pages.jsonl" > "$out_dir/issues.json"
rm "$out_dir/issues-pages.jsonl"

# Security hotspots are a separate SonarCloud API resource from ordinary issues.
if api_get hotspots/search \
  --data-urlencode "projectKey=$project_key" \
  --data-urlencode "pullRequest=$pull_request" \
  --data-urlencode "ps=500" \
  --data-urlencode "p=1" > "$out_dir/hotspots.json.tmp"; then
  jq -e 'type == "object" and has("hotspots")' "$out_dir/hotspots.json.tmp" >/dev/null
  mv "$out_dir/hotspots.json.tmp" "$out_dir/hotspots.json"
else
  rm -f "$out_dir/hotspots.json.tmp"
  printf '{"available":false,"reason":"SonarCloud hotspot endpoint unavailable to this project/API access"}\n' > "$out_dir/hotspots.json"
fi

{
  echo "## SonarCloud PR #$pull_request diagnostics"
  echo
  echo "- Project: `$project_key`"
  echo "- Issue records exported: $(jq -r '.total' "$out_dir/issues.json")"
  echo "- Open issues: $(jq -r '.issues | length' "$out_dir/issues.json")"
  echo
  echo "### Quality gate"
  jq -r '"Status: " + (.projectStatus.status // "unknown"), (.projectStatus.conditions[]? | "- " + .metricKey + ": " + (.actualValue // "n/a") + " (threshold " + (.errorThreshold // "n/a") + ")")' "$out_dir/quality-gate.json"
  echo
  echo "### Open issues"
  jq -r '.issues[]? | "- [" + (.severity // "UNKNOWN") + "] " + (.rule // "unknown-rule") + " — " + (.component // "unknown-component") + (if .line then ":" + (.line|tostring) else "" end) + " — " + (.message // "")' "$out_dir/issues.json"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "SonarCloud diagnostic export completed."
echo "Artifacts written under $out_dir"
