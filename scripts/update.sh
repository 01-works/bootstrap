#!/usr/bin/env bash
# 저장소 변경을 이 기기에 반영한다: ./bootstrap.sh update [--auto] [--dry-run]
# 모든 기기에서 LaunchAgent(local.bootstrap.update)가 로그인할 때와 10분마다 --auto로 부른다 (autoupdate 단계).
#   1. fetch 후 fast-forward만 한다. 커밋 안 된 변경이 있거나 갈라졌으면 받지 않고 보류로 알린다. push·merge는 하지 않는다.
#      받았으면 받은 커밋의 update.sh로 다시 시작한다 (그 커밋의 규칙으로 단계를 고른다).
#   2. 마지막으로 적용한 커밋(applied)부터 HEAD까지 바뀐 파일로 다시 실행할 단계를 고른다. 기록이 없으면 전부 확인한다.
#   3. --auto에서는 각 단계가 사람이 필요한 일(비밀번호·설치 창·로그인)을 하지 않고 수동 작업 대기로 남긴다.
#      터미널에서 ./bootstrap.sh update를 실행하면 대기로 남은 단계까지 다시 실행한다.
#   4. 결과를 상태 파일에 남기고, --auto는 결과가 바뀔 때만 알린다 (macOS 알림, 설정했으면 휴대폰).
#   5. 실패해도 적용 기록은 앞으로 옮기고, 실패한 단계만 이어서 다시 시도한다 (같은 커밋은 한 시간 뒤).
# pull로 이 파일이 바뀌어도 읽던 내용이 섞이지 않도록 전체를 함수로 정의한 뒤 맨 끝에서 부른다.

BOOTSTRAP_ROOT="${BOOTSTRAP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export BOOTSTRAP_ROOT

usage() {
  cat <<'EOF'
사용법: ./bootstrap.sh update [--auto] [--dry-run]
  저장소를 받아(fast-forward만) 바뀐 부분에 해당하는 단계만 실행합니다. 수동 작업 대기로 남은 단계도 다시 실행합니다.
  --auto     자동 갱신용. 사람이 필요한 일은 하지 않고, 결과가 바뀌면 알림을 보냅니다
  --dry-run  받을 커밋과 실행할 단계만 보여 줍니다
EOF
}

git_() { git -C "$BOOTSTRAP_ROOT" "$@"; }

# 단계 이름 (실행 순서).
all_steps() {
  local f
  for f in "$BOOTSTRAP_ROOT"/scripts/steps/*.sh; do
    f="${f##*/}"
    f="${f%.sh}"
    printf '%s ' "${f#*-}"
  done
}

# 적용 기록이 없을 때 확인할 단계. preflight는 fetch로 이미 확인했다.
auto_steps() {
  local name
  for name in $(all_steps); do
    [[ "$name" == preflight ]] || printf '%s ' "$name"
  done
}

# 바뀐 파일(한 줄에 하나) → 다시 실행할 단계. 문서·테스트·doctor처럼 기기에 적용할 것이 없는 파일은 고르지 않는다.
# paseo-profiles는 단계가 아니라 기존 프로필까지 저장소 값으로 갱신하는 일이다 (agents/paseo.md#설치와-갱신).
steps_for_paths() {
  local path out=''
  while IFS= read -r path; do
    case "$path" in
      home/*) out="$out dotfiles" ;;
      agents/skills/*) out="$out paseo" ;;
      agents/paseo-profiles.json) out="$out paseo paseo-profiles" ;;
      agents/paseo-plugins.json) out="$out paseo" ;;
      Brewfile) out="$out homebrew" ;;
      bootstrap.sh | scripts/lib.sh) out="$out $(auto_steps)" ;;
      scripts/launch-agents.mjs) out="$out browser paseo autoupdate" ;;
      scripts/skill-paths.mjs) out="$out browser paseo" ;;
      scripts/agent-skills.mjs | scripts/paseo-profiles.mjs | scripts/paseo-plugins.mjs | scripts/paseo-skills.mjs | scripts/paseo-skills-client.mjs) out="$out paseo" ;;
      scripts/browser-use-setup.mjs) out="$out browser" ;;
      scripts/brew-outside-casks.sh) out="$out homebrew" ;;
      scripts/yw-heavy.sh) out="$out heavy" ;;
      scripts/role.sh | scripts/verifier-logs.sh) out="$out roles" ;;
      scripts/steps/[0-9]*-*.sh)
        path="${path##*/}"
        path="${path%.sh}"
        out="$out ${path#*-}"
        ;;
    esac
  done
  printf '%s' "$out"
}

