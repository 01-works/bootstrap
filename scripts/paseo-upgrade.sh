#!/usr/bin/env bash
# 늘 켜두는 기기의 Paseo 앱·데몬을 정식 최신 버전으로 올린다: ./bootstrap.sh paseo-upgrade [--auto] [--force] [--dry-run]
# 데스크톱은 앱 없이 데몬만 돌아서 앱의 자동 업데이트가 확인하지 않는다. paseo 단계가 등록한 LaunchAgent
# (local.bootstrap.paseo-upgrade)가 한 시간마다 --auto로 부른다. 노트북은 앱이 스스로 업데이트한다.
#   1. 하루에 한 번 Homebrew cask의 최신 버전과 그 GitHub 릴리스의 공개 시각을 확인해 기록한다.
#   2. 공개 뒤 36시간(공식 단계 배포 기간)이 지난 버전이 설치된 앱보다 새것이면 brew upgrade --cask paseo로 올린다.
#      앱이 이미 새 버전인데 데몬이 옛 버전이면(앱이 스스로 업데이트한 경우) 데몬만 다시 시작한다.
#   3. 실행 중(running)인 에이전트가 있으면 하지 않고 다음 주기에 다시 본다. 하루 넘게 못 하면 한 번 알린다.
#   4. cask 제거 단계가 데몬을 멈추므로, 끝나면 자동 시작 등록으로 데몬을 다시 띄우고 버전을 확인한다.
#      paseo daemon restart는 supervisor를 바꾸지 않아서 데몬만 다시 시작할 때도 멈춘 뒤 시작한다.
# --force는 공개 뒤 대기와 실행 중 에이전트 확인을 건너뛴다. 진행 중인 에이전트 작업은 끊긴다.

BOOTSTRAP_ROOT="${BOOTSTRAP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export BOOTSTRAP_ROOT

# 공개 뒤 기다리는 시간, 최신 버전 확인 주기, 실행 중 에이전트 때문에 못 올린 채 알리기까지의 시간.
ROLLOUT_HOURS=36
CHECK_HOURS=24
BLOCKED_HOURS=24
DAEMON_LABEL=local.bootstrap.paseo

usage() {
  cat <<'EOF'
사용법: ./bootstrap.sh paseo-upgrade [--auto] [--force] [--dry-run]
  늘 켜두는 기기의 Paseo를 정식 최신 버전으로 올립니다. 공개 뒤 36시간이 지났고 실행 중인 에이전트가 없을 때만 합니다.
  --auto     자동 실행용(한 시간마다). 할 일이 있을 때만 기록하고, 결과가 바뀌면 알립니다
  --force    공개 뒤 대기와 실행 중 에이전트 확인을 건너뜁니다 (진행 중인 작업이 끊깁니다)
  --dry-run  할 일만 보여 줍니다
EOF
}

# --auto는 할 일이 있을 때만 출력한다 (LaunchAgent 기록). 아무것도 안 한 확인은 남기지 않는다.
say() {
  if [[ "$AUTO" == 1 && "$HEADER_DONE" == 0 ]]; then
    HEADER_DONE=1
    printf '\n[%s]\n' "$(date '+%F %T')"
  fi
  info "$*"
}
quiet() { [[ "$AUTO" == 1 ]] || info "$*"; }

app_version() { plutil -extract CFBundleShortVersionString raw -o - "$PASEO_APP/Contents/Info.plist" 2>/dev/null; }

# a가 b보다 낮은 버전인지: version_lt <a> <b>
version_lt() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

# 데몬 상태 JSON에서 값 하나: daemon_field <JSON> <키>
daemon_field() { plutil -extract "$2" raw -o - - <<<"$1" 2>/dev/null; }

# 결과를 doctor가 읽는 상태 파일에 남긴다: write_status <ok|pending|failed> <한 줄>
write_status() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  printf 'result=%s\nat=%s\nbanner=%s\n' "$1" "$(date +%s)" "$2" >"$STATE/status.tmp"
  mv "$STATE/status.tmp" "$STATE/status"
}

