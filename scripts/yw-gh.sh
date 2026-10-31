#!/bin/bash
# yw-gh: 에이전트 세션의 gh를 에이전트 전용 GitHub App 신원으로 실행하는 ~/.local/bin/gh 앞단. 동작·한계: agents/github-app.md
# 설치본은 ghapp 단계(scripts/steps/67-ghapp.sh)가 아래 세 경로를 채운다. 사람 터미널은 실제 gh를 그대로 실행하고 node도 띄우지 않는다.
# 에이전트 모드: YW_GH_IDENTITY=agent, 또는 YW_GH_IDENTITY가 비어 있고 PASEO_AGENT_ID가 있을 때.
real='__YW_GH_REAL__'
core='__YW_GH_CORE__'
self='__YW_GH_SELF__'

identity="${YW_GH_IDENTITY:-}"
if [[ -z "$identity" && -n "${PASEO_AGENT_ID:-}" ]]; then
  identity=agent
fi

case "$identity" in
  '')
    exec "$real" "$@"
    ;;
  owner)
    # 에이전트 모드에서 이 앞단이 넣은 App 토큰을 물려받았으면 지운다. 그래야 실제 gh가 소유자 로그인을 쓴다.
    if [[ "${YW_GH_INJECTED:-}" == 1 ]]; then
      unset GH_TOKEN YW_GH_INJECTED
    fi
    exec "$real" "$@"
    ;;
  agent)
    if ! command -v node >/dev/null 2>&1; then
      echo "yw-gh: 에이전트 모드에 node가 필요합니다. 소유자 인증으로 넘기지 않습니다" >&2
      exit 1
    fi
    YW_GH_REAL="$real" YW_GH_SELF="$self" exec node "$core" "$@"
    ;;
  *)
    echo "yw-gh: YW_GH_IDENTITY는 agent 또는 owner만 씁니다 (지금: $identity)" >&2
    exit 1
    ;;
esac
