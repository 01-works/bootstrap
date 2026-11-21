#!/usr/bin/env bash
# 사용자 스킬 연결, Paseo 데몬 첫 설정(앱 없이), 빠진 프로필 추가와 에이전트용 Paseo 도구 켜기·머지 후 자동 아카이브 끄기, 기본 플러그인 설치·버전 맞춤, 기본 스킬 첫 설치.
# 늘 켜두는 기기는 로그인할 때 데몬을 자동으로 띄우고, 한 시간마다 Paseo 새 버전을 확인해 올린다(scripts/paseo-upgrade.sh).
# 기존 프로필 수정은 --update.
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
# Paseo 에이전트 안에서 실행해도 같다. 데몬을 내리면 그 에이전트와 이 실행도 함께 끝난다 (paseo-upgrade.sh와 같은 확인).
# 터미널에서 실행해도 실행 중인 에이전트가 있으면 같다. 데몬이 꺼졌다고 확인되거나 목록에 실행 중인 에이전트가 0개일 때만
# 다시 올린다. 상태나 목록을 읽지 못하면 바쁜 것으로 본다. 노트북은 데몬 등록이 없어 확인하지 않는다.
daemon_restart="$(no_restart_flag)"
[[ -z "${PASEO_AGENT_ID:-}" ]] || daemon_restart=--no-restart
busy=0
if [[ -z "$daemon_restart" && "$DRY_RUN" != 1 ]] && ! is_laptop && has paseo &&
  ! { paseo daemon status --json 2>/dev/null || true; } | grep -q '"localDaemon": *"stopped"'; then
  busy="$(paseo ls -g -a --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const list = JSON.parse(s);
      if (!Array.isArray(list)) process.exit(1);
      console.log(list.filter(agent => agent.status === "running").length);
    });' 2>/dev/null)" || busy='?'
  [[ "$busy" =~ ^[0-9]+$ ]] || busy='?'
  [[ "$busy" == 0 ]] || daemon_restart=--no-restart
fi
autostart=0
# shellcheck disable=SC2086
node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only paseo "$(device_flag)" $daemon_restart || autostart=$?
if [[ "$autostart" == 2 && -n "${PASEO_AGENT_ID:-}" ]]; then
  warn 'Paseo 에이전트 안이라 데몬 등록을 다시 올리지 않았습니다(데몬과 함께 끝남) → 터미널에서 ./bootstrap.sh update'
elif [[ "$autostart" == 2 && "$busy" != 0 ]]; then
  if [[ "$busy" == '?' ]]; then reason='Paseo 에이전트 목록을 확인할 수 없어'; else reason="실행 중인 에이전트(${busy}개)가 있어"; fi
  warn "${reason} 데몬 등록을 다시 올리지 않았습니다(내리면 함께 끝남) → 에이전트가 끝난 뒤, 또는 paseo daemon stop 후 터미널에서 ./bootstrap.sh update"
fi
upgrade=0
# shellcheck disable=SC2046
node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only paseo-upgrade "$(device_flag)" $(no_restart_flag) || upgrade=$?
profiles=0
node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs" || profiles=$?
plugins=0
node "$BOOTSTRAP_ROOT/scripts/paseo-plugins.mjs" || plugins=$?
skills=0
node "$BOOTSTRAP_ROOT/scripts/paseo-skills.mjs" || skills=$?
api_profiles=0
if has infisical && has python3; then
  run python3 "$BOOTSTRAP_ROOT/scripts/paseo-api-key.py" --infisical --if-ready --home "$paseo_home" </dev/null || api_profiles=$?
fi
st=0
for s in "$autostart" "$upgrade" "$profiles" "$plugins" "$skills" "$api_profiles"; do
  [[ "$s" == 0 || "$s" == 2 ]] || exit 1
  [[ "$s" == 0 ]] || st=2
done
exit "$st"
