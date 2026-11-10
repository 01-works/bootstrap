#!/bin/bash
# 공용 heavy 대기열: 같은 기기의 무거운 작업(전체 테스트·빌드·dev 서버 등)을 감독 세션·worktree를 넘어 하나씩 실행한다.
# 모든 기기에 ~/.local/bin/yw-heavy로 설치된다 (heavy 단계). 사용법·생존 판정·회수 규칙·전환과 롤백은 agents/heavy-queue.md.
# 새 Mac의 bash 3.2로 실행한다. 설치본이 실행 중에 바뀌어도 읽던 내용이 섞이지 않도록 전체를 함수로 정의한 뒤 맨 끝에서 부른다.
#
# 파일 (테스트는 환경 변수로 바꾼다):
#   대기열 YW_HEAVY_QUEUE (/tmp/yw-heavy-queue)      한 줄에 하나: <ID> worker=<w> supervisor=<s> v=2 pid=<P|-> start=<S|->
#   실행 lock YW_HEAVY_EXEC_LOCK (/tmp/yw-heavy-check.lock/owner.txt)
#   편집 lock YW_HEAVY_FLOCK ($Q.flock, 커널 flock) + 호환 표지 파일 YW_HEAVY_EDIT_LOCK (/tmp/yw-heavy-queue.edit.lock)
#   회수 기록 YW_HEAVY_LOG ($Q.log), 회수 끄기 YW_HEAVY_NO_RECLAIM ($Q.no-reclaim), 대기 주기 YW_HEAVY_POLL (30초)
#   v3 모드 $Q.mode (없으면 compat), 신규 제출 중지 $Q.paused, 감독자 순환 $Q.rotation
#   v3 작업 이벤트 YW_HEAVY_EVENTS ($Q.events), 내부 재확인 YW_HEAVY_FAST_POLL (.2초)
#   v3 pending 한도 YW_HEAVY_MAX_PENDING_SUPERVISOR (128), YW_HEAVY_MAX_PENDING (1024)
#   owner 없는 실행 lock 회수까지 YW_HEAVY_OWNERLESS_AGE (60초), 구형식 편집 lock 경고까지 YW_HEAVY_EDIT_WARN (120초)

usage() {
  cat <<'EOF'
사용법:
  yw-heavy run <ID> <worker> <supervisor> -- <명령…>   권장. 명령이 실행되는 동안만 차례를 잡는다. 종료 코드는 명령의 것
  yw-heavy acquire <ID> <worker> <supervisor> [--holder PID]
                                                        차례가 오면 "ACQUIRED <ID>". holder가 끝나면 다른 대기자가 회수한다
  yw-heavy release <ID>                                 차례(그 ID의 것일 때)와 그 ID의 대기 줄을 지운다
  yw-heavy enqueue <ID> <worker> <supervisor>           구버전 acquire 호환 전용 (구형식 줄)
  yw-heavy status                                       읽기 전용 상태
  yw-heavy capabilities                                 JSON 프로토콜·현재 모드 (version도 동일)
  yw-heavy reclaim                                      확정 사망 항목만 회수 (pause 중 drain용)
  yw-heavy pause | resume                               신규 제출 중지·재개 (기존 대기는 drain)
  yw-heavy mode [compat|round-robin]                     조회·전환 (pause + 빈 대기열 필요)
  yw-heavy acquire <ID> <worker> <supervisor> --json [--holder PID]
                                                        v3 JSON lease (활성 모드 전용)
  yw-heavy release --generation G --token T --lease L    v3 세대별 해제 (빌린 lease는 no-op)
verifier 역할 기기: acquire·run은 supervisor=verifier-loop만 허용한다.
  예외: YW_HEAVY_VERIFIER_OVERRIDE_REASON='<사유>' (owner와 진단 로그에 기록)
종료 코드: 0 성공, 1 내부 오류, 2 사용법 오류·holder가 처음부터 끝나 있음,
           4 verifier 역할 거절·제출 중지·모드 비활성·전환 거절, 5 pending 한도 초과, 6 lease·생존 검증 실패,
           3 대기 줄 제거·이어받힘·holder 종료·같은 ID가 이미 차례를 가짐·같은 ID의 구버전 줄
EOF
}

say() { printf 'yw-heavy: %s\n' "$*" >&2; }

init() {
  set -f  # 줄을 단어로 나눌 때 *를 파일 이름으로 펼치지 않는다
  Q="${YW_HEAVY_QUEUE:-/tmp/yw-heavy-queue}"
  XL="${YW_HEAVY_EXEC_LOCK:-/tmp/yw-heavy-check.lock}"
  EL="${YW_HEAVY_EDIT_LOCK:-/tmp/yw-heavy-queue.edit.lock}"
  FL="${YW_HEAVY_FLOCK:-$Q.flock}"
  LOG="${YW_HEAVY_LOG:-$Q.log}"
  NR="${YW_HEAVY_NO_RECLAIM:-$Q.no-reclaim}"
  POLL="${YW_HEAVY_POLL:-30}"
  MODE="$Q.mode" PAUSED="$Q.paused" RING="$Q.rotation" EVENTS="${YW_HEAVY_EVENTS:-$Q.events}"
  FAST_POLL="${YW_HEAVY_FAST_POLL:-.2}"
  MAX_SUP="${YW_HEAVY_MAX_PENDING_SUPERVISOR:-128}" MAX_ALL="${YW_HEAVY_MAX_PENDING:-1024}"
  GEN='' TOKEN='' LEASE='' BORROWED=false JSON=0 EXIT_CODE=unknown
  OVERRIDE_REASON=''
  IN_GEN="${YW_HEAVY_GENERATION:-}" IN_TOKEN="${YW_HEAVY_TOKEN:-}"
  EDIT_WARN="${YW_HEAVY_EDIT_WARN:-120}"
  OWNERLESS_AGE="${YW_HEAVY_OWNERLESS_AGE:-60}"
  # 구버전 편집 lock이 풀리기를 기다리는 주기. 1초보다 짧은 대기 주기(테스트)면 그것을 쓴다.
  case "$POLL" in 0* | .*) EDIT_POLL="$POLL" ;; *) EDIT_POLL=1 ;; esac
  LOCKF=/usr/bin/lockf
  ID='' WORKER='' SUP='' HOLDER='' HOLDER_START=- MYSTART=- MYMARK='' LOCKED=0 SIG='' HELD=0
}

# role.sh와 같은 상태 경로·파일 판정. 프로젝트별 ID 대신 기존 verifier 루프의 감독자 식별자를 쓴다.
verifier_guard() {
  [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/roles/verifier" ] || return 0
  [ "$SUP" != verifier-loop ] || return 0
  # 기록은 한 줄로 유지한다. 제어 문자를 제거한 뒤에도 공백뿐이면 사유가 아니다.
  OVERRIDE_REASON="$(printf '%s' "${YW_HEAVY_VERIFIER_OVERRIDE_REASON:-}" | LC_ALL=C tr -d '\000-\037\177')"
  case "$OVERRIDE_REASON" in
    *[![:space:]]*) note "verifier-override task=$ID worker=$WORKER supervisor=$SUP reason=$OVERRIDE_REASON" ;;
    *) say "verifier 역할 기기는 supervisor=verifier-loop만 허용합니다. 예외에는 YW_HEAVY_VERIFIER_OVERRIDE_REASON에 사유가 필요합니다"; return 4 ;;
  esac
}

