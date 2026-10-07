#!/usr/bin/env bash
# Xcode 명령줄 도구 (git, clang, python3 등). Homebrew보다 먼저 필요하다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode 명령줄 도구 ($(xcode-select -p))"
else
  run xcode-select --install
  [[ "$DRY_RUN" == 1 ]] && exit 0
  info "설치 창이 떴습니다. 설치가 끝날 때까지 기다립니다 (중단: Ctrl-C)"
  until xcode-select -p >/dev/null 2>&1; do
    sleep 5
  done
  ok "Xcode 명령줄 도구 설치됨"
fi

# 이 저장소의 커밋 전 비밀값 검사(.githooks/pre-commit)를 켠다. git이 이 단계에서 생기므로 여기서 한다.
if [[ -d "$BOOTSTRAP_ROOT/.git" ]]; then
  if [[ "$(git -C "$BOOTSTRAP_ROOT" config core.hooksPath || true)" == .githooks ]]; then
    ok "커밋 전 검사 훅"
  else
    run git -C "$BOOTSTRAP_ROOT" config core.hooksPath .githooks
    ok "커밋 전 검사 훅 켬"
  fi
fi
