#!/bin/bash
# yw-gh: 에이전트 세션의 gh를 에이전트 전용 GitHub App 신원으로 실행하는 ~/.local/bin/gh 앞단. 동작·한계: agents/github-app.md
# 설치본은 ghapp 단계(scripts/steps/67-ghapp.sh)가 아래 세 경로를 채운다. 사람 터미널은 실제 gh를 그대로 실행하고 node도 띄우지 않는다.
# 에이전트 모드: YW_GH_IDENTITY=agent, 또는 YW_GH_IDENTITY가 비어 있고 PASEO_AGENT_ID가 있을 때.
real='__YW_GH_REAL__'
core='__YW_GH_CORE__'
self='__YW_GH_SELF__'

# 모든 분기에서 gh가 자기 경로를 이 앞단으로 알게 한다. 그래야 setup-git이 credential helper에 실제 gh 절대 경로를 적지 않는다.
export GH_PATH="$self"

identity="${YW_GH_IDENTITY:-}"
if [[ -z "$identity" && -n "${PASEO_AGENT_ID:-}" ]]; then
  identity=agent
fi
# 기기 단위 명시적 끄기: 믿을 수 있는 끄기 파일이 있으면 에이전트 모드도 소유자 인증을 쓴다. 설치 단계는 만들지 않는다.
# 끄기 파일은 현재 사용자 소유의 일반 파일(링크 아님), 설정 디렉터리는 현재 사용자 소유·링크 아님·group/other 쓰기 불가여야 한다.
# 조건이 맞지 않으면 무시한다 (= 설정 없음 → 실패). scripts/yw-gh-lib.sh의 yw_gh_disabled와 같은 판정이다.
disabled() {
  local dir="${YW_GH_APP_CONFIG_DIR:-$HOME/.config/yw-gh-app}" perm
  [[ -d "$dir" && ! -L "$dir" && -O "$dir" && -f "$dir/disabled" && ! -L "$dir/disabled" && -O "$dir/disabled" ]] || return 1
  perm="$(/usr/bin/stat -f %Lp "$dir" 2>/dev/null)" || return 1
  (((8#$perm & 8#022) == 0))
}
if [[ "$identity" == agent ]] && disabled; then
  identity=owner
fi
credential=0
if [[ "${1:-}" == auth && "${2:-}" == git-credential ]]; then
  credential=1
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
    export YW_GH_REAL="$real" YW_GH_SELF="$self"
    if [[ "$credential" == 1 ]]; then
      # git credential: 본체 진입 전 실패(node 없음·본체 누락·기동 실패)까지 quit=true로 멈춰 다음 helper로 넘어가지 않게 한다.
      if out="$(node "$core" "$@")"; then
        if [[ -n "$out" ]]; then printf '%s\n' "$out"; fi
        exit 0
      fi
      printf 'quit=true\n'
      exit 1
    fi
    if ! command -v node >/dev/null 2>&1; then
      echo "yw-gh: 에이전트 모드에 node가 필요합니다. 소유자 인증으로 넘기지 않습니다" >&2
      exit 1
    fi
    exec node "$core" "$@"
    ;;
  *)
    if [[ "$credential" == 1 ]]; then
      printf 'quit=true\n'
    fi
    echo "yw-gh: YW_GH_IDENTITY는 agent 또는 owner만 씁니다 (지금: $identity)" >&2
    exit 1
    ;;
esac