override_owner_field() {
  [ -z "$OVERRIDE_REASON" ] || printf ',"verifierOverrideReason":"%s"' "$(json_esc "$OVERRIDE_REASON")"
}

# ---- 생존 판정 ---------------------------------------------------------------

# 프로세스 시작 시각 (예: Mon_Oct_19_05:08:49_2026). ps가 실패하거나 보이지 않으면 실패한다.
proc_start() {
  local s
  s="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null)" || return 1
  # shellcheck disable=SC2086
  set -- $s
  [ $# -gt 0 ] || return 1
  s="$*"
  printf '%s' "${s// /_}"
}

# proc_state <pid> [<기록된 시작 시각>] → alive | unknown | dead:esrch | dead:start-mismatch
# 사망은 확정될 때만: kill -0이 ESRCH이거나, 프로세스가 있는데 시작 시각이 기록과 다를 때(PID 재사용).
# EPERM, ps 실패, 시작 시각 미기록은 판단하지 않는다 (보존).
proc_state() {
  local pid="$1" rec="${2:--}" err cur exists=1
  case "$pid" in '' | 0* | *[!0-9]*) echo unknown; return ;; esac
  if ! err="$(LC_ALL=C; kill -0 "$pid" 2>&1)"; then
    case "$err" in *'No such process'*) echo dead:esrch; return ;; esac
    exists=0
  fi
  if [ "$rec" = - ] || [ -z "$rec" ]; then
    if [ "$exists" = 1 ]; then echo alive; else echo unknown; fi
    return
  fi
  cur="$(proc_start "$pid")" || cur=''
  if [ -z "$cur" ]; then echo unknown
  elif [ "$cur" = "$rec" ]; then echo alive
  else echo dead:start-mismatch
  fi
}

# ---- 대기열·owner 읽기 -------------------------------------------------------

q_lines() { [ -f "$Q" ] && grep -v '^[[:space:]]*$' "$Q" 2>/dev/null; return 0; }
line_id() {
  # shellcheck disable=SC2086
  set -- $1
  printf '%s' "${1:-}"
}
# 줄의 key=value 값 (첫 단어 ID는 제외): lf <줄> <key>
lf() {
  local key="$2" w
  # shellcheck disable=SC2086
  set -- $1
  shift
  for w in "$@"; do
    case "$w" in "$key="*) printf '%s' "${w#*=}"; return 0 ;; esac
  done
  return 1
}
is_v2() {
  local v
  v="$(lf "$1" v)" || return 1
  case "$v" in '' | *[!0-9]*) return 1 ;; esac
  [ "$v" -ge 2 ]
}
q_line() { q_lines | awk -v id="$1" '$1 == id { print; exit }'; }
# 같은 감독자의 다른 ID 줄 수.
sup_count() { q_lines | awk -v id="$ID" -v s="supervisor=$SUP" '$1 != id { for (i = 2; i <= NF; i++) if ($i == s) { n++; break } } END { print n + 0 }'; }
# 비어 있지 않은 모든 줄이 v2일 때만 실행 lock 회수를 켠다 (관문).
gate_open() {
  local l
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    is_v2 "$l" || return 1
  done <<EOF
$(q_lines)
EOF
  return 0
}

# 원자적으로 다시 쓴다: q_write <줄들 (끝 줄바꿈 없이)>
q_write() {
  local tmp
  tmp="$(mktemp "$Q.tmp.XXXXXX")" || return 1
  if [ -n "$1" ]; then printf '%s\n' "$1" >"$tmp"; else : >"$tmp"; fi &&
    chmod 600 "$tmp" && mv -f "$tmp" "$Q" && return 0
  rm -f "$tmp"
  return 1
}
q_append() {
  local cur
  cur="$(q_lines)"
  q_write "${cur:+$cur
}$1"
}
q_drop() { q_write "$(q_lines | awk -v id="$1" '$1 != id')"; }
# 그 ID 줄의 pid·start만 바꾼다. 위치는 그대로.
q_set_ps() {
  q_write "$(q_lines | awk -v id="$1" -v p="$2" -v s="$3" '
    $1 == id { out = $1; for (i = 2; i <= NF; i++) if ($i !~ /^(pid|start)=/) out = out " " $i; $0 = out " pid=" p " start=" s }
    { print }')"
}

owner_read() { cat "$XL/owner.txt" 2>/dev/null; }
json_str() { printf '%s' "$1" | sed -nE "s/.*\"$2\":[[:space:]]*\"([^\"]*)\".*/\\1/p" | head -1; }
json_num() { printf '%s' "$1" | sed -nE "s/.*\"$2\":[[:space:]]*([0-9]+).*/\\1/p" | head -1; }
json_esc() {
  local s="${1//\\/\\\\}"
  printf '%s' "${s//\"/\\\"}"
}
# 구형식 편집 lock owner: 구 bash는 {"pid":N,"task":"T"}, R1-heavy.py는 pid=N task=T. 둘 다 그 프로세스 자신의 pid다.
edit_owner_field() {
  local v
  if [ "$2" = pid ]; then v="$(json_num "$1" pid)"; else v="$(json_str "$1" "$2")"; fi
  [ -n "$v" ] || v="$(printf '%s' "$1" | sed -nE "s/(^|.*[[:space:]])$2=([^[:space:]]+).*/\\2/p" | head -1)"
  printf '%s' "$v"
}
# owner.txt가 없거나 비어 있는 실행 lock이 마지막으로 바뀐 뒤 지난 초. owner가 있거나 lock이 없으면 실패한다.
ownerless_age() {
  [ -d "$XL" ] && [ ! -s "$XL/owner.txt" ] || return 1
  echo $(($(date +%s) - $(stat -f %m "$XL" 2>/dev/null || date +%s)))
}
owner_v2() {
  local v
  v="$(json_num "$1" v)"
  [ -n "$v" ] && [ "$v" -ge 2 ]
}

# 회수·이어받기 기록: 기록 파일과 stderr에 한 줄. 기록에 실패해도 계속한다.
# task 등은 /tmp의 표지·owner 파일에서 읽은 값이라 제어 문자를 지운다 (한 줄 유지, 터미널 이스케이프 차단).
note() {
  local msg
  msg="$(printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ) $* by=$$:${ID:--}" | LC_ALL=C tr -d '\000-\037\177')"
  say "$msg"
  { printf '%s\n' "$msg" >>"$LOG"; } 2>/dev/null || true
}

# ---- queue lock: 커널 flock + 구버전을 막는 호환 편집 lock -----------------------

