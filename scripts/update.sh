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
#   6. 저장소와 별개로 에이전트 CLI(Claude Code·Codex)를 단계보다 먼저 올린다. --auto는 하루에 한 번, 터미널에서는 매번 확인한다.
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

# 비ASCII 경로를 따옴표로 감싸지 않아야 경로 규칙·파일 비교와 맞는다.
git_() { git -C "$BOOTSTRAP_ROOT" -c core.quotePath=false "$@"; }

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
      scripts/agent-skills.mjs | scripts/paseo-profiles.mjs | scripts/paseo-plugins.mjs | scripts/paseo-skills.mjs | scripts/paseo-skills-client.mjs | scripts/paseo-plugins-settings-client.mjs) out="$out paseo" ;;
      scripts/browser-use-setup.mjs) out="$out browser" ;;
      scripts/brew-outside-casks.sh) out="$out homebrew" ;;
      scripts/yw-heavy.sh) out="$out heavy" ;;
      scripts/role.sh | scripts/verifier-logs.sh | scripts/verifier-clock.mjs) out="$out roles" ;;
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

# 상태 파일 쓰기(write_update_status)와 결과 정하기(settle)는 전체 설치(bootstrap.sh)와 함께 쓰도록 lib.sh에 있다.

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
  write_update_status held "$(status_get failed)" "$(status_get pending)" "bootstrap 갱신 보류: $2 → $3"
  notify "held|$1" 'bootstrap 갱신 보류' "$2 → $3" push
}

# 키 순서·들여쓰기만 HEAD와 다른 JSON 파일 (한 줄에 하나). Node가 없으면 고르지 않는다.
# seed 전환 전의 Claude Code 설정처럼, 도구가 링크된 JSON을 다시 쓰며 생긴 포맷 변경도 처리한다.
reordered_json() {
  has node || return 0
  local path
  git_ diff --name-only HEAD -- '*.json' | while IFS= read -r path; do
    git_ show "HEAD:$path" 2>/dev/null | node -e '
      const fs = require("fs");
      const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
      const norm = text => JSON.stringify(sort(JSON.parse(text)));
      try { process.exit(norm(fs.readFileSync(0, "utf8")) === norm(fs.readFileSync(process.argv[1], "utf8")) ? 0 : 1); }
      catch { process.exit(1); }' "$BOOTSTRAP_ROOT/$path" && printf '%s\n' "$path"
  done
}

# --auto는 할 일이 있을 때만 시각과 함께 기록한다 (update.log). 아무것도 안 한 확인은 남기지 않는다.
header() {
  [[ "$AUTO" == 1 && "$HEADER_DONE" == 0 ]] || return 0
  HEADER_DONE=1
  printf '\n[%s]\n' "$(date '+%F %T')"
}

# 에이전트 CLI를 공식 업데이트 명령으로 올린다. 공식 설치 스크립트의 자체 업데이트는 CLI를 직접 실행할 때 돌아서,
# Paseo·exec로만 쓰는 기기에서는 오래 멈춰 있을 수 있다. 새 모델은 최신 CLI에서만 열리기도 한다 (agents/codex.md).
# 새 버전은 따로 설치하고 링크만 바꾸므로 실행 중인 세션은 그대로 둔다. 실패해도 저장소 반영은 계속하고 기록만 남긴다.
CLI_UPDATE_HOURS=24
# 한 CLI를 올리는 데 쓰는 최대 시간(초). 멈추면 잠금을 계속 잡아 저장소 반영까지 막히므로 끝내고 넘어간다.
CLI_UPDATE_TIMEOUT="${BOOTSTRAP_CLI_UPDATE_TIMEOUT:-600}"

