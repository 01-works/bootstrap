#!/usr/bin/env bash
# 새 Mac 세팅 진입점. 처음이면 README.md의 "새 Mac에서" 순서를 먼저 볼 것.
set -euo pipefail

BOOTSTRAP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BOOTSTRAP_ROOT
# shellcheck source=scripts/lib.sh
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

usage() {
  cat <<'EOF'
사용법:
  ./bootstrap.sh --profile <main|minimal> [--only 단계,단계] [--dry-run] [--yes]
  ./bootstrap.sh doctor      설치 상태 검증
  ./bootstrap.sh snapshot    이 Mac에는 있는데 저장소에 없는 것 찾기
  ./bootstrap.sh --list      프로필별 단계 보기

옵션:
  --profile   profiles/<이름>.sh를 쓴다. 한 번 실행하면 기억하므로 다음부터는 생략 가능
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
profile=''
only=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    doctor | snapshot) cmd="$1" ;;
    --list) cmd=list ;;
    --profile) profile="${2:-}"; shift ;;
    --profile=*) profile="${1#*=}" ;;
    --only) only="${2:-}"; shift ;;
    --only=*) only="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "알 수 없는 인자: $1" ;;
  esac
  shift
done
export DRY_RUN ASSUME_YES

if [[ "$cmd" == list ]]; then
  for f in "$BOOTSTRAP_ROOT"/profiles/*.sh; do
    load_profile "$(basename "$f" .sh)"
    printf '%-8s %s\n' "$PROFILE" "$STEPS"
  done
  printf '\n전체 단계 (실행 순서): %s\n' "$(all_steps)"
  exit 0
fi

[[ -n "$profile" ]] || profile="$(saved_profile)"
[[ -n "$profile" ]] || { usage; die "--profile을 지정하세요 (처음 한 번만)"; }
load_profile "$profile"
export PROFILE

case "$cmd" in
  doctor) exec bash "$BOOTSTRAP_ROOT/scripts/doctor.sh" ;;
  snapshot) exec bash "$BOOTSTRAP_ROOT/scripts/snapshot.sh" ;;
esac

# 실행할 단계: --only가 있으면 그것만, 없으면 프로필의 STEPS. 순서는 항상 scripts/steps/의 번호 순.
selected="$STEPS"
if [[ -n "$only" ]]; then
  selected="${only//,/ }"
  for name in $selected; do
    step_file "$name" >/dev/null || die "없는 단계: $name (가능: $(all_steps))"
  done
fi

printf '%s프로필: %s%s   단계: %s' "$_bold" "$PROFILE" "$_reset" "$selected"
[[ "$DRY_RUN" == 1 ]] && printf '   %s(dry-run)%s' "$_yellow" "$_reset"
printf '\n'

if [[ "$DRY_RUN" != 1 ]]; then
  mkdir -p "$BOOTSTRAP_STATE"
  printf '%s\n' "$PROFILE" >"$BOOTSTRAP_STATE/profile"
fi

for name in $(all_steps); do
  contains "$name" $selected || continue
  step "$name"
  if ! bash "$(step_file "$name")"; then
    fail "'$name' 단계에서 멈췄습니다. 원인을 고친 뒤: ./bootstrap.sh --only $name"
    exit 1
  fi
done

if [[ -z "$only" && "$DRY_RUN" != 1 ]]; then
  step "doctor"
  bash "$BOOTSTRAP_ROOT/scripts/doctor.sh" || true
  printf '\n새 터미널을 열어야 셸 설정이 적용됩니다.\n'
fi