# 같은 내용은 한 번만 알린다 (--auto): notify <중복 확인 키> <제목> <내용> [push]
notify() {
  [[ "$AUTO" == 1 && "$DRY_RUN" != 1 ]] || return 0
  [[ "$(cat "$STATE/notified" 2>/dev/null)" != "$1" ]] || return 0
  printf '%s\n' "$1" >"$STATE/notified"
  send_notification "$2" "$3" "${4:-}"
}

# Homebrew cask의 최신 버전과 GitHub 릴리스 공개 시각을 $STATE/latest에 "<버전> <공개 시각(초)>"로 남긴다.
check_latest() {
  local json version published epoch
  if ! brew list --cask paseo >/dev/null 2>&1; then
    quiet 'Homebrew 밖에서 설치한 Paseo라 앱의 자동 업데이트에 맡깁니다'
    rm -f "$STATE/latest"
    [[ "$DRY_RUN" == 1 ]] || touch "$STATE/checked"
    return 0
  fi
  [[ "$DRY_RUN" == 1 ]] || brew update --quiet >/dev/null 2>&1 || warn 'brew update 실패. 받아 둔 목록으로 확인합니다'
  json="$(brew info --cask --json=v2 paseo 2>/dev/null)" && version="$(plutil -extract casks.0.version raw -o - - <<<"$json" 2>/dev/null)"
  if [[ -z "${version:-}" ]]; then
    warn 'Homebrew에서 Paseo 최신 버전을 읽지 못했습니다'
    return 1
  fi
  json="$(curl -fsS --max-time 20 "https://api.github.com/repos/getpaseo/paseo/releases/tags/v$version" 2>/dev/null)" &&
    published="$(plutil -extract published_at raw -o - - <<<"$json" 2>/dev/null)" &&
    epoch="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$published" +%s 2>/dev/null)"
  if [[ -z "${epoch:-}" ]]; then
    warn "Paseo $version 릴리스 공개 시각을 받지 못했습니다 (GitHub)"
    return 1
  fi
  [[ "$DRY_RUN" == 1 ]] && { LATEST="$version $epoch"; return 0; }
  printf '%s %s\n' "$version" "$epoch" >"$STATE/latest"
  touch "$STATE/checked"
}

# 자동 시작 등록(launch-agents.mjs의 paseo)으로 데몬을 띄운다. 등록이 없으면 CLI로 띄운다.
start_daemon() {
  if launchctl print "gui/$(id -u)/$DAEMON_LABEL" >/dev/null 2>&1; then
    launchctl kickstart "gui/$(id -u)/$DAEMON_LABEL"
  else
    # 데몬이 이 실행의 환경을 물려받지 않게 한다 (65-paseo.sh와 같은 이유).
    env -u BOOTSTRAP_UNATTENDED -u BOOTSTRAP_LOCKED -u BOOTSTRAP_RESULTS "$PASEO_CLI" daemon start </dev/null
  fi
}

# 데몬이 원하는 버전으로 응답할 때까지 기다린다: wait_daemon <버전>
wait_daemon() {
  local i json
  for ((i = 0; i < DAEMON_WAIT; i++)); do
    json="$("$PASEO_CLI" daemon status --json 2>/dev/null)"
    [[ "$(daemon_field "$json" daemonVersion)" == "$1" ]] && return 0
    sleep 1
  done
  return 1
}

