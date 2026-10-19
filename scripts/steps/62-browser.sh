#!/usr/bin/env bash
# 브라우저 작업의 기본 도구 Browser Use CLI와 공식 스킬, 에이전트 전용 Chrome(Chrome Beta) 자동 시작.
# 개인 Chrome은 건드리지 않는다. 사용자가 요청할 때 처음 한 번 Chrome에서 직접 허용한다 (agents/browser.md).
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if [[ "$DRY_RUN" == 1 ]]; then
  info '[dry-run] Browser Use CLI가 없으면 uv로 설치, 공식 스킬을 Codex·Claude 경로에 충돌 검사 후 배치'
  info '[dry-run] 에이전트 Chrome 자동 시작 등록(늘 켜두는 기기는 로그인 시 실행), Browser Use 기본 연결을 에이전트 Chrome으로'
  exit 0
fi
has node || die 'Node 없음. ./bootstrap.sh --only runtimes,browser 로 다시 실행하세요'

# 한쪽 실패로 다른 설정을 막지 않는다. 자동 갱신 중에는 실행 중인 에이전트 Chrome을 다시 시작하지 않는다(바뀌었으면 대기).
status=0
node "$BOOTSTRAP_ROOT/scripts/browser-use-setup.mjs" || status=1
agent=0
# shellcheck disable=SC2046
node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only agent-chrome "$(device_flag)" $(no_restart_flag) || agent=$?
case "$agent" in
  0) ;;
  2) [[ "$status" == 1 ]] || status=2 ;;
  *) status=1 ;;
esac
exit "$status"
