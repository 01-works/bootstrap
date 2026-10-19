#!/usr/bin/env bash
# 자동 갱신 등록: 로그인할 때와 10분마다 ./bootstrap.sh update --auto를 실행하는 LaunchAgent. 모든 기기가 같다.
# 등록하면 바로 한 번 실행되지만, 설치 중에는 잠금 때문에 건너뛰고 다음 주기부터 확인한다. 끄는 법은 README "변경 전파".
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if ! has node; then
  if [[ "$DRY_RUN" == 1 ]]; then
    info '[dry-run] Node 설치 후 자동 갱신 등록'
    exit 0
  fi
  die 'Node 없음. ./bootstrap.sh --only runtimes,autoupdate 로 다시 실행하세요'
fi
# 자동 갱신은 자기 등록을 다시 올리지 않는다. 내렸다 올리면 실행 중인 갱신이 함께 끝난다(바뀌었으면 대기).
# shellcheck disable=SC2046
node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only update "$(device_flag)" $(no_restart_flag)
