#!/usr/bin/env bash
# 모든 단계가 source 하는 공통 함수.
# 새 Mac에는 bash 3.2만 있으므로 연관 배열, mapfile, ${var,,} 같은 bash 4 문법은 쓰지 않는다.

BOOTSTRAP_ROOT="${BOOTSTRAP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BOOTSTRAP_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/bootstrap"
DRY_RUN="${DRY_RUN:-0}"
ASSUME_YES="${ASSUME_YES:-0}"

if [[ -t 1 ]]; then
  _bold=$'\033[1m' _dim=$'\033[2m' _red=$'\033[31m' _green=$'\033[32m' _yellow=$'\033[33m' _blue=$'\033[34m' _reset=$'\033[0m'
else
  _bold='' _dim='' _red='' _green='' _yellow='' _blue='' _reset=''
fi

step() { printf '\n%s==> %s%s\n' "$_bold$_blue" "$*" "$_reset"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$_green" "$_reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$_yellow" "$_reset" "$*" >&2; }
fail() { printf '  %s✗%s %s\n' "$_red" "$_reset" "$*" >&2; }
die()  { fail "$*"; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

# 실행 파일의 존재와 실제 기동 성공을 구분한다. 설치 단계와 doctor에서 함께 사용.
cli_works() { "$1" --version >/dev/null 2>&1; }

# Intel용 uv 공식 바이너리. 이미 있는 CLI와 다른 설치의 uv/uvx 경로는 덮어쓰지 않는다.
# 설치 경로를 인자로 받아 테스트에서도 실제 홈을 바꾸지 않는다.
ensure_standalone_uv() {
  local install_dir="$1" entry installer
  if has uv; then
    if ! cli_works uv; then
      fail "기존 uv 실행 실패. 설치를 유지합니다: $(command -v uv)"
      return 1
    fi
    ok "$(uv --version)"
    return 0
  fi
  for entry in uv uvx; do
    if [[ -e "$install_dir/$entry" || -L "$install_dir/$entry" ]]; then
      fail "기존 uv 설치 경로 충돌. 파일을 유지합니다: $install_dir/$entry"
      return 1
    fi
  done
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] Intel: uv 공식 바이너리를 $install_dir 에 설치 (셸 설정 유지)"
    return 0
  fi
  installer="$(curl -fsSL https://astral.sh/uv/install.sh)" || {
    fail 'uv 공식 설치기를 받지 못했습니다'
    return 1
  }
  if ! printf '%s\n' "$installer" | UV_INSTALL_DIR="$install_dir" UV_NO_MODIFY_PATH=1 sh; then
    fail 'uv 공식 바이너리 설치 실패'
    return 1
  fi
  if [[ ! -x "$install_dir/uv" ]] || ! "$install_dir/uv" --version; then
    fail 'uv 설치 후 실행 실패'
    return 1
  fi
  ok 'uv 공식 바이너리 설치됨 (셸 설정 유지)'
}

# $HOME을 ~로 줄여서 보여준다.
pretty() {
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# 시스템을 바꾸는 명령은 모두 run으로 감싼다. --dry-run이면 출력만 한다.
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '    %s[dry-run]%s %s\n' "$_dim" "$_reset" "$*"
    return 0
  fi
  "$@"
}

# y/N 질문. --yes나 --dry-run이면 예, 터미널이 아니면 아니오.
confirm() {
  if [[ "$ASSUME_YES" == 1 || "$DRY_RUN" == 1 ]]; then
    info "$1 → 예"
    return 0
  fi
  [[ -t 0 ]] || return 1
  local reply
  read -r -p "    $1 [y/N] " reply
  [[ "$reply" == y || "$reply" == Y ]]
}

# 자동 갱신(./bootstrap.sh update --auto, LaunchAgent)으로 실행 중인지.
# 이때는 비밀번호·설치 창·로그인처럼 사람을 기다리는 일을 하지 않고 수동 작업 대기(2)로 남긴다.
unattended() { [[ "${BOOTSTRAP_UNATTENDED:-0}" == 1 ]]; }

# 사람이 필요한 일 앞에서 부른다. 무인 실행이면 알리고 참을 반환한다:
#   if needs_person '전원 설정 (관리자 비밀번호)'; then exit 2; fi
needs_person() {
  unattended || return 1
  warn "$1: 자동 갱신에서는 하지 않습니다 → 터미널에서 ./bootstrap.sh update"
}

# 자동 갱신 중에는 실행 중인 LaunchAgent를 다시 올리지 않는다 (launch-agents.mjs --no-restart). 인자로 따옴표 없이 쓴다.
no_restart_flag() { if unattended; then printf '%s' --no-restart; fi; }

# 자동 갱신 상태 (scripts/update.sh). applied는 이 기기에 마지막으로 적용한 커밋.
BOOTSTRAP_UPDATE_STATE="$BOOTSTRAP_STATE/update"

# 이 기기에 저장소의 커밋까지 적용했다고 기록한다 (전체 설치·갱신 성공): mark_applied [실행을 시작한 커밋]
# 실행 중에 이 기기로 커밋·pull이 들어와도 그 커밋의 단계를 건너뛰지 않게 시작한 커밋을 넘긴다. 없으면 지금 HEAD.
mark_applied() {
  local head="${1:-}"
  [[ -n "$head" ]] || head="$(git -C "$BOOTSTRAP_ROOT" rev-parse HEAD 2>/dev/null)" || return 0
  mkdir -p "$BOOTSTRAP_UPDATE_STATE" && printf '%s\n' "$head" >"$BOOTSTRAP_UPDATE_STATE/applied"
}

# 설치와 자동 갱신이 동시에 돌지 않게 잡는 잠금. 얻으면 0, 다른 실행이 잡고 있으면 1. 끝날 때(EXIT) 푼다.
# BOOTSTRAP_LOCKED는 잠금을 잡은 프로세스 번호다. 하위 실행(update.sh → bootstrap.sh)과 exec로 바뀐 자신은
# 그 번호가 잠금의 pid와 같을 때만 이어서 쓴다. 끝난 실행의 환경 변수가 남아 있어도 잠금을 건너뛰지 않는다.
BOOTSTRAP_LOCK="$BOOTSTRAP_STATE/lock"
lock_acquire() {
  local dir="$BOOTSTRAP_LOCK" pid boot
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  if [[ -n "${BOOTSTRAP_LOCKED:-}" && "$pid" == "$BOOTSTRAP_LOCKED" ]]; then
    [[ "$pid" == "$$" ]] && trap 'rm -rf "$BOOTSTRAP_LOCK"' EXIT  # exec 뒤에는 trap이 사라진다
    return 0
  fi
  mkdir -p "$BOOTSTRAP_STATE"
  if ! mkdir "$dir" 2>/dev/null; then
    # 재시동 전에 잡힌 잠금은 버린다(정전 등). pid가 지금 다른 프로세스에 쓰였을 수 있다.
    boot="$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/^\{ sec = ([0-9]+).*/\1/')"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && ! [[ "$boot" =~ ^[0-9]+$ && "$(stat -f %m "$dir" 2>/dev/null || echo 0)" -lt "$boot" ]]; then
      return 1
    fi
    # pid를 쓰기 직전일 수 있으므로 pid 없는 잠금은 1분이 지나야 버린다.
    if [[ -z "$pid" && -z "$(find "$dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]]; then return 1; fi
    # 옮기기에 성공한 쪽만 버린다. 두 실행이 함께 버리려다 서로의 새 잠금을 지우지 않게 한다.
    mv "$dir" "$dir.stale.$$" 2>/dev/null || return 1
    rm -rf "$dir.stale.$$"
    mkdir "$dir" 2>/dev/null || return 1
  fi
  printf '%s\n' "$$" >"$dir/pid"
  trap 'rm -rf "$BOOTSTRAP_LOCK"' EXIT
  export BOOTSTRAP_LOCKED="$$"
}

# macOS 알림을 띄우고, push면 휴대폰 알림(선택)도 보낸다: send_notification <제목> <내용> [push]
# 휴대폰 알림은 주소 한 줄(예: ntfy 주제 주소)을 둔 기기만 보낸다. 저장소에는 넣지 않는다 (README "변경 전파").
send_notification() {
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' \
    "$1" "$2" >/dev/null 2>&1 || warn 'macOS 알림을 띄우지 못했습니다'
  [[ "${3:-}" == push ]] || return 0
  local file="${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/notify-url" url
  [[ -f "$file" ]] || return 0
  url="$(head -1 "$file")"
  if [[ "$url" != https://* ]]; then
    warn "휴대폰 알림 주소는 https://로 시작해야 합니다: $(pretty "$file")"
    return 0
  fi
  curl -fsS --max-time 10 -H 'Tags: warning' \
    --data-binary "$(scutil --get ComputerName 2>/dev/null || hostname): $1
$2" "$url" >/dev/null || warn '휴대폰 알림을 보내지 못했습니다'
}

# 공백으로 구분된 목록에 값이 있는지 확인한다: contains <값> <목록...>
contains() {
  local needle="$1"
  shift
  case " $* " in
    *" $needle "*) return 0 ;;
  esac
  return 1
}

# fnm 기본 Node 주 버전. runtimes 단계와 doctor가 쓴다.
NODE_VERSION=24

# 배터리가 있으면 노트북으로 본다. power 단계와 doctor가 쓴다.
is_laptop() {
  [[ "$(pmset -g batt)" == *InternalBattery* ]]
}

# 자동 시작 스크립트(launch-agents.mjs)에 넘길 기기 종류. 노트북은 필요할 때, 늘 켜두는 기기는 로그인할 때 시작한다.
device_flag() {
  if is_laptop; then printf '%s' --laptop; else printf '%s' --desktop; fi
}

# 데스크톱이 가만히 있을 때 화면을 끄는 시간(분). 컴퓨터는 계속 깨어 있다. 화면 보호기는 쓰지 않는다 (macos 단계).
DISPLAY_SLEEP_MINUTES=10

# 전원 설정이 맞는지. 노트북은 충전 중에만 잠자기 안 함, 데스크톱은 늘 켜두기
# (잠자기 끔, 화면은 DISPLAY_SLEEP_MINUTES 뒤 끔, 네트워크로 깨우기 켬, 정전 후 전원이 돌아오면 자동으로 켜기).
power_ok() {
  if is_laptop; then
    [[ "$(pmset -g custom | awk '/^AC Power:/ {ac = 1; next} /^[^ ]/ {ac = 0} ac && $1 == "sleep" {print $2; exit}')" == 0 ]]
    return
  fi
  local s
  s="$(pmset -g custom | awk '$1 == "sleep" || $1 == "displaysleep" || $1 == "womp" || $1 == "autorestart" {print $1 "=" $2}' | sort -u | paste -sd ' ' -)"
  [[ "$s" == "autorestart=1 displaysleep=$DISPLAY_SLEEP_MINUTES sleep=0 womp=1" ]]
}

# FileVault가 완전히 꺼져 있는지 (복호화 중이면 아니다).
filevault_off() {
  [[ "$(fdesetup status 2>/dev/null)" == 'FileVault is Off.' ]]
}

# 자동 로그인이 이 계정으로 켜져 있는지.
autologin_on() {
  [[ "$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" == "$(id -un)" ]]
}

# 원격 로그인(com.openssh.sshd)·화면 공유(com.apple.screensharing)가 켜져 있는지. 켜기는 시스템 설정 > 일반 > 공유에서 손으로.
sharing_enabled() {
  launchctl print-disabled system 2>/dev/null | grep -q "\"$1\" => enabled"
}

# Tailscale 앱(Standalone)에 든 명령어. PATH에 설치하지 않고 검사에만 쓴다 (TOOLS.md).
TAILSCALE_APP_CLI="${TAILSCALE_APP_CLI:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"

# Tailscale 상태를 "<연결 상태> <키 만료 시각>" 한 줄로 출력한다. 연결 상태는 Running·Stopped·NeedsLogin 등이고,
# 앱이 꺼져 있거나 없으면 아무것도 출력하지 않는다. 만료 시각이 없으면(관리 콘솔에서 키 만료를 껐거나 로그인 전) -.
tailscale_status() {
  local json state
  json="$("$TAILSCALE_APP_CLI" status --json 2>/dev/null)"
  state="$(plutil -extract BackendState raw -o - - <<<"$json" 2>/dev/null)" || return 0
  printf '%s %s\n' "$state" "$(plutil -extract Self.KeyExpiry raw -o - - <<<"$json" 2>/dev/null || echo -)"
}

# Tailscale 앱 설정의 "로그인 시 실행". 공개되지 않은 앱 내부 설정값이라 앱이 바뀌면 틀릴 수 있다.
tailscale_starts_on_login() {
  [[ "$(defaults read io.tailscale.ipn.macsys TailscaleStartOnLogin 2>/dev/null)" == 1 ]]
}

# CPU에 맞는 Homebrew 기본 경로. Intel은 /usr/local, Apple Silicon은 /opt/homebrew. 테스트는 대역 경로를 준다.
if [[ -z "${BOOTSTRAP_BREW_PREFIX:-}" ]]; then
  case "$(uname -m)" in
    x86_64) BOOTSTRAP_BREW_PREFIX=/usr/local ;;
    *) BOOTSTRAP_BREW_PREFIX=/opt/homebrew ;;
  esac
fi

# 비대화형 bash에서도 로그인 셸과 같은 도구를 찾을 수 있게 PATH를 맞춘다 (home/zsh/.zprofile과 같은 순서).
if [[ -x "$BOOTSTRAP_BREW_PREFIX/bin/brew" ]]; then
  eval "$("$BOOTSTRAP_BREW_PREFIX/bin/brew" shellenv)"
fi
export PNPM_HOME="$HOME/Library/pnpm"  # .zshrc와 같은 값. pnpm 전역 설치에 필요
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$HOME/Library/pnpm/bin:$PATH"
if ! has fnm && [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
fi
