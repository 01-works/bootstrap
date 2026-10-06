#!/usr/bin/env bash
# Xcode 명령줄 도구 (git, clang, python3 등). Homebrew보다 먼저 필요하다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode 명령줄 도구 ($(xcode-select -p))"
  exit 0
fi

run xcode-select --install
[[ "$DRY_RUN" == 1 ]] && exit 0

info "설치 창이 떴습니다. 설치가 끝날 때까지 기다립니다 (중단: Ctrl-C)"
until xcode-select -p >/dev/null 2>&1; do
  sleep 5
done
ok "Xcode 명령줄 도구 설치됨"