# 실행 순서대로, 중복 없이. 지금 없는 단계는 뺀다: ordered <단계...>
ordered() {
  local name out=''
  for name in $(all_steps); do
    if contains "$name" "$@"; then out="$out $name"; fi
    if [[ "$name" == paseo ]] && contains paseo-profiles "$@"; then out="$out paseo-profiles"; fi
  done
  printf '%s' "${out# }"
}

status_get() { sed -n "s/^$1=//p" "$STATE/status" 2>/dev/null | head -1; }

# write_status <결과> <실패 단계> <대기 단계> <새 터미널에 보일 한 줄>
write_status() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  printf 'result=%s\ncommit=%s\nat=%s\nfailed=%s\npending=%s\nbanner=%s\n' \
    "$1" "$(git_ rev-parse --short HEAD)" "$(date +%s)" "$2" "$3" "$4" >"$STATE/status.tmp"
  mv "$STATE/status.tmp" "$STATE/status"
}

# 실패·대기 단계로 결과를 정해 기록하고 결과 이름을 출력한다: settle <실패 단계> <대기 단계>
settle() {
  local repo log=''
  repo="$(pretty "$BOOTSTRAP_ROOT")"
  [[ "$AUTO" == 1 ]] && log=" (기록: $(pretty "$STATE")/update.log)"
  if [[ -n "$1" ]]; then
    write_status failed "$1" "$2" "bootstrap 갱신 실패: $1 → $repo/bootstrap.sh update$log"
    printf failed
  elif [[ -n "$2" ]]; then
    write_status pending '' "$2" "bootstrap 수동 작업 대기: $2 → $repo/bootstrap.sh update"
    printf pending
  else
    write_status ok '' '' ''
    printf ok
  fi
}

# 같은 내용은 한 번만 알린다: notify <중복 확인 키> <제목> <내용> [push]
notify() {
  [[ "$AUTO" == 1 && "$DRY_RUN" != 1 ]] || return 0
  [[ "$(cat "$STATE/notified" 2>/dev/null)" != "$1" ]] || return 0
  printf '%s\n' "$1" >"$STATE/notified"
  send_notification "$2" "$3" "${4:-}"
}

# 저장소를 받지 않고 멈춘다. --auto는 상태로 남기고 알린다: hold <중복 확인 키> <이유> <조치>
hold() {
  if [[ "$AUTO" != 1 ]]; then
    fail "$2 → $3"
    return 1
  fi
  write_status held "$(status_get failed)" "$(status_get pending)" "bootstrap 갱신 보류: $2 → $3"
  notify "held|$1" 'bootstrap 갱신 보류' "$2 → $3" push
}

# --auto는 할 일이 있을 때만 시각과 함께 기록한다 (update.log). 아무것도 안 한 확인은 남기지 않는다.
header() {
  [[ "$AUTO" == 1 && "$HEADER_DONE" == 0 ]] || return 0
  HEADER_DONE=1
  printf '\n[%s]\n' "$(date '+%F %T')"
}

