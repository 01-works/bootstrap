#!/usr/bin/env bash
# 사용자 스킬 연결 후 Paseo 설정에 빠진 프로필을 추가하고 에이전트용 Paseo 도구를 켠다. 기존 프로필 수정은 --update.
# 늘 켜두는 기기는 로그인할 때 Paseo 앱(데몬 포함)을 자동으로 띄운다.
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
# 자동 시작 등록이 실패해도 프로필 설정은 계속한다. 실패(1)가 수동 작업 대기(2)보다 우선한다.
autostart=0
node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only paseo "$(device_flag)" || autostart=1
if ! has paseo; then
  warn 'paseo 없음 (Brewfile의 cask "paseo" 확인)'
  [[ "$DRY_RUN" == 1 ]] && exit 0
  exit 1
fi
profiles=0
node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs" || profiles=$?
[[ "$autostart" == 0 ]] || exit 1
exit "$profiles"
