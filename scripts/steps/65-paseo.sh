#!/usr/bin/env bash
# 사용자 스킬 연결, Paseo 데몬 첫 설정(앱 없이), 빠진 프로필 추가와 에이전트용 Paseo 도구 켜기, 기본 플러그인 설치·버전 맞춤, 기본 스킬 첫 설치.
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
# Homebrew 밖에서 설치한 앱은 CLI 연결이 없을 수 있다. 앱 안의 CLI를 ~/.local/bin(PATH에 있음)에 연결한다.
paseo_cli=/Applications/Paseo.app/Contents/Resources/bin/paseo
paseo_link="$HOME/.local/bin/paseo"
if ! has paseo && [[ -x "$paseo_cli" ]]; then
  if [[ -e "$paseo_link" && ! -L "$paseo_link" ]]; then
    warn "$(pretty "$paseo_link")가 링크가 아닌 파일이라 그대로 둡니다"
  else
    run mkdir -p "$(dirname "$paseo_link")"
    run ln -sfn "$paseo_cli" "$paseo_link"
    ok "Paseo CLI 연결 ($(pretty "$paseo_link"))"
  fi
fi
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
  # 데몬이 이 실행의 환경을 물려받지 않게 한다. 데몬이 띄운 에이전트가 bootstrap을 자동 갱신으로 착각하지 않도록.
  run env -u BOOTSTRAP_UNATTENDED -u BOOTSTRAP_LOCKED -u BOOTSTRAP_RESULTS \
    paseo onboard --home "$paseo_home" --relay --voice disable --timeout 600 </dev/null
fi

# 자동 시작 등록이 실패해도 프로필 설정은 계속한다. 실패(1)가 수동 작업 대기(2)보다 우선한다.
# 자동 갱신 중에는 실행 중인 데몬 등록을 다시 올리지 않는다(바뀌었으면 대기). 데몬과 그 에이전트가 끝나기 때문이다.
autostart=0
# shellcheck disable=SC2046
node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only paseo "$(device_flag)" $(no_restart_flag) || autostart=$?
profiles=0
node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs" || profiles=$?
plugins=0
node "$BOOTSTRAP_ROOT/scripts/paseo-plugins.mjs" || plugins=$?
skills=0
node "$BOOTSTRAP_ROOT/scripts/paseo-skills.mjs" || skills=$?
st=0
for s in "$autostart" "$profiles" "$plugins" "$skills"; do
  [[ "$s" == 0 || "$s" == 2 ]] || exit 1
  [[ "$s" == 0 ]] || st=2
done
exit "$st"
