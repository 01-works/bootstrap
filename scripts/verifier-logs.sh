#!/bin/bash
# verifier 기기의 읽기 전용 SSH 강제 명령. role.sh가 ~/.local/bin/verifier-logs로 설치하고 authorized_keys의 command=로 건다.
# 접속한 쪽이 요청한 명령($SSH_ORIGINAL_COMMAND)은 실행하지 않고, 로그 디렉터리(~/.local/state/verifier/logs)의 파일만 보여 준다.
#   ls                     로그 디렉터리 목록 (하위 디렉터리 포함)
#   tail [-n N] <파일>     끝에서 N줄 (기본 10, 최대 10000)
#   cat <파일>             전체
# 파일은 로그 디렉터리 기준 상대 경로다. 영문·숫자·._/- 만 쓰고 ..와 절대 경로는 안 된다. 심볼릭 링크·하드링크는 거부한다.
# 그 밖의 요청은 종료 코드 2로 거부한다.
set -uo pipefail
export LC_ALL=C

LOG_DIR="$HOME/.local/state/verifier/logs"
MAX_LINES=10000

reject() {
  printf 'verifier-logs: 거부: %s\n' "$1" >&2
  printf '허용: ls | tail [-n N] <파일> | cat <파일> (N은 %d 이하, 파일은 로그 디렉터리 기준 상대 경로)\n' "$MAX_LINES" >&2
  exit 2
}

# 로그 디렉터리 안의 일반 파일이면 실제 경로를 출력한다.
resolve() {
  local rel="$1" root dir base
  [[ "$rel" =~ ^[A-Za-z0-9._/-]+$ ]] || reject "경로에 쓸 수 없는 문자: $rel"
  [[ "$rel" != /* ]] || reject "절대 경로: $rel"
  [[ "$rel" != *..* ]] || reject "..가 든 경로: $rel"
  root="$(cd "$LOG_DIR" 2>/dev/null && pwd -P)" || { printf 'verifier-logs: 로그 디렉터리 없음\n' >&2; exit 1; }
  # dirname·basename은 -로 시작하는 이름을 옵션으로 읽으므로 쓰지 않는다.
  case "$rel" in */*) dir="${rel%/*}" ;; *) dir=. ;; esac
  base="${rel##*/}"
  dir="$(cd "$root/$dir" 2>/dev/null && pwd -P)" || reject "없는 경로: $rel"
  [[ "$dir" == "$root" || "$dir" == "$root"/* ]] || reject "로그 디렉터리 밖: $rel"
  [[ ! -L "$dir/$base" ]] || reject "링크: $rel"
  [[ -f "$dir/$base" ]] || reject "일반 파일이 아님: $rel"
  # 하드링크는 로그 디렉터리 밖의 파일과 같은 내용일 수 있다.
  [[ "$(stat -f %l "$dir/$base" 2>/dev/null)" == 1 ]] || reject "링크 수가 1이 아닌 파일: $rel"
  printf '%s/%s' "$dir" "$base"
}

set -f
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
case "${1:-}" in
  ls)
    [[ $# == 1 ]] || reject 'ls는 인자를 받지 않습니다'
    cd "$LOG_DIR" 2>/dev/null || { printf 'verifier-logs: 로그 디렉터리 없음\n' >&2; exit 1; }
    exec /bin/ls -lAR
    ;;
  cat)
    [[ $# == 2 ]] || reject 'cat <파일>'
    file="$(resolve "$2")" || exit $?
    exec /bin/cat -- "$file"
    ;;
  tail)
    lines=10
    if [[ "${2:-}" == -n ]]; then
      [[ $# == 4 ]] || reject 'tail [-n N] <파일>'
      [[ "$3" =~ ^[0-9]{1,5}$ ]] && ((10#$3 <= MAX_LINES)) || reject "줄 수는 0~$MAX_LINES: $3"
      lines=$((10#$3))
      shift 2
    fi
    [[ $# == 2 ]] || reject 'tail [-n N] <파일>'
    file="$(resolve "$2")" || exit $?
    exec /usr/bin/tail -n "$lines" -- "$file"
    ;;
  '') reject '명령 없음 (대화형 접속은 쓸 수 없습니다)' ;;
  *) reject "알 수 없는 명령: $1" ;;
esac