lock_queue() {
  local rc backoff=100 wait_ms wait_seconds warned_at="$SECONDS"
  # shellcheck disable=SC2093
  if ! exec 9>>"$FL"; then
    exec 9>&-
    say "대기열 잠금 파일을 열 수 없음: $FL"
    return 1
  fi
  while :; do
    # macOS lockf의 FD 경로는 -t가 양수이면 sleep 없이 LOCK_NB를 반복한다.
    # 한 번만 시도하고 셸에서 쉰다. flock 파일·FD는 재시도 사이에도 그대로 유지한다.
    "$LOCKF" -s -t 0 9
    rc=$?
    [ "$rc" = 0 ] && break
    if [ "$rc" != 75 ]; then
      exec 9>&-
      say "lockf 실패 ($rc): $FL"
      return 1
    fi
    if [ $((SECONDS - warned_at)) -ge 60 ]; then
      say "대기열 잠금을 기다리는 중: $FL"
      warned_at="$SECONDS"
    fi
    # 100→200→400→500ms + 같은 범위 jitter, 최대 1초. bash 3.2 내장만 쓴다.
    wait_ms=$((backoff + RANDOM % (backoff + 1)))
    printf -v wait_seconds '%d.%03d' "$((wait_ms / 1000))" "$((wait_ms % 1000))"
    if ! sleep "$wait_seconds" 9>&-; then
      exec 9>&-
      say "대기열 잠금 재시도 대기 실패: $FL"
      return 1
    fi
    backoff=$((backoff * 2))
    [ "$backoff" -le 500 ] || backoff=500
  done
  LOCKED=1
  edit_lock
}

# 구버전(mkdir 편집 lock)이 같은 경로를 쓰지 못하게 표지 파일을 만든다. 표지 파일은 flock을 가진 쪽만 만든다.
# set -C는 O_EXCL로 열어 경로에 무엇이든(디렉터리 포함) 있으면 실패한다. ln -s는 경로가 디렉터리면 그 안에 링크를 만들어 쓰지 않는다.
edit_mark() { (set -C; printf '%s\n' "$MYMARK" >"$EL") 2>/dev/null; }
# 남아 있는 표지 내용. 수동으로 만든 링크도 같은 형식으로 읽는다.
mark_read() { if [ -L "$EL" ]; then readlink "$EL"; else head -1 "$EL"; fi 2>/dev/null; }
edit_lock() {
  local mark owner pid since="$SECONDS" warned=0
  MYMARK="yw-heavy-v2:pid=$$:task=${ID:--}"
  while ! edit_mark; do
    if [ -L "$EL" ] || { [ -f "$EL" ] && [ ! -d "$EL" ]; }; then
      # 지금 flock을 내가 가졌으므로 표지를 만든 쪽은 이미 끝났다.
      mark="$(mark_read)"
      rm -f "$EL"
      pid="$(printf '%s' "$mark" | sed -nE 's/.*:pid=([0-9]+).*/\1/p')"
      note "reclaim kind=edit task=$(printf '%s' "$mark" | sed -nE 's/.*:task=(.*)$/\1/p') pid=${pid:--} start=- reason=stale-edit-mark"
      continue
    fi
    if [ -d "$EL" ]; then
      # 구버전 enqueue·release가 쓰는 중이다. owner pid는 그 프로세스 자신이라 정확하다. 사망이 확정될 때만 지운다.
      owner="$(cat "$EL/owner.txt" 2>/dev/null)"
      pid="$(edit_owner_field "$owner" pid)"
      if [ -n "$pid" ] && [ "$(proc_state "$pid")" = dead:esrch ]; then
        if [ "$(cat "$EL/owner.txt" 2>/dev/null)" = "$owner" ]; then
          rm -f "$EL/owner.txt"
          rmdir "$EL" 2>/dev/null &&
            note "reclaim kind=edit task=$(edit_owner_field "$owner" task) pid=$pid start=- reason=legacy-edit-esrch"
        fi
        continue
      fi
    fi
    # 살아 있거나 판단할 수 없다(owner.txt 없음 등). 보존하고 다시 본다.
    if [ "$warned" = 0 ] && [ $((SECONDS - since)) -ge "$EDIT_WARN" ]; then
      warned=1
      say "편집 lock이 ${EDIT_WARN}초 넘게 남아 있습니다: $EL → yw-heavy status, 수동 처리는 agents/heavy-queue.md"
    fi
    sleep "$EDIT_POLL" 9>&-
  done
}

unlock_queue() {
  if [ "$LOCKED" = 1 ] && [ -f "$EL" ] && [ ! -L "$EL" ] && [ "$(head -1 "$EL" 2>/dev/null)" = "$MYMARK" ]; then
    rm -f "$EL"
  fi
  LOCKED=0
  exec 9>&-
}

# ---- 회수 (queue lock 아래에서만) ---------------------------------------------

# reclaim_dead [보호할 ID]: 사망이 확정된 실행 lock holder와 v2 대기 줄을 지운다.
# 보호할 ID는 같은 ID 재시도가 이어받을 줄이다. 그 줄은 지우지 않고 위치를 유지한다.
reclaim_dead() {
  local protect="${1:-}" owner task holder hs st age drop='' l id pid start kept='' changed=0
  [ -e "$NR" ] && return 0
  owner="$(owner_read)"
  task="$(json_str "$owner" task)"
  holder="$(json_num "$owner" holder)"
  # 구형식 owner(pid가 ${PPID}라 믿을 수 없음)·zsh 형식·holder 없는 lock은 회수하지 않는다.
  # owner 없는 실행 lock: 실행 lock을 만들거나 지우던 프로세스가 그 사이에 끝났다. 새 버전은 flock 아래에서만 만들고 지우며,
  # 관문이 열려 있으면 구버전 acquire가 mkdir과 owner 기록 사이에 있을 수 없다. 그래도 한동안 바뀌지 않은 것만 지운다.
  if [ -z "$owner" ] && age="$(ownerless_age)" && [ "$age" -ge "$OWNERLESS_AGE" ] && gate_open; then
    rm -f "$XL/owner.txt"
    rmdir "$XL" 2>/dev/null && note "reclaim kind=exec task=- pid=- start=- reason=ownerless-stale age=${age}s"
  fi
  if [ -n "$holder" ] && owner_v2 "$owner" && gate_open; then
    hs="$(json_str "$owner" holderStart)"
    st="$(proc_state "$holder" "${hs:--}")"
    case "$st" in
      dead:*)
        if [ "$(owner_read)" = "$owner" ]; then
          rm -f "$XL/owner.txt"
          if rmdir "$XL" 2>/dev/null; then
            note "reclaim kind=exec task=$task pid=$holder start=${hs:--} reason=${st#dead:}"
            [ "$task" = "$protect" ] || drop="$task"
            task=''
          fi
        fi
        ;;
    esac
  fi
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    id="$(line_id "$l")"
    if [ -n "$drop" ] && [ "$id" = "$drop" ]; then
      changed=1
      continue
    fi
    # 실행 lock을 가진 ID의 줄은 실행 lock을 회수할 때만 함께 지운다.
    if is_v2 "$l" && [ "$id" != "$task" ] && [ "$id" != "$protect" ]; then
      pid="$(lf "$l" pid)"
      start="$(lf "$l" start)"
      st="$(proc_state "$pid" "${start:--}")"
      case "$st" in
        dead:*)
          note "reclaim kind=line task=$id pid=$pid start=${start:--} reason=${st#dead:}"
          changed=1
          continue
          ;;
      esac
    fi
    kept="$kept$l
