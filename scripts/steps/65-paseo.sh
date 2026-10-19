#!/usr/bin/env bash
# 사용자 스킬 연결, Paseo 데몬 첫 설정(앱 없이), 빠진 프로필 추가와 에이전트용 Paseo 도구 켜기.
# 늘 켜두는 기기는 로그인할 때 데몬을 자동으로 띄운다. 기존 프로필 수정은 --update.
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

# 첫 설정: 앱의 첫 실행 화면 대신 공식 CLI로 설정을 만들고 데몬을 띄운다.
# 고정값: 원격(릴레이) 연결 켬, 음성 기능 끔. 이미 설정이 있으면 건드리지 않는다.
paseo_home="${PASEO_HOME:-$HOME/.paseo}"
if [[ -f "$paseo_home/config.json" ]]; then
  ok "Paseo 설정 ($(pretty "$paseo_home"))"
else
  run paseo onboard --home "$paseo_home" --relay --voice disable --timeout 600 </dev/null
fi

# 자동 시작 등록이 실패해도 프로필 설정은 계속한다. 실패(1)가 수동 작업 대기(2)보다 우선한다.
autostart=0
node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only paseo "$(device_flag)" || autostart=1
profiles=0
node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs" || profiles=$?
[[ "$autostart" == 0 ]] || exit 1
exit "$profiles"