# 시간 제한 실행: limited <초> <출력 파일> <명령...>. 넘기면 끝내고 124를 돌려준다.
# macOS 기본 환경에는 timeout 명령이 없어 감시 프로세스로 대신한다. 출력은 파일로 받는다.
# 명령 치환으로 받으면 끝내지 못한 자식 프로세스가 출력을 열어 둔 동안 기다리게 된다.
# 감시 프로세스는 끝내기 전에 표시 파일을 남긴다. 종료 코드나 감시 프로세스 생존 여부로 판정하면 경합이 생긴다.
# TERM을 무시하면 5초 뒤 KILL로 끝낸다.
limited() {
  local seconds="$1" out="$2" flag="$2.timeout" pid watcher st
  shift 2
  rm -f "$flag"
  "$@" </dev/null >"$out" 2>&1 &
  pid=$!
  # 감시 프로세스는 TERM을 받으면 기다리던 sleep과 함께 바로 끝난다. sleep만 끝내면 다음 줄로 넘어가 표시를 남긴다.
  # shellcheck disable=SC2016
  ( trap 'kill $! 2>/dev/null; exit 0' TERM
    sleep "$seconds" & wait $!
    : >"$flag"; kill "$pid"
    sleep 5 & wait $!
    kill -9 "$pid" ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" 2>/dev/null  # 시간 초과로 끝낸 작업의 "Terminated" 알림을 기록에 남기지 않는다
  st=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  if [[ -e "$flag" ]]; then
    rm -f "$flag"
    st=124
  fi
  return "$st"
}

update_clis() {
  # 받은 커밋의 update.sh로 다시 시작하기 전에 이미 확인했으면 건너뛴다. 다시 시작했다는 것만으로 건너뛰면 안 된다.
  # 이 함수가 없던 update.sh가 새 커밋을 받아 다시 시작할 때는 확인한 적이 없다. 그 실행이 바로 이어서
  # 새 CLI가 필요한 프로필(paseo-profiles)을 적용할 수 있으므로 단계보다 먼저 올린다.
  [[ "${BOOTSTRAP_CLIS_CHECKED:-0}" != 1 ]] || return 0
  if [[ "$AUTO" == 1 && -n "$(find "$STATE/cli-updated" -mmin -$((CLI_UPDATE_HOURS * 60)) 2>/dev/null)" ]]; then
    return 0
  fi
  local cli before after st out='' failed=0
  for cli in claude codex; do
    has "$cli" || continue
    if [[ "$DRY_RUN" == 1 ]]; then
      info "[dry-run] $cli update"
      continue
    fi
    # dry-run은 잠금 없이 돌므로 실행마다 따로 만든 파일을 쓴다.
    [[ -n "$out" ]] || out="$(mktemp "$STATE/cli-update.XXXXXX")" || return 0
    limited 30 "$out" "$cli" --version
    before="$(head -1 "$out")"
    limited "$CLI_UPDATE_TIMEOUT" "$out" "$cli" update
    st=$?
    if [[ "$st" == 0 ]]; then
      limited 30 "$out" "$cli" --version
      after="$(head -1 "$out")"
      if [[ "$after" != "$before" ]]; then
        header
        info "$cli 업데이트: $before → $after"
      elif [[ "$AUTO" != 1 ]]; then
        ok "$cli 최신 ($after)"
      fi
    else
      failed=1
      header
      if [[ "$st" == 124 ]]; then
        warn "$cli update 시간 초과(${CLI_UPDATE_TIMEOUT}초): 끝내고 넘어갑니다"
      else
        warn "$cli update 실패: $(tail -1 "$out")"
      fi
    fi
  done
  [[ -z "$out" ]] || rm -f "$out"
  if [[ "$DRY_RUN" != 1 ]]; then
    touch "$STATE/cli-updated"
    # 실패했으면 하루가 아니라 한 시간 뒤에 다시 시도한다. 확인 시각을 23시간 앞당겨 기록한다.
    # 구버전 CLI로는 새 모델을 쓰는 프로필이 실패하므로 오래 두지 않는다.
    # 현지 시각 문자열 대신 상대 조정(-A)을 쓴다. 일광절약시간이 끝나는 구간에서도 어긋나지 않는다.
    [[ "$failed" == 0 ]] || touch -A "-$((CLI_UPDATE_HOURS - 1))0000" "$STATE/cli-updated"
  fi
  export BOOTSTRAP_CLIS_CHECKED=1
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
  # 저장소 상태(보류 등)와 관계없이 올린다. 네트워크가 있을 때만 여기까지 온다.
  update_clis

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
  # 새 커밋을 받아야 하는데 내용이 같은 JSON만 걸려 있으면 HEAD로 되돌리고 받는다. 잃는 설정이 없다.
  if [[ "$behind" != 0 && -n "$dirty" ]]; then
    local path excludes=()
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      header
      if [[ "$DRY_RUN" == 1 ]]; then
        info "[dry-run] 키 순서만 바뀐 $path 되돌리기"
      elif git_ checkout HEAD -- "$path"; then
        info "키 순서만 바뀐 $path 되돌림"
      else
        continue
      fi
      excludes+=(":(exclude)$path")
    done <<<"$(reordered_json)"
    if ((${#excludes[@]})); then
      dirty="$(git_ status --porcelain --untracked-files=no -- . "${excludes[@]}")"
    fi
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
    steps="$(git_ diff --name-only "$applied" "$target" | steps_for_paths)"
  fi
  steps="$steps $prev_failed"
  [[ "$AUTO" == 1 ]] || steps="$steps $prev_pending"
  # heavy의 사용 중 보류는 시간이 지나면 풀린다. 일반 수동 대기는 유지하고 heavy만 매번 확인한다.
  if contains heavy $prev_pending; then steps="$steps heavy"; fi
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