"
  done <<EOF
$(q_lines)
EOF
  [ "$changed" = 0 ] || q_write "${kept%
}"
}

# ---- 명령 ---------------------------------------------------------------------

# 대기 주기. run에서 신호를 받았으면 자기 줄을 지우고 신호 종료 코드를 돌려준다.
pause_poll() {
  sleep "$POLL" 9>&-
  [ -z "$SIG" ] && return 0
  if lock_queue; then
    [ "$(lf "$(q_line "$ID")" pid)" = "$$" ] && q_drop "$ID"
    unlock_queue
  fi
  sig_code
}
sig_code() {
  case "$SIG" in
    INT) return 130 ;;
    HUP) return 129 ;;
    *) return 143 ;;
  esac
}

write_owner() {
  local json
  json="{\"pid\":${HOLDER:-$PPID},\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"supervisor\":\"$(json_esc "$SUP")\""
  json="$json,\"task\":\"$(json_esc "$ID")\",\"worker\":\"$(json_esc "$WORKER")\",\"cwd\":\"$(json_esc "$PWD")\",\"v\":2"
  if [ -n "$HOLDER" ]; then
    json="$json,\"holder\":$HOLDER"
    [ "$HOLDER_START" = - ] || json="$json,\"holderStart\":\"$HOLDER_START\""
  fi
  printf '%s%s}\n' "$json" "$(override_owner_field)" >"$XL/owner.txt"
}

holder_dead() {
  [ -n "$HOLDER" ] || return 1
  case "$(proc_state "$HOLDER" "$HOLDER_START")" in dead:*) return 0 ;; esac
  return 1
}

do_acquire() {
  local registered=0 l pid start head capped=0 last_note="$SECONDS"
  while :; do
    lock_queue || return 1
    if holder_dead; then
      [ "$registered" = 0 ] || [ "$(lf "$(q_line "$ID")" pid)" != "$$" ] || q_drop "$ID"
      unlock_queue
      say "$ID: holder ${HOLDER}가 끝나 대기를 그만둡니다"
      return 3
    fi
    if [ "$registered" = 0 ]; then
      if [ "$(mode_read)" = round-robin ]; then unlock_queue; rr_acquire; return $?; fi
      if [ -e "$PAUSED" ]; then unlock_queue; say "신규 제출이 중지됐습니다"; return 4; fi
      reclaim_dead "$ID"
      if [ "$(json_str "$(owner_read)" task)" = "$ID" ]; then
        unlock_queue
        say "$ID: 이미 차례를 가진 ID입니다. 끝났으면 yw-heavy release $ID"
        return 3
      fi
      l="$(q_line "$ID")"
      if [ -n "$l" ]; then
        if ! is_v2 "$l"; then
          unlock_queue
          say "$ID: 같은 ID의 구버전 대기 줄이 있어 이어받지 않습니다. 그 대기자가 끝났으면 yw-heavy release $ID"
          return 3
        fi
        # 같은 ID 재시도: 위치는 그대로 두고 대기자만 바꾼다. 이전 대기자는 자기 pid가 사라진 것을 보고 끝난다.
        pid="$(lf "$l" pid)"
        start="$(lf "$l" start)"
        if ! q_set_ps "$ID" "$$" "$MYSTART"; then
          unlock_queue
          return 1
        fi
        [ "${pid:--}" = - ] || note "takeover task=$ID pid=$pid start=${start:--} state=$(proc_state "$pid" "${start:--}")"
        registered=1
      elif [ "$(sup_count)" -ge 2 ]; then
        unlock_queue
        [ "$capped" = 1 ] || say "$ID: 감독자 ${SUP}의 대기 줄이 이미 2개라 자리가 날 때까지 기다립니다"
        capped=1
        pause_poll || return $?
        continue
      else
        if ! q_append "$ID worker=$WORKER supervisor=$SUP v=2 pid=$$ start=$MYSTART"; then
          unlock_queue
          return 1
        fi
        registered=1
      fi
    else
      reclaim_dead
      l="$(q_line "$ID")"
      if [ -z "$l" ]; then
        unlock_queue
        say "$ID: 대기 줄이 지워져 대기를 그만둡니다 (entry removed)"
        return 3
      fi
      pid="$(lf "$l" pid)"
      if [ "$pid" != "$$" ]; then
        unlock_queue
        say "$ID: 같은 ID의 다른 대기자가 자리를 이어받아 대기를 그만둡니다 (superseded by pid $pid)"
        return 3
      fi
    fi
    head="$(line_id "$(q_lines | head -1)")"
    if [ "$head" = "$ID" ] && holder_dead; then
      q_drop "$ID"
      unlock_queue
      say "$ID: holder ${HOLDER}가 끝나 대기를 그만둡니다"
      return 3
    fi
    if [ "$head" = "$ID" ] && mkdir "$XL" 2>/dev/null; then
      if ! write_owner; then
        rm -f "$XL/owner.txt"
        rmdir "$XL" 2>/dev/null
        unlock_queue
        say "$ID: 실행 lock owner를 쓰지 못했습니다: $XL"
        return 1
      fi
      # 줄은 언제나 "이 항목이 끝났는지 판단할 프로세스"를 가리킨다. 획득 뒤에는 holder다.
      if [ -n "$HOLDER" ]; then q_set_ps "$ID" "$HOLDER" "$HOLDER_START"; else q_set_ps "$ID" - -; fi
      unlock_queue
      HELD=1
      return 0
    fi
    unlock_queue
    if [ $((SECONDS - last_note)) -ge 600 ]; then
      last_note="$SECONDS"
      say "waiting $ID: $(q_lines | awk -v id="$ID" '$1 == id { k = NR } END { print k "/" NR }'), head=${head:--}, lock=$(json_str "$(owner_read)" task)"
    fi
    pause_poll || return $?
  done
}