main() {
  set -uo pipefail
  # shellcheck source=scripts/lib.sh
  source "$BOOTSTRAP_ROOT/scripts/lib.sh"
  AUTO=0
  HEADER_DONE="${BOOTSTRAP_UPDATE_REEXEC:-0}"  # 새 커밋의 update.sh로 다시 시작했으면 이미 시각을 남겼다
  local arg
  for arg in "$@"; do
    case "$arg" in
      --auto) AUTO=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help) usage; return 0 ;;
      *) usage; die "알 수 없는 인자: $arg" ;;
    esac
  done
  export DRY_RUN
  STATE="$BOOTSTRAP_UPDATE_STATE"
  mkdir -p "$STATE"

  # 기록이 1MB를 넘으면 뒷부분만 남긴다. launchd가 열어 둔 채 이어 쓰므로 파일을 바꾸지 않고 내용만 줄인다.
  if [[ "$AUTO" == 1 && -f "$STATE/update.log" ]] && (($(stat -f %z "$STATE/update.log") > 1048576)); then
    tail -c 262144 "$STATE/update.log" >"$STATE/update.log.tmp" && cat "$STATE/update.log.tmp" >"$STATE/update.log"
    rm -f "$STATE/update.log.tmp"
  fi

  if [[ "$DRY_RUN" != 1 ]] && ! lock_acquire; then
    if [[ "$AUTO" == 1 ]]; then
      # 설치나 다른 갱신이 실행 중이면 다음 주기에 다시 본다. 두 시간 넘게 안 끝나면 멈춘 것일 수 있어 알리기만 한다.
      local holder
      holder="$(cat "$BOOTSTRAP_LOCK/pid" 2>/dev/null || true)"
      if [[ -n "$(find "$BOOTSTRAP_LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]]; then
        notify "stuck|$holder" 'bootstrap 갱신 멈춤' "두 시간 넘게 끝나지 않은 설치·갱신이 있습니다 (pid $holder) → ps -p $holder 로 확인"
      fi
      return 0
    fi
    info '다른 설치·갱신이 실행 중입니다. 끝나기를 기다립니다 (중단: Ctrl-C)'
    until lock_acquire; do sleep 5; done
  fi

  local repo branch upstream
  repo="$(pretty "$BOOTSTRAP_ROOT")"
  # 주기적인 git status가 index.lock을 잡아 사용자의 git 명령과 부딪히지 않게 한다.
  export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=30
  if ! git_ fetch --quiet origin; then
    # 네트워크가 없을 때. 하루 넘게 이어지면 새 터미널과 doctor가 알린다.
    [[ "$AUTO" == 1 ]] && return 0
    fail "저장소를 받지 못했습니다 (git -C $repo fetch)"
    return 1
  fi
  [[ "$DRY_RUN" == 1 ]] || touch "$STATE/checked"

  branch="$(git_ symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  upstream="$(git_ rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ "$branch" != main || "$upstream" != origin/main ]]; then
    hold "branch|$branch|$upstream" "main 브랜치(origin/main 추적)가 아닙니다 (${branch:-분리된 HEAD})" "git -C $repo switch main"
    return
  fi

  local behind ahead dirty remote
  behind="$(git_ rev-list --count 'HEAD..@{u}')"
  ahead="$(git_ rev-list --count '@{u}..HEAD')"
  dirty="$(git_ status --porcelain --untracked-files=no)"
  remote="$(git_ rev-parse --short '@{u}')"
  if [[ "$behind" != 0 && "$ahead" != 0 ]]; then
    hold diverged "이 기기의 커밋과 원격 커밋($remote)이 갈라졌습니다" "git -C $repo pull --rebase 후 push"
    return
  fi
  if [[ "$behind" != 0 && -n "$dirty" ]]; then
    hold dirty "커밋 안 된 변경이 있어 새 커밋($remote)을 받지 않았습니다" "git -C $repo status 로 확인하고 커밋·push 또는 되돌리기"
    return
  fi
  # 보류가 풀렸으면 남아 있던 실패·대기로 상태를 되돌린다.
  if [[ "$(status_get result)" == held ]]; then
    settle "$(status_get failed)" "$(status_get pending)" >/dev/null
  fi
  if [[ -n "$dirty" ]]; then
    # 이 기기에서 고치는 중이다. 자동으로는 손대지 않는다.
    [[ "$AUTO" == 1 ]] && return 0
    warn '커밋 안 된 변경이 있습니다. 작업 중인 내용으로 단계를 실행합니다'
  fi

  local target=HEAD
  if [[ "$behind" != 0 ]]; then
    if [[ "$DRY_RUN" == 1 ]]; then
      info "[dry-run] 새 커밋 ${behind}개 받기 (fast-forward)"
      target='@{u}'
    else
      header
      info "새 커밋 ${behind}개 받기"
    fi
    git_ log --oneline "HEAD..@{u}" | sed 's/^/      /'
    if [[ "$DRY_RUN" != 1 ]]; then
      if ! git_ merge --ff-only --quiet '@{u}'; then
        hold merge "fast-forward 실패" "git -C $repo pull --ff-only"
        return
      fi
      # 받은 커밋의 update.sh로 다시 시작해 그 커밋의 규칙으로 단계를 고른다. 같은 프로세스라 잠금은 이어진다.
      if [[ "${BOOTSTRAP_UPDATE_REEXEC:-0}" != 1 ]]; then
        BOOTSTRAP_UPDATE_REEXEC=1 exec bash "$BOOTSTRAP_ROOT/scripts/update.sh" "$@"
      fi
    fi
  fi
  target="$(git_ rev-parse "$target")"

  # 다시 실행할 단계: 마지막 적용 이후 바뀐 파일 + 실패했던 단계 + (터미널에서) 대기로 남은 단계.
  local applied steps='' prev_failed prev_pending
  applied="$(cat "$STATE/applied" 2>/dev/null || true)"
  if [[ -n "$applied" ]] && ! git_ cat-file -e "$applied^{commit}" 2>/dev/null; then applied=''; fi
  prev_failed="$(status_get failed)"
  prev_pending="$(status_get pending)"
  if [[ -z "$applied" ]]; then
    steps="$(auto_steps)"
  elif [[ "$applied" != "$target" ]]; then
    # 비ASCII 경로를 따옴표로 감싸지 않아야 아래 경로 규칙과 맞는다.
    steps="$(git_ -c core.quotePath=false diff --name-only "$applied" "$target" | steps_for_paths)"
  fi
  steps="$steps $prev_failed"
  [[ "$AUTO" == 1 ]] || steps="$steps $prev_pending"
  # shellcheck disable=SC2086
  steps="$(ordered $steps)"

  # 같은 커밋에서 실패했으면 자동으로는 한 시간 뒤에 다시 시도한다. 새 커밋이 오면 바로 시도한다.
  if [[ "$AUTO" == 1 && "$(status_get result)" == failed && "$(status_get commit)" == "$(git_ rev-parse --short "$target")" ]]; then
    local at
    at="$(status_get at)"
    (($(date +%s) - ${at:-0} < 3600)) && return 0
  fi

  if [[ -z "$steps" ]]; then
    if [[ "$DRY_RUN" == 1 ]]; then
      info '[dry-run] 다시 실행할 단계 없음'
      return 0
    fi
    [[ "$applied" == "$target" ]] || mark_applied "$target"  # 문서처럼 기기에 적용할 것이 없는 변경
    # 실패·대기로 남은 단계가 저장소에서 없어졌으면 상태에서도 뺀다.
    local kept_failed kept_pending
    # shellcheck disable=SC2086
    kept_failed="$(ordered $prev_failed)"
    # shellcheck disable=SC2086
    kept_pending="$(ordered $prev_pending)"
    if [[ "$kept_failed" != "$prev_failed" || "$kept_pending" != "$prev_pending" ]]; then
      settle "$kept_failed" "$kept_pending" >/dev/null
    fi
    [[ "$AUTO" == 1 ]] || ok "최신 상태 ($(git_ rev-parse --short HEAD))"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] 실행할 단계: $steps"
    return 0
  fi

  header
  info "실행할 단계: $steps ($(git_ rev-parse --short HEAD))"
  local results="$STATE/results" only='' name st
  : >"$results"
  for name in $steps; do
    [[ "$name" == paseo-profiles ]] || only="$only,$name"
  done
  if [[ -n "$only" ]]; then
    BOOTSTRAP_UNATTENDED="$AUTO" BOOTSTRAP_RESULTS="$results" bash "$BOOTSTRAP_ROOT/bootstrap.sh" --only "${only#,}" || true
  fi
  if contains paseo-profiles $steps; then
    step 'Paseo 기존 프로필을 저장소 값으로 갱신'
    st=0
    node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs" --update || st=$?
    printf 'paseo-profiles %s\n' "$st" >>"$results"
  fi

  # 결과가 없는 단계는 앞 단계(xcode·homebrew) 실패로 실행되지 않은 것이다. 실패로 남겨 다시 실행한다.
  # 적용 기록은 실패해도 앞으로 옮긴다. 실패한 단계는 상태의 failed로 이어서 다시 실행하고, 성공한 단계는 반복하지 않는다.
  local failed='' pending='' result
  for name in $steps; do
    st="$(awk -v n="$name" '$1 == n {s = $2} END {print s}' "$results")"
    case "$st" in
      0) ;;
      2) pending="$pending $name" ;;
      *) failed="$failed $name" ;;
    esac
  done
  for name in $prev_pending; do
    contains "$name" $steps || pending="$pending $name"
  done
  failed="${failed# }"
  # shellcheck disable=SC2086
  pending="$(ordered $pending)"
  mark_applied "$target"
  result="$(settle "$failed" "$pending")"

  local commit
  commit="$(git_ rev-parse --short HEAD)"
  case "$result" in
    failed)
      notify "failed|$failed" 'bootstrap 실패' "$failed → 터미널에서 ./bootstrap.sh update" push
      fail "실패: $failed → 원인을 고친 뒤 ./bootstrap.sh update"
      return 1
      ;;
    pending)
      notify "pending|$pending" 'bootstrap 수동 작업 대기' "$pending → 터미널에서 ./bootstrap.sh update" push
      warn "수동 작업 대기: $pending → 안내한 조치 후 ./bootstrap.sh update"
      return 2
      ;;
  esac
  notify "ok|$commit" 'bootstrap 적용됨' "$commit: $steps"
  ok "적용됨 ($commit): $steps"
}

# 같은 줄의 exit: main이 끝난 뒤 바뀐 파일의 나머지를 읽지 않는다.
main "$@"; exit $?
