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

# 프로필(profiles/<이름>.sh)을 읽어 STEPS, BREWFILES, DOTFILES를 채운다.
load_profile() {
  local file="$BOOTSTRAP_ROOT/profiles/$1.sh"
  [[ -f "$file" ]] || die "프로필이 없습니다: $1 ($(ls "$BOOTSTRAP_ROOT/profiles" | sed 's/\.sh$//' | tr '\n' ' '))"
  STEPS='' BREWFILES='' DOTFILES=''
  # shellcheck source=/dev/null
  source "$file"
  PROFILE="$1"
}

saved_profile() { cat "$BOOTSTRAP_STATE/profile" 2>/dev/null || true; }

# fnm 기본 Node 주 버전. runtimes 단계와 doctor가 쓴다.
NODE_VERSION=24

# 늘 켜두는 기기의 전원 설정(잠자기·화면 잠자기 끔, 네트워크로 깨우기 켬)이 맞는지. power 단계와 doctor가 쓴다.
power_ok() {
  local s
  s="$(pmset -g custom | awk '$1 == "sleep" || $1 == "displaysleep" || $1 == "womp" {print $1 "=" $2}' | sort -u | paste -sd ' ' -)"
  [[ "$s" == "displaysleep=0 sleep=0 womp=1" ]]
}

# 비대화형 bash에서도 로그인 셸과 같은 도구를 찾을 수 있게 PATH를 맞춘다 (home/zsh/.zprofile과 같은 순서).
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"

# 단계 스크립트는 bootstrap.sh가 넘겨준 프로필을 바로 쓸 수 있게 한다.
if [[ -n "${PROFILE:-}" ]]; then
  load_profile "$PROFILE"
fi