# 차례를 내려놓는다: 실행 lock(그 ID의 것일 때)과 그 ID의 줄.
# 실행 lock을 지우지 못했으면 줄만 지웠다고 알리고 1을 돌려준다.
release_id() {
  local rc=0
  lock_queue || return 1
  if [ "$(json_num "$(owner_read)" v)" = 3 ] || [ "$(lf "$(q_line "$ID")" v)" = 3 ]; then
    unlock_queue; say "v3 차례는 세대·token·lease로 해제해야 합니다"; return 6
  fi
  if [ "$(json_str "$(owner_read)" task)" = "$ID" ]; then
    rm -f "$XL/owner.txt"
    if ! rmdir "$XL" 2>/dev/null; then
      say "$ID: 실행 lock을 지우지 못했습니다 (${XL}에 다른 파일이 있음). 대기 줄만 지웠습니다"
      rc=1
    fi
  elif [ -d "$XL" ] && [ ! -s "$XL/owner.txt" ]; then
    say "$ID: owner 없는 실행 lock이 남아 있어 누구 것인지 알 수 없습니다. 대기 줄만 지웠습니다 (yw-heavy status, agents/heavy-queue.md)"
  fi
  [ -z "$(q_line "$ID")" ] || q_drop "$ID"
  unlock_queue
  HELD=0
  return "$rc"
}

# 구버전 acquire가 "$0" enqueue로 부를 때: 대기자는 부모인 구 acquire라 pid 없는 구형식 줄을 쓴다.
do_enqueue_legacy() {
  while :; do
    lock_queue || return 1
    if [ "$(mode_read)" != compat ] || [ -e "$PAUSED" ]; then
      unlock_queue; say "구버전 enqueue를 받지 않습니다"; return 4
    fi
    reclaim_dead
    if [ -n "$(q_line "$ID")" ]; then
      unlock_queue
      break
    fi
    if [ "$(sup_count)" -lt 2 ]; then
      q_append "$ID worker=$WORKER supervisor=$SUP" || { unlock_queue; return 1; }
      unlock_queue
      break
    fi
    unlock_queue
    sleep "$POLL"
  done
  echo "enqueued $ID"
}

do_run() {
  local rc
  # bash는 전경 자식이 끝난 뒤에 trap을 실행한다. 신호를 받아도 명령이 끝날 때까지 차례를 유지한다.
  trap 'SIG=TERM' TERM
  trap 'SIG=INT' INT
  trap 'SIG=HUP' HUP
  trap '[ "$HELD" = 0 ] || finish_release' EXIT
  HOLDER="$$"
  HOLDER_START="$MYSTART"
  do_acquire || return $?
  say "ACQUIRED $ID"
  if [ -n "$SIG" ]; then
    finish_release
    sig_code
    return
  fi
  if [ -n "$GEN" ]; then
    YW_HEAVY_GENERATION="$GEN" YW_HEAVY_TOKEN="$TOKEN" "$@" 9>&-
  else
    "$@" 9>&-
  fi
  rc=$?
  EXIT_CODE="$rc"
  finish_release
  if [ -n "$SIG" ]; then
    sig_code
    return
  fi
  return "$rc"
}

do_status() {
  local l n=0 legacy=0 id pid start st owner task holder hs target age
  printf '모드: %s, 신규 제출: ' "$(mode_read)"
  if [ -e "$PAUSED" ]; then printf '중지\n'; else printf '허용\n'; fi
  if [ "$(mode_read)" = round-robin ]; then printf '감독자 순환: %s\n' "$(ring_read | tr '\n' ' ')"; fi
  printf '대기열: %s\n' "$Q"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    n=$((n + 1))
    id="$(line_id "$l")"
    if is_v2 "$l"; then
      pid="$(lf "$l" pid)"
      start="$(lf "$l" start)"
      if [ "${pid:--}" = - ]; then st='holder 없음 (자동 회수 안 함)'; else st="pid $pid $(proc_state "$pid" "${start:--}")"; fi
      printf '  %d. %s  v%s  %s  [%s]\n' "$n" "$id" "$(lf "$l" v)" "$(lf "$l" supervisor)" "$st"
    else
      legacy=$((legacy + 1))
      printf '  %d. %s  구형식  %s  [생존 판정 불가]\n' "$n" "$id" "$(lf "$l" supervisor)"
    fi
  done <<EOF
$(q_lines)
EOF
  [ "$n" -gt 0 ] || printf '  (비어 있음)\n'

  if [ -e "$XL" ]; then
    owner="$(owner_read)"
    task="$(json_str "$owner" task)"
    holder="$(json_num "$owner" holder)"
    hs="$(json_str "$owner" holderStart)"
    if [ -z "$owner" ] && [ -e "$NR" ]; then
      printf '실행 lock: %s (owner 없음, %s초 전 변경). 회수가 꺼져 있어 자동 회수하지 않음\n' "$XL" "$(ownerless_age || echo '?')"
    elif [ -z "$owner" ]; then
      printf '실행 lock: %s (owner 없음, %s초 전 변경). 관문이 열려 있고 %s초가 지나면 자동 회수\n' "$XL" "$(ownerless_age || echo '?')" "$OWNERLESS_AGE"
    elif printf '%s' "$owner" | grep -q '"PID"'; then
      printf '실행 lock: %s (zsh 형식, 자동 회수 안 함)\n' "$owner"
    elif ! owner_v2 "$owner"; then
      printf '실행 lock: task=%s pid=%s (구형식, 자동 회수 안 함)\n' "$task" "$(json_num "$owner" pid)"
    elif [ -z "$holder" ]; then
      printf '실행 lock: task=%s (v2, holder 없음, 자동 회수 안 함)\n' "$task"
    else
      printf '실행 lock: task=%s holder=%s %s\n' "$task" "$holder" "$(proc_state "$holder" "${hs:--}")"
    fi
  else
    printf '실행 lock: 없음\n'
  fi

  if [ -L "$EL" ] || { [ -f "$EL" ] && [ ! -d "$EL" ]; }; then
    target="$(mark_read)"
    pid="$(printf '%s' "$target" | sed -nE 's/.*:pid=([0-9]+).*/\1/p')"
    printf '편집 lock: %s (pid %s %s)\n' "${target:-내용 없음}" "${pid:--}" "$(proc_state "$pid")"
  elif [ -d "$EL" ]; then
    age=$(($(date +%s) - $(stat -f %m "$EL" 2>/dev/null || date +%s)))
    owner="$(cat "$EL/owner.txt" 2>/dev/null)"
    if [ -n "$owner" ]; then
      pid="$(edit_owner_field "$owner" pid)"
      printf '편집 lock: 구형식 %s (pid %s %s, %d초)\n' "$owner" "${pid:--}" "$(proc_state "$pid")" "$age"
    else
      printf '편집 lock: 구형식, owner.txt 없음 (%d초). 2분 넘게 남으면 agents/heavy-queue.md 수동 처리\n' "$age"
    fi
  elif [ -e "$EL" ]; then
    printf '편집 lock: 알 수 없는 파일 %s\n' "$EL"
  else
    printf '편집 lock: 없음\n'
  fi

  if [ -e "$NR" ]; then
    printf '회수: 꺼짐 (%s 있음)\n' "$NR"
  elif [ "$legacy" -gt 0 ]; then
    printf '관문: 닫힘 (구형식 줄 %d개). 실행 lock은 자동 회수하지 않음\n' "$legacy"
  else
    printf '관문: 열림\n'
  fi
  if [ -s "$LOG" ]; then
    printf '최근 기록 (%s):\n' "$LOG"
    tail -5 "$LOG" | sed 's/^/  /'
  fi
  return 0
}

