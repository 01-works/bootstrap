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

# 기본 SSH 키: 0 개인키 있음, 1 없음, 2 공개키만 있거나 불완전한 파일.
ssh_key_state() {
  local key="$1"
  [[ -f "$key" && -s "$key" ]] && return 0
  [[ -e "$key" || -L "$key" || -e "$key.pub" || -L "$key.pub" ]] && return 2
  return 1
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

# 전원 설정이 맞는지. 노트북은 충전 중에만 잠자기 안 함, 데스크톱은 늘 켜두기(잠자기 끔, 화면은 DISPLAY_SLEEP_MINUTES 뒤 끔, 네트워크로 깨우기 켬).
power_ok() {
  if is_laptop; then
    [[ "$(pmset -g custom | awk '/^AC Power:/ {ac = 1; next} /^[^ ]/ {ac = 0} ac && $1 == "sleep" {print $2; exit}')" == 0 ]]
    return
  fi
  local s
  s="$(pmset -g custom | awk '$1 == "sleep" || $1 == "displaysleep" || $1 == "womp" {print $1 "=" $2}' | sort -u | paste -sd ' ' -)"
  [[ "$s" == "displaysleep=$DISPLAY_SLEEP_MINUTES sleep=0 womp=1" ]]
}

# 비대화형 bash에서도 로그인 셸과 같은 도구를 찾을 수 있게 PATH를 맞춘다 (home/zsh/.zprofile과 같은 순서).
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
export PNPM_HOME="$HOME/Library/pnpm"  # .zshrc와 같은 값. pnpm 전역 설치에 필요
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$HOME/Library/pnpm/bin:$PATH"