main() {
  set -uo pipefail
  # shellcheck source=scripts/lib.sh
  source "$BOOTSTRAP_ROOT/scripts/lib.sh"
  AUTO=0
  FORCE=0
  HEADER_DONE=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --auto) AUTO=1 ;;
      --force) FORCE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help) usage; return 0 ;;
      *) usage; die "알 수 없는 인자: $arg" ;;
    esac
  done
  export DRY_RUN
  STATE="$BOOTSTRAP_STATE/paseo-upgrade"
  PASEO_APP="${BOOTSTRAP_PASEO_APP:-/Applications/Paseo.app}"
  PASEO_CLI="$PASEO_APP/Contents/Resources/bin/paseo"
  DAEMON_WAIT="${BOOTSTRAP_PASEO_DAEMON_WAIT:-180}"
  LATEST=''
  mkdir -p "$STATE"

  if is_laptop; then
    quiet '노트북은 Paseo 앱이 스스로 업데이트합니다'
    return 0
  fi
  local installed
  if ! installed="$(app_version)"; then
    warn "Paseo 앱 없음 ($PASEO_APP)"
    [[ "$AUTO" == 1 ]] && return 0
    return 1
  fi
  # 데몬을 멈추면 그 데몬이 띄운 에이전트와 그 안에서 실행한 이 명령도 끝난다.
  if [[ -n "${PASEO_AGENT_ID:-}" && "$DRY_RUN" != 1 ]]; then
    fail "Paseo 에이전트 안에서는 실행하지 않습니다(데몬과 함께 끝남) → 터미널에서 실행하거나 launchctl kickstart gui/$(id -u)/local.bootstrap.paseo-upgrade"
    return 1
  fi
  if [[ "$DRY_RUN" != 1 ]] && ! lock_acquire; then
    # 설치·자동 갱신이 실행 중이면 다음 주기에 다시 본다.
    [[ "$AUTO" == 1 ]] && return 0
    info '다른 설치·갱신이 실행 중입니다. 끝나기를 기다립니다 (중단: Ctrl-C)'
    until lock_acquire; do sleep 5; done
  fi

  # 하루에 한 번(또는 --force) 최신 버전을 확인한다. 실패하면 지난 기록으로 진행하고 다음 주기에 다시 확인한다.
  if [[ "$FORCE" == 1 || ! -e "$STATE/checked" || -n "$(find "$STATE/checked" -mmin +$((CHECK_HOURS * 60 - 30)) 2>/dev/null)" ]]; then
    check_latest || true
  fi
  local latest='' published=0 now
  read -r latest published <<<"${LATEST:-$(cat "$STATE/latest" 2>/dev/null)}"
  now="$(date +%s)"

  local want_app=0 wait_msg=''
  if [[ -n "$latest" ]] && version_lt "$installed" "$latest"; then
    if [[ "$FORCE" == 1 ]] || ((now - published >= ROLLOUT_HOURS * 3600)); then
      want_app=1
    else
      wait_msg="Paseo $latest: 공개 뒤 ${ROLLOUT_HOURS}시간이 지나면 올립니다 (약 $(((published + ROLLOUT_HOURS * 3600 - now + 3599) / 3600))시간 남음)"
    fi
  fi
  if [[ "$want_app" == 1 ]] && pgrep -f "^$PASEO_APP/Contents/MacOS/" >/dev/null 2>&1; then
    # 앱 화면이 켜져 있으면 앱이 스스로 업데이트한다. brew는 켜진 앱을 끄므로 맡긴다. 데몬은 아래에서 맞춘다.
    want_app=0
    wait_msg="Paseo $latest: 앱이 켜져 있어 앱의 자동 업데이트에 맡깁니다"
  fi

  local status_json daemon_running=0 daemon_version='' want_restart=0
  status_json="$("$PASEO_CLI" daemon status --json 2>/dev/null)"
  if [[ "$(daemon_field "$status_json" localDaemon)" == running ]]; then
    daemon_running=1
    daemon_version="$(daemon_field "$status_json" daemonVersion)"
    # 앱이 관리하는 데몬은 앱이 다시 시작한다.
    if [[ "$want_app" == 0 && -n "$daemon_version" && "$daemon_version" != "$installed" &&
      "$(daemon_field "$status_json" desktopManaged)" != true ]]; then
      want_restart=1
    fi
  fi

  if [[ "$want_app" == 0 && "$want_restart" == 0 ]]; then
    rm -f "$STATE/blocked"
    write_status ok ''
    if [[ -n "$wait_msg" ]]; then quiet "$wait_msg"; else quiet "Paseo 최신 ($installed)"; fi
    return 0
  fi

  local target="$installed" what
  [[ "$want_app" == 1 ]] && target="$latest"
  if [[ "$want_app" == 1 ]]; then what="Paseo $installed → $latest"; else what="Paseo 데몬 $daemon_version → $installed"; fi

  # 실행 중인 에이전트가 있으면 다음 주기에 다시 본다. 목록을 읽지 못하면 바쁜 것으로 본다.
  local running=0 list
  if [[ "$daemon_running" == 1 && "$FORCE" != 1 ]]; then
    if list="$("$PASEO_CLI" ls -g -a --json 2>/dev/null)"; then
      running="$(grep -o '"status": *"running"' <<<"$list" | wc -l | tr -d ' ')"
    else
      running='?'
    fi
  fi
  if [[ "$running" != 0 ]]; then
    local since
    if [[ ! -f "$STATE/blocked" && "$DRY_RUN" != 1 ]]; then
      printf '%s\n' "$now" >"$STATE/blocked"
      say "$what: 실행 중인 에이전트(${running}개)가 끝나면 올립니다"
    fi
    since="$(cat "$STATE/blocked" 2>/dev/null || echo "$now")"
    quiet "$what: 실행 중인 에이전트 ${running}개. 끝나면 다시 봅니다 (지금 올리기: ./bootstrap.sh paseo-upgrade --force)"
    if ((now - since >= BLOCKED_HOURS * 3600)); then
      local banner="$what 대기: 실행 중인 에이전트가 ${BLOCKED_HOURS}시간 넘게 이어짐 → 한가할 때 ./bootstrap.sh paseo-upgrade --force"
      write_status pending "$banner"
      notify "blocked|$target" 'Paseo 업그레이드 대기' "$banner" push
    fi
    [[ "$AUTO" == 1 ]] && return 0
    return 2
  fi

  if [[ "$DRY_RUN" == 1 ]]; then
    if [[ "$want_app" == 1 ]]; then info "[dry-run] $what: brew upgrade --cask paseo 후 데몬 시작"; else info "[dry-run] $what: 데몬 멈춘 뒤 시작"; fi
    return 0
  fi

  say "$what"
  rm -f "$STATE/blocked"
  local st=0
  if [[ "$want_app" == 1 ]]; then
    # cask 제거 단계가 데몬을 멈추고(paseo daemon stop --force) 앱을 끈다.
    brew upgrade --cask paseo || st=$?
    installed="$(app_version)"
    [[ "$st" == 0 && "$installed" != "$latest" ]] && st=1
  else
    "$PASEO_CLI" daemon stop || st=$?
  fi
  if [[ "$daemon_running" == 1 ]]; then
    # 실패해도 데몬은 다시 띄운다. 이미 떠 있으면 아무것도 하지 않는다.
    if ! "$PASEO_CLI" daemon status --json 2>/dev/null | grep -q '"localDaemon": *"running"'; then
      start_daemon || warn 'Paseo 데몬 시작 실패'
    fi
    if ! wait_daemon "$installed"; then
      warn "Paseo 데몬이 $installed로 응답하지 않습니다 (paseo daemon status)"
      st=1
    fi
  fi

  if [[ "$st" != 0 ]]; then
    local banner="$what 실패 → ./bootstrap.sh paseo-upgrade (기록: $(pretty "$STATE")/upgrade.log)"
    write_status failed "$banner"
    notify "failed|$target" 'Paseo 업그레이드 실패' "$banner" push
    fail "$banner"
    return 1
  fi
  write_status ok ''
  notify "ok|$target" 'Paseo 업그레이드됨' "$what"
  ok "$what"
}

# 같은 줄의 exit: brew upgrade 중 이 파일이 바뀌어도 나머지를 읽지 않는다.
main "$@"; exit $?