# ID·worker·supervisor는 줄의 한 단어이자 JSON 문자열이다.
valid_word() {
  case "$1" in
    '' | -* | *[[:space:][:cntrl:]\\\"]*) return 1 ;;
  esac
  return 0
}
need_task() {
  local name
  for name in "$@"; do
    valid_word "$name" && continue
    usage >&2
    say "ID·worker·supervisor는 비어 있지 않고 공백·따옴표·역슬래시가 없으며 -로 시작하지 않아야 합니다: '$name'"
    return 2
  done
}

# ---- v3: 명시적으로 활성화하는 단일 세대·감독자 순환 --------------------------
# 기본 모드는 계속 v2 FIFO다. 제어 명령도 기존 편집 잠금 아래에서 직렬화한다.
mode_read() { if [ -f "$MODE" ]; then cat "$MODE"; else printf compat; fi; }
capabilities() {
  printf '{"protocol":3,"mode":"%s","paused":%s,"capabilities":["lease-json","generation-release","token-reentry","ancestor-reentry","supervisor-round-robin","events-jsonl"]}\n' \
    "$(mode_read)" "$(if [ -e "$PAUSED" ]; then echo true; else echo false; fi)"
}
control() {
  local cmd="$1" target="${2:-}" tmp
  if [ "$cmd" = mode ] && [ $# = 1 ]; then mode_read; echo; return; fi
  case "$cmd:$#:$target" in reclaim:1: | pause:1: | resume:1: | mode:2:compat | mode:2:round-robin) ;;
    *) usage >&2; return 2 ;; esac
  lock_queue || return 1
  case "$cmd" in
    reclaim)
      if [ "$(mode_read)" = round-robin ]; then rr_reclaim && ring_sync; else reclaim_dead; fi
      ;;
    pause) (umask 077; touch "$PAUSED") ;;
    resume) rm -f "$PAUSED" ;;
    mode)
      if [ ! -e "$PAUSED" ] || [ -n "$(q_lines)" ] || [ -e "$XL" ]; then
        unlock_queue; say "전환 거절: pause 후 실행·대기자(구버전 포함)를 모두 drain해야 합니다"; return 4
      fi
      tmp="$(mktemp "$MODE.tmp.XXXXXX")" || { unlock_queue; return 1; }
      if ! { printf '%s\n' "$target" >"$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$MODE"; }; then
        rm -f "$tmp"; unlock_queue; return 1
      fi
      rm -f "$RING"
      ;;
  esac
  local rc=$?
  unlock_queue
  return "$rc"
}
random_id() { /usr/bin/openssl rand -hex 24; }
# 검증에는 시작 시각이 반드시 필요하다. 조회 실패를 재진입 허용으로 바꾸지 않는다.
verified_process() {
  [ -n "$2" ] && [ "$2" != - ] && [ "$(proc_state "$1" "$2")" = alive ] &&
    [ "$(proc_start "$1")" = "$2" ]
}
is_ancestor() {
  local target="$1" start="$2" pid="$$" parent n=0
  verified_process "$target" "$start" || return 1
  while [ "$n" -lt 128 ]; do
    [ "$pid" != "$target" ] || return 0
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null)" || return 1
    parent="$(printf '%s' "$parent" | tr -d ' ')"
    case "$parent" in '' | 0 | *[!0-9]*) return 1 ;; esac
    [ "$parent" != "$pid" ] || return 1
    pid="$parent"; n=$((n + 1))
  done
  return 1
}
lease_response() {
  printf '{"protocol":3,"requestId":"%s","generation":"%s","token":"%s","lease":"%s","borrowed":%s}\n' \
    "$(json_esc "$ID")" "$GEN" "$TOKEN" "$LEASE" "$BORROWED"
}
# 0 빌림, 1 일반 제출, 6 만료/잘못된 상속. queue lock 아래에서만 읽는다.
try_borrow() {
  local owner="$1" holder start
  holder="$(json_num "$owner" holder)"; start="$(json_str "$owner" holderStart)"
  if [ -n "$IN_GEN$IN_TOKEN" ]; then
    if [ "$(json_num "$owner" v)" != 3 ] || [ "$IN_GEN" != "$(json_str "$owner" generation)" ] ||
       [ "$IN_TOKEN" != "$(json_str "$owner" token)" ] || ! verified_process "$holder" "$start"; then
      say "만료됐거나 검증할 수 없는 재진입 token"; return 6
    fi
  elif [ "$(json_num "$owner" v)" != 3 ] || ! is_ancestor "$holder" "$start"; then
    return 1
  fi
  GEN="$(json_str "$owner" generation)" TOKEN="$(json_str "$owner" token)"
  LEASE="b-$(random_id)" || return 6
  BORROWED=true HELD=1
  return 0
}
# 기록에는 token·lease·환경·명령·worker·cwd를 넣지 않는다. 시간 단위는 초다.
event() {
  local kind="$1" id="$2" gen="$3" sup="$4" queued="$5" started="$6" code="${7:-unknown}" signal="${8:-unknown}" now wait=0 held=0
  now="$(date +%s)"
  case "$queued:$started" in *[!0-9:]*) ;; *)
    if [ "$started" -gt 0 ]; then wait=$((started - queued)); held=$((now - started)); else wait=$((now - queued)); fi ;;
  esac
  [ "$wait" -ge 0 ] || wait=0; [ "$held" -ge 0 ] || held=0
  (umask 077; printf '{"event":"%s","at":%s,"requestId":"%s","generation":"%s","supervisor":"%s","waitSeconds":%s,"heldSeconds":%s,"exitCode":"%s","signal":"%s"}\n' \
      "$kind" "$now" "$(json_esc "$id")" "$gen" "$(json_esc "$sup")" "$wait" "$held" "$code" "$signal" >>"$EVENTS") 2>/dev/null || say "작업 이벤트를 기록하지 못했습니다"
}
line_event() { event "$1" "$(line_id "$2")" "$(lf "$2" generation)" "$(lf "$2" supervisor)" "$(lf "$2" queued)" 0 unknown "${3:-unknown}"; }
owner_event() { event "$1" "$(json_str "$2" task)" "$(json_str "$2" generation)" "$(json_str "$2" supervisor)" "$(json_num "$2" queued)" "$(json_num "$2" started)" "${3:-unknown}" "${4:-unknown}"; }
# ring은 실행 중 감독자를 포함한다. 그 차례가 끝날 때만 남은 작업이 있으면 끝으로 돌린다.
ring_read() { cat "$RING" 2>/dev/null; return 0; }
ring_write() {
  local tmp
  tmp="$(mktemp "$RING.tmp.XXXXXX")" || return 1
  { if [ -n "$1" ]; then printf '%s\n' "$1"; fi; } >"$tmp"
  chmod 600 "$tmp" && mv -f "$tmp" "$RING"
}
# 큐·owner가 원장이다. 두 파일의 mv 사이 종료돼도 기존 순환 순서는 보존하고,
# 누락된 감독자는 큐 등록 순서대로 끝에 붙이며 더 이상 참여하지 않는 감독자는 뺀다.
ring_sync() {
  local active cur next
  active="$(json_str "$(owner_read)" supervisor)"
  cur="$(ring_read)"
  # macOS awk는 -v의 실제 줄바꿈을 거절하므로 순환 목록도 표지와 함께 stdin으로 전달한다.
  next="$( { printf '%s\n' "$cur" | sed 's/^/R /'; q_lines | sed 's/^/Q /'; } | awk -v active="$active" '
    $1=="R" { old[++n]=$2; next }
    {
      sup=""; version=""
      for (i=3;i<=NF;i++) {
        if ($i ~ /^supervisor=/) sup=substr($i,12)
        if ($i ~ /^v=/) version=substr($i,3)
      }
      if (version==3 && sup!="" && !pending[sup]++) order[++count]=sup
    }
    END {
      for (i=1;i<=n;i++) {
        sup=old[i]
        if (sup!="" && (sup==active || pending[sup]) && !seen[sup]++) print sup
      }
      if (active!="" && !seen[active]++) print active
      for (i=1;i<=count;i++) if (!seen[order[i]]++) print order[i]
    }')" || return 1
  [ "$cur" != "$next" ] || return 0
  ring_write "$next"
}
ring_rotate() {
  local cur
  cur="$(ring_read | awk -v s="$1" '$0 != s')"
  if q_lines | awk -v s="supervisor=$1" '{ for (i=2;i<=NF;i++) if ($i==s) found=1 } END { exit !found }'; then
    cur="${cur:+$cur
}$1"
  fi
  ring_write "$cur"
}
rr_head() {
  local s l
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    l="$(q_lines | awk -v s="supervisor=$s" '{ for(i=2;i<=NF;i++) if($i==s) {print $1; exit} }')"
    if [ -n "$l" ]; then printf '%s' "$l"; return; fi
  done <<EOF_RING
$(ring_read)
EOF_RING
}
rr_reclaim() {
  local protect="${1:-}" owner holder start state l id age
  [ ! -e "$NR" ] || return 0
  owner="$(owner_read)"
  if [ "$(json_num "$owner" v)" = 3 ]; then
    holder="$(json_num "$owner" holder)" start="$(json_str "$owner" holderStart)"
    state="$(proc_state "$holder" "$start")"
    case "$state" in dead:*)
      [ "$(ls -A "$XL" | wc -l | tr -d ' ')" = 1 ] || return 0
      rm -f "$XL/owner.txt" || return 1
      if ! rmdir "$XL" 2>/dev/null; then say "사망한 holder의 실행 lock을 회수하지 못했습니다: $XL"; return 1; fi
      owner_event reclaim "$owner"
      ring_rotate "$(json_str "$owner" supervisor)" || return 1
      ;;
    esac
  elif [ -z "$owner" ] && [ -d "$XL" ]; then
    # owner 파일을 열고 쓰기 전에 끝나면 0바이트 파일도 남는다. v2와 같은 유예·관문을 적용한다.
    age="$(ownerless_age)" || return 1
    if [ "$age" -ge "$OWNERLESS_AGE" ] && gate_open; then
      if ! { rm -f "$XL/owner.txt" && rmdir "$XL"; } 2>/dev/null; then
        say "owner 없는 실행 lock을 회수하지 못했습니다: $XL"; return 1
      fi
      note "reclaim kind=exec task=- pid=- start=- reason=ownerless-stale age=${age}s"
    fi
  fi
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    id="$(line_id "$l")"
    [ "$id" != "$protect" ] || continue
    [ "$(lf "$l" v)" = 3 ] || continue
    state="$(proc_state "$(lf "$l" pid)" "$(lf "$l" start)")"
    case "$state" in dead:*)
      q_drop "$id" || return 1
      line_event reclaim "$l"
      # 남은 줄과 실행 owner를 기준으로 순환 목록을 복구한다.
      ;;
    esac
  done <<EOF_QUEUE
