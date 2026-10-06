#!/usr/bin/env bash
# 이 Mac에는 있는데 저장소에는 없는 것을 찾는다. 아무것도 바꾸지 않는다.
# 새 도구를 설치한 뒤 돌려서 Brewfile에 옮겨 적을 것을 확인하는 용도.
set -uo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

has brew || die "brew가 없습니다"

# Brewfile 줄을 "종류 이름"으로 정규화한다. mas는 이름 대신 id로 비교한다.
normalize() {
  sed -nE \
    -e 's/^mas "[^"]*", *id: *([0-9]+).*/mas \1/p' \
    -e 's/^(tap|brew|cask|vscode|cargo|uv|npm|go) "([^"]+)".*/\1 \2/p' |
    tr '[:upper:]' '[:lower:]' | sort -u
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

brew bundle dump --file=- 2>/dev/null | normalize >"$tmp/installed"
all_brewfiles=''
for f in "$BOOTSTRAP_ROOT"/Brewfile*; do
  all_brewfiles="$all_brewfiles $f"
done
# shellcheck disable=SC2086
cat $all_brewfiles | normalize >"$tmp/listed_any"
# shellcheck disable=SC2086
cat $(for f in $BREWFILES; do printf '%s ' "$BOOTSTRAP_ROOT/$f"; done) | normalize >"$tmp/listed_profile"

step "설치되어 있지만 어느 Brewfile에도 없음"
comm -23 "$tmp/installed" "$tmp/listed_any" | sed 's/^/    /'
info "${_dim}→ 계속 쓸 거면 Brewfile에 추가, 안 쓰면 지우기${_reset}"

step "이 프로필의 Brewfile에 있지만 설치 안 됨"
comm -13 "$tmp/installed" "$tmp/listed_profile" | grep -v '^tap ' | sed 's/^/    /'

step "/Applications 중 Homebrew나 App Store로 관리하지 않는 앱"
brew info --cask --installed --json=v2 2>/dev/null |
  /usr/bin/python3 -c '
import json, sys
for c in json.load(sys.stdin)["casks"]:
    for a in c.get("artifacts", []):
        for app in a.get("app", []) if isinstance(a, dict) else []:
            if isinstance(app, str):
                print(app)
' | sort -u >"$tmp/cask_apps"
for app in /Applications/*.app; do
  name="$(basename "$app")"
  [[ -d "$app/Contents/_MASReceipt" ]] && continue
  grep -qxF "$name" "$tmp/cask_apps" && continue
  case "$name" in Safari.app | Utilities.app) continue ;; esac
  printf '    %s\n' "$name"
done
info "${_dim}→ cask가 있으면 Brewfile에 추가하고 brew install --cask --adopt <이름> (development/homebrew.md)${_reset}"
