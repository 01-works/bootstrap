#!/usr/bin/env bash
# 새 Mac 세팅 진입점. 처음이면 README.md의 "새 Mac에서" 순서를 먼저 볼 것.
set -euo pipefail

BOOTSTRAP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BOOTSTRAP_ROOT
# shellcheck source=scripts/lib.sh
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

[[ "$(id -u)" != 0 ]] || die "sudo 없이 실행하세요. 관리자 권한이 필요한 곳에서만 따로 묻습니다"

usage() {
  cat <<'EOF'
사용법:
  ./bootstrap.sh [--only 단계,단계] [--dry-run] [--yes]
  ./bootstrap.sh doctor      설치 상태 검증
  ./bootstrap.sh snapshot    이 Mac에는 있는데 저장소에 없는 것 찾기
  ./bootstrap.sh --list      단계 목록

옵션:
  --only      지정한 단계만 실행 (예: --only dotfiles,agents)
  --dry-run   아무것도 바꾸지 않고 할 일만 출력
  --yes       확인 질문에 모두 예
EOF
}

all_steps() {
  local f
  for f in "$BOOTSTRAP_ROOT"/scripts/steps/*.sh; do
    f="$(basename "$f" .sh)"
    printf '%s ' "${f#*-}"
  done
}

step_file() {
  local f
  for f in "$BOOTSTRAP_ROOT"/scripts/steps/*-"$1".sh; do
    [[ -f "$f" ]] && printf '%s' "$f" && return 0
  done
  return 1
}

cmd=install
only=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    doctor | snapshot) cmd="$1" ;;
    --list) cmd=list ;;
    --only)
      [[ -n "${2:-}" ]] || { usage; die "--only 다음에 값이 필요합니다"; }
      only="$2"
      shift ;;
    --only=*)
      [[ -n "${1#*=}" ]] || { usage; die "--only 다음에 값이 필요합니다"; }
      only="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "알 수 없는 인자: $1" ;;
  esac
  shift
done
export DRY_RUN ASSUME_YES

if [[ "$cmd" == list ]]; then
  printf '단계 (실행 순서): %s\n' "$(all_steps)"
  exit 0
fi

case "$cmd" in
  doctor) exec bash "$BOOTSTRAP_ROOT/scripts/doctor.sh" ;;
  snapshot) exec bash "$BOOTSTRAP_ROOT/scripts/snapshot.sh" ;;
esac

# 실행할 단계: --only가 있으면 그것만, 없으면 전부. 순서는 항상 scripts/steps/의 번호 순.
selected="$(all_steps)"
if [[ -n "$only" ]]; then
  selected="${only//,/ }"
  [[ -n "${selected// /}" ]] || die "--only에 단계 이름이 없습니다"
  for name in $selected; do
    step_file "$name" >/dev/null || die "없는 단계: $name (가능: $(all_steps))"
  done
fi

printf '%s단계:%s %s' "$_bold" "$_reset" "$selected"
[[ "$DRY_RUN" == 1 ]] && printf '   %s(dry-run)%s' "$_yellow" "$_reset"
printf '\n'

# preflight·xcode·homebrew는 뒤 단계가 모두 기대므로 실패하면 멈춘다. 나머지는 실패를 모아 두고 계속한다.
failed=''
for name in $(all_steps); do
  contains "$name" $selected || continue
  step "$name"
  bash "$(step_file "$name")" && continue
  if contains "$name" preflight xcode homebrew; then
    fail "'$name' 단계에서 멈췄습니다. 뒤 단계가 이 단계에 기댑니다. 고친 뒤: ./bootstrap.sh --only $name"
    exit 1
  fi
  fail "'$name' 단계 실패. 나머지 단계는 계속합니다"
  failed="$failed $name"
done

if [[ -z "$only" && "$DRY_RUN" != 1 ]]; then
  step "doctor"
  bash "$BOOTSTRAP_ROOT/scripts/doctor.sh" || true
  printf '\n새 터미널을 열어야 셸 설정이 적용됩니다.\n'
fi

if [[ -n "$failed" ]]; then
  failed="${failed# }"
  fail "실패한 단계: $failed → 원인을 고친 뒤: ./bootstrap.sh --only ${failed// /,}"
  exit 1
fi