$(q_lines)
EOF_QUEUE
  return 0
}
rr_cancel() {
  local l
  l="$(q_line "$ID")"
  if [ "$(lf "$l" pid)" = "$$" ]; then
    q_drop "$ID" || return 1
    line_event cancel "$l" "${SIG:-unknown}"
    ring_sync
  fi
}
rr_acquire() {
  local registered=0 l owner rc count supcount now json head
  case "$MAX_SUP:$MAX_ALL" in *[!0-9:]* | :* | *: | 0:* | *:0) say "pending 한도는 양의 정수여야 합니다"; return 2 ;; esac
  # 장기 holder는 호출자의 조상이어야 하며 시작 시각을 검증할 수 있어야 한다.
  [ -n "$HOLDER" ] || { HOLDER="$PPID"; HOLDER_START="$(proc_start "$PPID")" || HOLDER_START=-; }
  is_ancestor "$HOLDER" "$HOLDER_START" || { say "holder의 조상 관계·시작 시각을 검증하지 못했습니다"; return 6; }
  while :; do
    lock_queue || return 1
    if [ "$(mode_read)" != round-robin ]; then unlock_queue; say "round-robin이 꺼져 있습니다"; return 4; fi
    if [ "$registered" = 0 ]; then
      owner="$(owner_read)"
      try_borrow "$owner"; rc=$?
      if [ "$rc" = 0 ]; then unlock_queue; return 0; fi
      if [ "$rc" != 1 ]; then unlock_queue; return "$rc"; fi
      if [ -e "$PAUSED" ]; then unlock_queue; say "신규 제출이 중지됐습니다"; return 4; fi
      rr_reclaim "$ID" || { unlock_queue; return 1; }
      # 회수 금지는 실행 lock·대기 줄에만 적용한다. 새 줄을 쓰기 전에 빈 감독자의 옛 위치를 없앤다.
      ring_sync || { unlock_queue; return 1; }
      if [ "$(json_str "$(owner_read)" task)" = "$ID" ]; then unlock_queue; say "이미 실행 중인 요청 ID"; return 3; fi
      l="$(q_line "$ID")"
      if [ -n "$l" ]; then
        if [ "$(lf "$l" v)" != 3 ] || [ "$(lf "$l" supervisor)" != "$SUP" ]; then
          unlock_queue; say "재시도 요청의 감독자·버전이 다릅니다"; return 3
        fi
        q_set_ps "$ID" "$$" "$MYSTART" || { unlock_queue; return 1; }
      else
        count="$(q_lines | awk 'END {print NR+0}')"; supcount="$(sup_count)"
        if [ "$count" -ge "$MAX_ALL" ] || [ "$supcount" -ge "$MAX_SUP" ]; then
          unlock_queue; say "pending 한도 초과: supervisor=$supcount/$MAX_SUP total=$count/$MAX_ALL"; return 5
        fi
        GEN="$(random_id)" || { unlock_queue; return 1; }
        now="$(date +%s)"
        l="$ID worker=$WORKER supervisor=$SUP v=3 pid=$$ start=$MYSTART generation=$GEN queued=$now"
        q_append "$l" || { unlock_queue; return 1; }
        line_event enqueue "$l"
      fi
      registered=1
    else
      rr_reclaim || { unlock_queue; return 1; }
    fi
    l="$(q_line "$ID")"
    if [ -z "$l" ] || [ "$(lf "$l" pid)" != "$$" ]; then unlock_queue; say "대기 줄이 제거되거나 다른 재시도가 이어받았습니다"; return 3; fi
    if [ -n "$SIG" ] || holder_dead; then
      rr_cancel; unlock_queue
      if [ -n "$SIG" ]; then sig_code; return; fi
      say "holder가 끝나 대기를 취소했습니다"; return 3
    fi
    # 구버전이 활성화 후 잘못 들어오면 새 구현은 보수적으로 멈춘다.
    if q_lines | awk '{ok=0; for(i=2;i<=NF;i++) if($i=="v=3") ok=1; if(!ok) bad=1} END{exit !bad}'; then
      rr_cancel; unlock_queue; say "활성 모드에 구버전 줄이 있어 획득을 거절합니다"; return 4
    fi
    ring_sync || { unlock_queue; return 1; }
    head="$(rr_head)"
    if [ "$head" = "$ID" ] && (umask 077; mkdir "$XL") 2>/dev/null; then
      GEN="$(lf "$l" generation)" TOKEN="$(random_id)" LEASE="r-$(random_id)" now="$(date +%s)"
      if [ -z "$TOKEN" ] || [ "$LEASE" = r- ]; then rmdir "$XL"; unlock_queue; return 1; fi
      json="{\"v\":3,\"pid\":$HOLDER,\"holder\":$HOLDER,\"holderStart\":\"$HOLDER_START\",\"task\":\"$(json_esc "$ID")\",\"supervisor\":\"$(json_esc "$SUP")\",\"generation\":\"$GEN\",\"token\":\"$TOKEN\",\"lease\":\"$LEASE\",\"queued\":$(lf "$l" queued),\"started\":$now$(override_owner_field)}"
      if ! { (umask 077; : >"$XL/owner.txt") && printf '%s\n' "$json" >"$XL/owner.txt" && q_drop "$ID"; }; then
        rm -f "$XL/owner.txt"; rmdir "$XL"; unlock_queue; return 1
      fi
      owner_event start "$json"
      BORROWED=false HELD=1
      unlock_queue; return 0
    fi
    unlock_queue
    sleep "$FAST_POLL" 9>&-
  done
}
rr_release() {
  local owner rc=0
  lock_queue || return 1
  owner="$(owner_read)"
  # 중복·오래된 세대 해제는 멱등 no-op이다. 사람이 붙인 ID로 해제하지 않는다.
  if [ "$(json_num "$owner" v)" != 3 ] || [ "$GEN" != "$(json_str "$owner" generation)" ]; then
    unlock_queue; HELD=0; return 0
  fi
  if [ -z "$TOKEN" ] || [ "$TOKEN" != "$(json_str "$owner" token)" ]; then
    unlock_queue; say "해제 token이 일치하지 않습니다"; return 6
  fi
  case "$LEASE" in
    b-*) unlock_queue; HELD=0; return 0 ;;
  esac
  if [ "$LEASE" != "$(json_str "$owner" lease)" ]; then unlock_queue; say "해제 lease가 일치하지 않습니다"; return 6; fi
  # 다른 파일이 있으면 owner를 보존한다. 실패한 해제를 다음 요청이 성공으로 오인하지 않는다.
  if [ "$(ls -A "$XL" | wc -l | tr -d ' ')" != 1 ]; then unlock_queue; say "실행 lock에 다른 파일이 있어 보존합니다"; return 1; fi
  rm -f "$XL/owner.txt"
  if rmdir "$XL" 2>/dev/null; then
    owner_event end "$owner" "$EXIT_CODE" "${SIG:-unknown}"
    ring_rotate "$(json_str "$owner" supervisor)" || rc=1
  else rc=1; fi
  unlock_queue; HELD=0; return "$rc"
}
finish_release() { if [ -n "$GEN" ]; then rr_release; else release_id; fi; }

