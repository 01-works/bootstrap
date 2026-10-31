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
  ./bootstrap.sh update [--auto] [--dry-run]
                             저장소를 받아 바뀐 부분만 적용 (자동 갱신이 10분마다 --auto로 실행)
  ./bootstrap.sh paseo-upgrade [--force] [--dry-run]
                             Paseo를 정식 최신 버전으로 (데스크톱은 한 시간마다 --auto로 실행)
  ./bootstrap.sh role add|status|remove verifier [...]
                             기기 역할 켜기·확인·끄기 (README "기기 역할", 자세히: ./bootstrap.sh role --help)
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

# 갱신, Paseo 업그레이드, 기기 역할은 자기 인자를 따로 받는다 (scripts/update.sh, scripts/paseo-upgrade.sh, scripts/role.sh).
case "${1:-}" in
  update | paseo-upgrade | role)
    script="$BOOTSTRAP_ROOT/scripts/$1.sh"
    shift
    exec bash "$script" "$@"
    ;;
esac

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

# 자동 갱신과 동시에 돌지 않게 한다. 자동 갱신 안에서 부른 경우는 이미 잡혀 있다.
if [[ "$DRY_RUN" != 1 ]] && ! lock_acquire; then
  info '다른 설치·자동 갱신이 실행 중입니다. 끝나기를 기다립니다 (중단: Ctrl-C)'
  until lock_acquire; do sleep 5; done
fi

# 관리자 비밀번호는 처음에 한 번만 묻고 끝날 때까지 유지한다 (Homebrew 설치·전원 설정·일부 앱 설치).
# 터미널이 아니면 묻지 않는다. 그때 sudo가 필요한 단계는 각자 실패로 알린다.
if [[ "$DRY_RUN" != 1 && -t 0 ]] && { contains homebrew $selected || contains power $selected; }; then
  info '관리자 비밀번호를 한 번 확인합니다. 설치가 끝날 때까지 다시 묻지 않습니다'
  sudo -v
  while kill -0 "$$" 2>/dev/null; do sudo -n true; sleep 50; done >/dev/null 2>&1 &
fi

# 적용 기록에는 이 실행을 시작한 커밋을 남긴다. 실행 중에 이 기기로 들어온 커밋은 다음 갱신이 적용한다.
start_head="$(git -C "$BOOTSTRAP_ROOT" rev-parse HEAD 2>/dev/null || true)"

# 종료 코드: 0 완료, 1 실패, 2 수동 작업 대기. 단계의 3은 부분 실패(계속 진행 후 최종 실패).
failed=''
pending=''
for name in $(all_steps); do
  contains "$name" $selected || continue
  step "$name"
  status=0
  bash "$(step_file "$name")" || status=$?
  # 자동 갱신(update.sh)이 단계별 결과를 받아 간다.
  [[ -z "${BOOTSTRAP_RESULTS:-}" ]] || printf '%s %s\n' "$name" "$status" >>"$BOOTSTRAP_RESULTS"
  [[ "$status" == 0 ]] && continue
  if [[ "$status" == 2 ]]; then
    pending="$pending $name"
    warn "'$name' 단계에 수동 작업이 남았습니다. 나머지 단계는 계속합니다"
    continue
  fi
  if [[ "$status" != 3 ]] && contains "$name" preflight xcode homebrew; then
    fail "'$name' 단계에서 멈췄습니다. 뒤 단계가 이 단계에 기댑니다. 고친 뒤: ./bootstrap.sh --only $name"
    exit 1
  fi
  fail "'$name' 단계 실패. 나머지 단계는 계속합니다"
  failed="$failed $name"
done

# 전체 설치가 실패 없이 끝나면 이 커밋까지 적용한 것으로 기록한다. 자동 갱신은 여기부터 바뀐 것만 실행한다.
if [[ -z "$only" && "$DRY_RUN" != 1 && -z "$failed" ]]; then
  mark_applied "$start_head"
  rm -f "$BOOTSTRAP_UPDATE_STATE/status"
fi

doctor_status=0
if [[ -z "$only" && "$DRY_RUN" != 1 ]]; then
  step "doctor"
  bash "$BOOTSTRAP_ROOT/scripts/doctor.sh" || doctor_status=$?
  printf '\n새 터미널을 열어야 셸 설정이 적용됩니다.\n'
fi

if [[ -n "$pending" ]]; then
  pending="${pending# }"
  warn "수동 작업 대기: $pending → 안내한 조치 후 ./bootstrap.sh --only ${pending// /,}"
fi
if [[ -n "$failed" ]]; then
  failed="${failed# }"
  fail "실패한 단계: $failed → 원인을 고친 뒤: ./bootstrap.sh --only ${failed// /,}"
  exit 1
fi
if [[ "$doctor_status" != 0 && "$doctor_status" != 2 ]]; then
  fail '최종 doctor 검사 실패. 위 항목을 해결한 뒤 ./bootstrap.sh doctor'
  exit 1
fi
if [[ -n "$pending" || "$doctor_status" == 2 ]]; then
  warn '수동 작업을 마친 뒤 ./bootstrap.sh doctor 로 최종 확인하세요'
  exit 2
fi
