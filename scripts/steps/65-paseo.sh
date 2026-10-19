#!/usr/bin/env bash
# 사용자 스킬 연결 후 Paseo 설정에 빠진 프로필을 추가하고 에이전트용 Paseo 도구를 켠다. 기존 프로필 수정은 --update.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if ! has node; then
  if [[ "$DRY_RUN" == 1 ]]; then
    info '[dry-run] Node 설치 후 사용자 스킬 연결, Paseo 프로필·도구 설정'
    exit 0
  fi
  die 'Node 없음. ./bootstrap.sh --only runtimes,paseo 로 다시 실행하세요'
fi
node "$BOOTSTRAP_ROOT/scripts/agent-skills.mjs"
if ! has paseo; then
  warn 'paseo 없음 (Brewfile의 cask "paseo" 확인)'
  [[ "$DRY_RUN" == 1 ]] && exit 0
  exit 1
fi
node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs"