main() {
  init
  local cmd="${1:-}" st
  [ $# -gt 0 ] && shift
  case "$cmd" in
    status) do_status; return ;;
    capabilities | version) capabilities; return ;;
    pause | resume | mode | reclaim) control "$cmd" "$@"; return ;;
    -h | --help | help) usage; return 0 ;;
    release)
      if [ $# = 6 ] && [ "$1" = --generation ] && [ "$3" = --token ] && [ "$5" = --lease ]; then
        GEN="$2" TOKEN="$4" LEASE="$6"
        rr_release; return
      fi
      [ $# = 1 ] || { usage >&2; return 2; }
      need_task "$1" || return
      ID="$1"
      release_id
      st=$?
      echo "released $ID"
      return "$st"
      ;;
  esac
  [ $# -ge 3 ] || { usage >&2; return 2; }
  need_task "$1" "$2" "$3" || return
  ID="$1" WORKER="$2" SUP="$3"
  shift 3
  case "$cmd" in acquire | run) verifier_guard || return $? ;; esac
  MYSTART="$(proc_start $$)" || MYSTART=-
  case "$cmd" in
    enqueue)
      [ $# = 0 ] || { usage >&2; return 2; }
      do_enqueue_legacy
      ;;
    acquire)
      if [ "${1:-}" = --json ]; then JSON=1; shift; fi
      if [ $# = 2 ] && [ "$1" = --holder ]; then
        case "$2" in '' | 0* | *[!0-9]*) usage >&2; say "--holder는 PID 숫자입니다: $2"; return 2 ;; esac
        HOLDER="$2"
        HOLDER_START="$(proc_start "$HOLDER")" || HOLDER_START=-
        st="$(proc_state "$HOLDER" "$HOLDER_START")"
        case "$st" in dead:*) say "holder ${HOLDER}가 이미 끝났습니다"; return 2 ;; esac
      elif [ $# != 0 ]; then
        usage >&2
        return 2
      fi
      if [ "$JSON" = 1 ] && [ "$(mode_read)" != round-robin ]; then
        say "기계 프로토콜은 round-robin 활성화 뒤에 사용합니다"; return 4
      fi
      if [ "$(mode_read)" = round-robin ]; then
        trap 'SIG=TERM' TERM; trap 'SIG=INT' INT; trap 'SIG=HUP' HUP
      fi
      do_acquire || return $?
      if [ -n "$GEN" ]; then lease_response; else echo "ACQUIRED $ID"; fi
      ;;
    run)
      [ "${1:-}" = -- ] && [ $# -ge 2 ] || { usage >&2; return 2; }
      shift
      do_run "$@"
      ;;
    *)
      usage >&2
      return 2
      ;;
  esac
}

# 같은 줄의 exit: main이 끝난 뒤 바뀐 파일의 나머지를 읽지 않는다.
main "$@"; exit $?
