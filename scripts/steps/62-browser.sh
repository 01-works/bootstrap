#!/usr/bin/env bash
# 브라우저 작업의 기본 도구 Browser Use CLI와 공식 스킬, Chrome 승인형 원격 디버깅 설정.
# 연결·승인은 이 단계에서 하지 않는다 (agents/browser.md).
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if [[ "$DRY_RUN" == 1 ]]; then
  info '[dry-run] Browser Use CLI가 없으면 uv로 설치, 공식 스킬을 Codex·Claude 경로에 충돌 검사 후 배치'
  info '[dry-run] Chrome이 종료되어 있으면 승인형 원격 디버깅 설정 (실행 중이면 안내)'
  exit 0
fi
has node || die 'Node 없음. ./bootstrap.sh --only runtimes,browser 로 다시 실행하세요'

# 한쪽 실패로 다른 쪽 설정을 막지 않는다. 실패(1)가 수동 작업 대기(2)보다 우선한다.
status=0
node "$BOOTSTRAP_ROOT/scripts/browser-use-setup.mjs" || status=1
chrome=0
node "$BOOTSTRAP_ROOT/scripts/browser-settings.mjs" || chrome=$?
[[ "$status" != 0 ]] || status="$chrome"
exit "$status"
