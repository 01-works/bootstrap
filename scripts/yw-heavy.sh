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
#   v3 모드 $Q.mode (없으면 compat, 단 v3 대기·실행이 남아 있으면 round-robin), 신규 제출 중지 $Q.paused, 감독자 순환 $Q.rotation
#   v3 작업 이벤트 $Q.events (격리 대기열만 YW_HEAVY_EVENTS로 바꾼다), 내부 재확인 YW_HEAVY_FAST_POLL (.2초)
#   v3 사용 시간 비교 구간 3600초. 격리 대기열(테스트)만 YW_HEAVY_FAIR_WINDOW로 바꾼다 (0이면 순환 순서만)
#   v3 pending 한도 YW_HEAVY_MAX_PENDING_SUPERVISOR (128), YW_HEAVY_MAX_PENDING (1024)
#   /tmp 정리 방지 mtime 갱신 주기 YW_HEAVY_KEEP_EVERY (3600초), run 갱신 프로세스의 부모 확인 YW_HEAVY_KEEP_CHECK (20초)
#   owner 없는 실행 lock 회수까지 YW_HEAVY_OWNERLESS_AGE (60초), 구형식 편집 lock 경고까지 YW_HEAVY_EDIT_WARN (120초)
#   검증 자리 (verifier --shared) 대기열 $Q.verifier, 실행 lock $XL.verifier, 순환 $Q.verifier.rotation. 나머지 파일은 같이 쓴다

usage() {
  cat <<'EOF'
사용법:
  yw-heavy run <ID> <worker> <supervisor> -- <명령…>   권장. 명령이 실행되는 동안만 차례를 잡는다. 종료 코드는 명령의 것
  yw-heavy acquire <ID> <worker> <supervisor> [--holder PID]
                                                        차례가 오면 "ACQUIRED <ID>". holder가 끝나면 다른 대기자가 회수한다
  yw-heavy release <ID>                                 차례(그 ID의 것일 때)와 그 ID의 대기 줄을 지운다
  yw-heavy enqueue <ID> <worker> <supervisor>           구버전 acquire 호환 전용 (구형식 줄)
  yw-heavy status [--json]                              읽기 전용 상태 (--json은 화면·도구용)
  yw-heavy capabilities                                 JSON 프로토콜·현재 모드 (version도 동일)
  yw-heavy reclaim                                      확정 사망 항목만 회수 (pause 중 drain용)
  yw-heavy pause | resume                               신규 제출 중지·재개 (기존 대기는 drain)
  yw-heavy mode [compat|round-robin]                     조회·전환 (pause + 빈 대기열 필요)
  yw-heavy acquire <ID> <worker> <supervisor> --json [--holder PID]
                                                        v3 JSON lease (활성 모드 전용)
  yw-heavy release --generation G --token T --lease L    v3 세대별 해제 (빌린 lease는 no-op)
verifier 역할 기기: acquire·run은 supervisor=verifier-loop만 허용한다.
  예외: YW_HEAVY_VERIFIER_OVERRIDE_REASON='<사유>' (owner와 진단 로그에 기록)
  공유 역할(role add verifier --shared): 다른 요청도 허용. round-robin이면 verifier-loop는 별도 검증 자리 1개
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
  KEEP_EVERY="${YW_HEAVY_KEEP_EVERY:-3600}"
  KEEP_SECS="${KEEP_EVERY%.*}"
  KEEP_CHECK="${YW_HEAVY_KEEP_CHECK:-20}"
  # 구버전 편집 lock이 풀리기를 기다리는 주기. 1초보다 짧은 대기 주기(테스트)면 그것을 쓴다.
  case "$POLL" in 0* | .*) EDIT_POLL="$POLL" ;; *) EDIT_POLL=1 ;; esac
  LOCKF=/usr/bin/lockf
  ID='' WORKER='' SUP='' HOLDER='' HOLDER_START=- MYSTART=- MYMARK='' LOCKED=0 SIG='' HELD=0 KEPT_AT=-1 KEEPER=''
  ROLE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/roles/verifier"
  # 감독자가 켠 모드를 재시동 뒤에도 유지한다. /tmp가 비면 .mode가 없어 compat으로 돌아가기 때문이다.
  # 기본 대기열(경로로 판정: helper는 기본 경로를 YW_HEAVY_QUEUE로 넘긴다)에만 쓴다. 테스트·격리 대기열은 읽지도 쓰지도 않는다.
  # YW_HEAVY_DEFAULT_QUEUE는 테스트가 기본 대기열을 흉내 낼 때만 쓴다. 호출자마다 다를 수 있는 XDG_CONFIG_HOME 대신 $HOME 아래 고정 경로를 쓴다.
  case "$Q" in "${YW_HEAVY_DEFAULT_QUEUE:-/tmp/yw-heavy-queue}" | "/private${YW_HEAVY_DEFAULT_QUEUE:-/tmp/yw-heavy-queue}") SAVED="$HOME/.config/bootstrap/heavy-mode" ;; *) SAVED= ;; esac
  # 차례 계산의 구간·이벤트 파일이 대기자마다 다르면 서로 상대를 첫 차례로 계산해 빈 자리에서 아무도 시작하지 않는다.
  # 그래서 기본 대기열은 두 값을 호출자 환경에서 읽지 않는다.
  FAIR_WINDOW=3600
  if [ -n "$SAVED" ]; then EVENTS="$Q.events"
  else case "${YW_HEAVY_FAIR_WINDOW:-}" in '' | *[!0-9]* | 0?*) ;; *) FAIR_WINDOW="$YW_HEAVY_FAIR_WINDOW" ;; esac
  fi
  # 검증 자리: 일반 자리와 같은 코드를 대기열·실행 lock·순환 파일만 바꿔 쓴다. 편집 잠금·기록·모드·제출 중지는 공유한다.
  MQ="$Q" MXL="$XL" LQ="$Q.verifier" LXL="$XL.verifier"
}
use_lane() { Q="$LQ" XL="$LXL" RING="$LQ.rotation"; }
use_main() { Q="$MQ" XL="$MXL" RING="$MQ.rotation"; }
# 일반 파일만 읽는다 (FIFO 등에서 멈추지 않게).
role_shared() { [ -f "$ROLE_FILE" ] && grep -qx 'shared=1' "$ROLE_FILE" 2>/dev/null; }
lane_owner() { cat "$LXL/owner.txt" 2>/dev/null; }

# role.sh와 같은 상태 경로·파일 판정. 프로젝트별 ID 대신 기존 verifier 루프의 감독자 식별자를 쓴다.
verifier_guard() {
  [ -f "$ROLE_FILE" ] || return 0
  [ "$SUP" != verifier-loop ] || return 0
  # 공유 역할은 작업 기기를 겸한다. 다른 요청은 일반 대기열에서 기존처럼 차례를 받는다.
  ! role_shared || return 0
  # 기록은 한 줄로 유지한다. 제어 문자를 제거한 뒤에도 공백뿐이면 사유가 아니다.
  OVERRIDE_REASON="$(printf '%s' "${YW_HEAVY_VERIFIER_OVERRIDE_REASON:-}" | LC_ALL=C tr -d '\000-\037\177')"
  case "$OVERRIDE_REASON" in
    *[![:space:]]*) note "verifier-override task=$ID worker=$WORKER supervisor=$SUP reason=$OVERRIDE_REASON" ;;
    *) say "verifier 역할 기기는 supervisor=verifier-loop만 허용합니다. 예외에는 YW_HEAVY_VERIFIER_OVERRIDE_REASON에 사유가 필요합니다"; return 4 ;;
  esac
}

# rr_acquire의 첫 등록에서 편집 잠금 아래에서만 부른다.
# 검증 자리는 round-robin에서만 쓴다. compat 공유는 verifier-loop도 일반 대기열에서 함께 차례를 받는다
# (두 v2 대기열의 같은 ID 등록과 ID 해제가 어느 자리인지 모호해지는 것을 피한다).
# 기존 재진입 계약을 먼저 지킨다: 상속한 token의 세대 → 조상 holder → 새 획득은 supervisor로 정한다.
# 역할 파일을 읽지 못하면 공유가 아닌 것으로 본다 (기존 전용 동작).
lane_route() {
  local lo mo
  [ "$(mode_read)" = round-robin ] || return 0
  lo="$(lane_owner)"
  if [ -n "$IN_GEN" ]; then
    [ "$IN_GEN" != "$(json_str "$lo" generation)" ] || use_lane
    return 0
  fi
  if [ "$(json_num "$lo" v)" = 3 ] && is_ancestor "$(json_num "$lo" holder)" "$(json_str "$lo" holderStart)"; then
    use_lane; return 0
  fi
  mo="$(cat "$MXL/owner.txt" 2>/dev/null)"
  if [ "$(json_num "$mo" v)" = 3 ] && is_ancestor "$(json_num "$mo" holder)" "$(json_str "$mo" holderStart)"; then
    return 0
  fi
  [ "$SUP" = verifier-loop ] || return 0
  # 역할을 바꾸는 동안에도 verifier-loop 실행은 하나다. 다른 자리에 verifier-loop 실행·대기가 남아 있으면 그 자리에서 기다린다.
  if role_shared; then
    [ "$(json_str "$mo" supervisor)" = verifier-loop ] || (use_main; q_lines) | grep -q ' supervisor=verifier-loop ' || use_lane
  elif [ -n "$lo" ] || [ -s "$LQ" ]; then
    use_lane
  fi
}
# 해제할 ID가 검증 자리에 있는지 (실행 lock 또는 대기 줄).
lane_has_id() {
  [ "$(json_str "$(lane_owner)" task)" = "$ID" ] && return 0
  [ -n "$(use_lane; q_line "$ID")" ]
}
# 검증 쪽 CPU 우선순위를 낮춘다: 검증 자리를 직접 얻은 holder가 이 프로세스의 조상이면 nice 10으로 올린다.
# 이후 생기는 자식이 상속한다. 이미 10 이상이면 그대로 두고, 낮추지 않는다(낮추려면 root가 필요). 실패해도 차례는 유지한다.
lane_nice() {
  local n
  [ "$Q" = "$LQ" ] && [ -n "$HOLDER" ] && [ "$BORROWED" != true ] || return 0
  n="$(ps -o nice= -p "$HOLDER" 2>/dev/null | tr -d ' ')"
  case "$n" in '' | *[!0-9-]*) return 0 ;; esac
  [ "$n" -lt 10 ] && is_ancestor "$HOLDER" "$HOLDER_START" || return 0
  renice 10 -p "$HOLDER" >/dev/null 2>&1 || say "검증 holder ${HOLDER}의 우선순위를 낮추지 못했습니다"
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
    if [ "$rc" = 0 ]; then
      # 기다리는 동안 경로가 지워지고 새로 만들어졌으면 다른 inode의 잠금이다(#114). 같은 경로를 다시 연다.
      [ "$(stat -f %i /dev/fd/9 2>/dev/null)" != "$(stat -f %i "$FL" 2>/dev/null)" ] || break
      exec 9>&-
      if ! exec 9>>"$FL"; then
        exec 9>&-
        say "대기열 잠금 파일을 열 수 없음: $FL"
        return 1
      fi
      continue
    fi
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
    if sleep "$wait_seconds" 9>&-; then :; else
      rc=$?
      exec 9>&-
      # 그룹 신호는 전경 sleep도 끝낸다. 일반 sleep 오류로 바꾸지 않고 신호 코드를 전달한다.
      if [ "$rc" -gt 128 ]; then
        case "$rc" in 129) SIG=HUP ;; 130) SIG=INT ;; 143) SIG=TERM ;; esac
        return "$rc"
      fi
      say "대기열 잠금 재시도 대기 실패: $FL"
      return 1
    fi
    backoff=$((backoff * 2))
    [ "$backoff" -le 500 ] || backoff=500
  done
  LOCKED=1
  edit_lock || return
  state_keep
  mode_heal || say "모드 파일을 복원하지 못했습니다: $MODE"
  return 0
}

# macOS tmp_cleaner는 매일 0시에 atime·mtime·ctime이 모두 3일 넘은 /tmp 파일을 지운다(#114).
# APFS는 atime이 mtime보다 새로우면 읽어도 atime을 바꾸지 않아 읽기만 하는 상태 파일과 flock 파일이 지워진다.
# 잠금을 잡은 프로세스와 실행 중인 run이 주기마다 mtime을 갱신한다. 없는 파일은 만들지 않는다.
keep_paths() {
  touch -c "$FL" "$MQ" "$MXL/owner.txt" "$MQ.rotation" "$LQ" "$LXL/owner.txt" "$LQ.rotation" "$MODE" "$PAUSED" "$NR" "$LOG" "$EVENTS" 2>/dev/null 9>&- || true
}
state_keep() {
  [ "$KEPT_AT" -lt 0 ] || [ $((SECONDS - KEPT_AT)) -ge "${KEEP_SECS:-0}" ] || return 0
  KEPT_AT="$SECONDS"
  keep_paths
}
# 대기자가 없으면 run 동안 아무도 잠금을 잡지 않는다. 명령이 끝날 때까지 별도 프로세스가 갱신한다.
# 부모 확인은 YW_HEAVY_KEEP_CHECK(20초)마다 따로 한다. run이 SIGKILL되면 그 안에 끝난다.
keeper_start() {
  local parent="$$" last="$SECONDS"
  (
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    trap - INT HUP EXIT
    while :; do
      /bin/sleep "$KEEP_CHECK" & s=$!
      wait "$s"
      kill -0 "$parent" 2>/dev/null || exit 0
      [ $((SECONDS - last)) -ge "${KEEP_SECS:-0}" ] || continue
      last="$SECONDS"
      keep_paths
    done
  ) </dev/null >/dev/null 2>&1 9>&- &
  KEEPER=$!
}
keeper_stop() { [ -z "$KEEPER" ] || kill "$KEEPER" 2>/dev/null; KEEPER=''; }

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
    lock_queue || return $?
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
  lock_queue || return $?
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
    lock_queue || return $?
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
  trap 'keeper_stop; [ "$HELD" = 0 ] || finish_release' EXIT
  HOLDER="$$"
  HOLDER_START="$MYSTART"
  do_acquire || return $?
  lane_nice
  say "ACQUIRED $ID"
  if [ -n "$SIG" ]; then
    finish_release
    sig_code
    return
  fi
  keeper_start
  if [ -n "$GEN" ]; then
    YW_HEAVY_GENERATION="$GEN" YW_HEAVY_TOKEN="$TOKEN" "$@" 9>&-
  else
    "$@" 9>&-
  fi
  rc=$?
  keeper_stop
  EXIT_CODE="$rc"
  finish_release
  if [ -n "$SIG" ]; then
    sig_code
    return
  fi
  return "$rc"
}

# 현재 자리(Q·XL)의 대기 줄과 실행 lock을 보인다. 구형식 줄 수는 LEGACY에 남긴다.
# 지금 등록된 v3 줄이 실행될 순서 (읽기 전용). 줄 번호는 등록 순서라 round-robin의 실제 차례와 다르다.
# 최근 사용 시간이 적은 감독자부터, 같으면 ring_sync의 감독자 순서를 따른다. 실행 중 감독자는 해제 때 순환 끝으로 가고
# 지금 차례의 보유 시간이 더해진 값으로 비교한다. 이후 실행 시간은 모르므로 예상은 바뀔 수 있다. 나중에 등록되는 줄은 반영하지 않는다.
# $1은 회수될 줄(확정 사망)을 뺀 대기 줄. 회수가 꺼져 있거나 v3가 아닌 줄이 있으면 차례를 알 수 없어 표시하지 않는다.
rr_turns() {
  [ "$(mode_read)" = round-robin ] && [ ! -e "$NR" ] || return 0
  local owner
  owner="$(owner_read)"
  { printf 'A %s %s\n' "$(json_str "$owner" supervisor)" "$(json_num "$owner" started)"
    if [ -f "$RING" ]; then printf '%s\n' "$(ring_read)" | sed 's/^/R /'; fi
    rr_usage
    printf '%s\n' "$1" | grep . | sed 's/^/Q /'; } | awk -v now="$(date +%s)" -v fair="$FAIR_WINDOW" '
    $1=="A" { active=$2; if (fair>0 && $3 ~ /^[0-9]+$/ && now>$3) held=now-$3; next }
    $1=="R" { ring[++n]=$2; next }
    $1=="U" { used[$2]=$3; next }
    {
      sup=""; version=""
      for (i=3;i<=NF;i++) {
        if ($i ~ /^supervisor=/) sup=substr($i,12)
        if ($i ~ /^v=/) version=substr($i,3)
      }
      if (version!=3 || sup=="") next
      if (!count[sup]++) ring[++n]=sup
      job[sup,count[sup]]=$2; left++
    }
    END {
      for (i=1;i<=n;i++) if (ring[i]!=active && count[ring[i]] && !seen[ring[i]]++) order[++m]=ring[i]
      if (active!="" && count[active]) { order[++m]=active; used[active]+=held }
      # rr_head와 같은 선택을 반복한다. 앞으로의 실행 시간은 모르므로 더하지 않고, 받은 감독자는 순환 끝으로 보낸다.
      while (left>0) {
        k=0
        for (i=1;i<=m;i++) if (done[order[i]]<count[order[i]] && (k==0 || used[order[i]]+0 < used[order[k]]+0)) k=i
        sup=order[k]; out=out (out=="" ? "" : " ") job[sup,++done[sup]]; left--
        for (i=k;i<m;i++) order[i]=order[i+1]
        order[m]=sup
      }
      print out
    }'
}
status_slot() {
  local l n=0 id pid start st owner task holder hs turns queued='' other=0
  LEGACY=0
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    n=$((n + 1))
    id="$(line_id "$l")"
    if is_v2 "$l"; then
      pid="$(lf "$l" pid)"
      start="$(lf "$l" start)"
      if [ "${pid:--}" = - ]; then st='holder 없음 (자동 회수 안 함)'; else st="pid $pid $(proc_state "$pid" "${start:--}")"; fi
      printf '  %d. %s  v%s  %s  [%s]\n' "$n" "$id" "$(lf "$l" v)" "$(lf "$l" supervisor)" "$st"
      case "$(lf "$l" v):$st" in
        3:*' dead:'*) ;;
        3:*) queued="$queued$l
" ;;
        *) other=1 ;;
      esac
    else
      LEGACY=$((LEGACY + 1))
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
  # 기존 줄의 순서와 이웃 관계는 바꾸지 않는다.
  turns=''
  if [ "$LEGACY" = 0 ] && [ "$other" = 0 ]; then turns="$(rr_turns "$queued")"; fi
  [ -z "$turns" ] || printf '예상 차례: %s\n' "$(printf '%s' "$turns" | sed 's/ / → /g')"
}

# 화면·도구용 status. 사람이 읽는 status와 같은 판정이며 token·lease·세대·명령은 내보내지 않는다.
json_val() {
  if [ -n "$1" ]; then printf '"%s"' "$(json_esc "$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177')")"; else printf null; fi
}
num_val() { case "$1" in 0 | [1-9]*) case "$1" in *[!0-9]*) printf null ;; *) printf '%s' "$1" ;; esac ;; *) printf null ;; esac; }
slot_json() {
  local l id pid st v owner holder hs started queued='' other=0 waiting='' turns=null w running=''
  # compat은 실행 중인 줄을 release까지 큐에 남긴다. 실행 중인 작업을 대기로 다시 내지 않는다.
  [ ! -e "$XL" ] || running="$(json_str "$(owner_read)" task)"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    id="$(line_id "$l")" v="$(lf "$l" v)"
    [ -z "$running" ] || [ "$id" != "$running" ] || continue
    if is_v2 "$l"; then
      pid="$(lf "$l" pid)"
      if [ "${pid:--}" = - ]; then st=no-holder; else st="$(proc_state "$pid" "$(lf "$l" start)")"; fi
      case "$v:$st" in
        3:dead:*) ;;
        3:*) queued="$queued$l
" ;;
        *) other=1 ;;
      esac
    else
      st=legacy other=1 pid=''
    fi
    waiting="$waiting${waiting:+,}{\"id\":$(json_val "$id"),\"pid\":$(num_val "$pid"),\"supervisor\":$(json_val "$(lf "$l" supervisor)"),\"queued\":$(num_val "$(lf "$l" queued)"),\"state\":\"$st\"}"
  done <<EOF
$(q_lines)
EOF
  if [ "$other" = 0 ] && [ "$(mode_read)" = round-robin ] && [ ! -e "$NR" ]; then
    turns=''
    for w in $(rr_turns "$queued"); do turns="$turns${turns:+,}$(json_val "$w")"; done
    turns="[$turns]"
  fi
  printf '{"name":"%s","running":' "$1"
  if [ -e "$XL" ]; then
    owner="$(owner_read)"; holder="$(json_num "$owner" holder)"
    st=unknown
    if owner_v2 "$owner"; then
      if [ -z "$holder" ]; then st=no-holder
      else hs="$(json_str "$owner" holderStart)"; st="$(proc_state "$holder" "${hs:--}")"; fi
    fi
    started="$(json_num "$owner" started)"
    # v2 owner는 epoch 대신 startedAt(UTC)을 쓴다.
    [ -n "$started" ] || started="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$(json_str "$owner" startedAt)" +%s 2>/dev/null)"
    printf '{"id":%s,"pid":%s,"supervisor":%s,"queued":%s,"started":%s,"state":"%s"}' "$(json_val "$(json_str "$owner" task)")" "$(num_val "$holder")" \
      "$(json_val "$(json_str "$owner" supervisor)")" "$(num_val "$(json_num "$owner" queued)")" "$(num_val "$started")" "$st"
  else
    printf null
  fi
  printf ',"waiting":[%s],"turns":%s}' "$waiting" "$turns"
}
do_status_json() {
  local paused=false
  [ ! -e "$PAUSED" ] || paused=true
  printf '{"schema":1,"mode":%s,"paused":%s,"slots":[' "$(json_val "$(mode_read)")" "$paused"
  slot_json main
  if { role_shared && [ "$(mode_read)" = round-robin ]; } || [ -s "$LQ" ] || [ -e "$LXL" ]; then
    printf ,; use_lane; slot_json verifier; use_main
  fi
  printf ']}\n'
}

do_status() {
  local pid target age owner legacy
  printf '모드: %s, 신규 제출: ' "$(mode_read)"
  if [ -e "$PAUSED" ]; then printf '중지\n'; else printf '허용\n'; fi
  if [ "$(mode_read)" = round-robin ]; then printf '감독자 순환: %s\n' "$(ring_read | tr '\n' ' ')"; fi
  last_mode_change
  if role_shared && [ "$(mode_read)" = round-robin ]; then printf 'verifier 역할: 공유 (verifier-loop는 검증 자리, 다른 요청은 일반 대기열)\n'
  elif role_shared; then printf 'verifier 역할: 공유, 그러나 compat이라 검증 자리 없음 (verifier-loop도 일반 대기열, 동시 실행 안 함)\n'
  elif [ -f "$ROLE_FILE" ]; then printf 'verifier 역할: 전용 (verifier-loop만 허용)\n'; fi
  printf '대기열: %s\n' "$Q"
  status_slot
  legacy="$LEGACY"

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
  if { role_shared && [ "$(mode_read)" = round-robin ]; } || [ -s "$LQ" ] || [ -e "$LXL" ]; then
    printf '검증 자리: %s\n' "$LQ"
    use_lane; status_slot; use_main
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
# 기록의 마지막 mode-change·mode-restore 한 줄: 시각, from→to, 주체(전환은 호출 부모, 복원은 복원한 프로세스).
last_mode_change() {
  local l
  l="$(grep -E '^[^ ]+ mode-(change|restore) ' "$LOG" 2>/dev/null | tail -1)"
  if [ -z "$l" ]; then printf '마지막 모드 변경: 기록 없음\n'; return; fi
  printf '%s\n' "$l" | awk '{
    for (i = 3; i <= NF; i++) { split($i, kv, "="); v[kv[1]] = substr($i, length(kv[1]) + 2) }
    who = ("parent" in v) ? "parent=" v["parent"] : "by=" v["by"]
    printf "마지막 모드 변경: %s %s→%s 주체 %s (%s)\n", $1, v["from"], v["to"], who, $2
  }'
}
# compat 전환은 빈 대기열·실행 lock 부재에서만 하므로 v3 줄·owner가 남아 있으면 모드 파일만 사라진 것이다.
# 어느 자리에서 불러도 같은 판단이 되도록 일반 자리와 검증 자리를 함께 본다.
v3_active() {
  [ "$(json_num "$(cat "$MXL/owner.txt" 2>/dev/null)" v)" = 3 ] && return 0
  [ "$(json_num "$(lane_owner)" v)" = 3 ] && return 0
  { use_main; q_lines; use_lane; q_lines; } | awk '{for (i = 2; i <= NF; i++) if ($i == "v=3") f = 1} END {exit !f}'
}
# 파일이 있어도 읽지 못하거나 비어 있으면 없는 것과 같이 판단한다.
# 일반 파일이 아니면(FIFO 등) 읽다가 멈추지 않도록 읽지 않는다.
mode_file() { local m; [ -f "$MODE" ] && m="$(cat "$MODE" 2>/dev/null)" && [ -n "$m" ] && printf '%s' "$m"; }
saved_mode() {
  local m
  [ -n "$SAVED" ] && [ -f "$SAVED" ] && m="$(cat "$SAVED" 2>/dev/null)" || return 1
  case "$m" in compat | round-robin) printf '%s' "$m" ;; *) return 1 ;; esac
}
mode_read() {
  # 살아 있는 v3 상태가 저장값보다 앞선다(저장값이 compat이어도 v3 작업과 helper 자체 잠금이 겹치지 않게).
  mode_file || { v3_active && printf round-robin; } || saved_mode || printf compat
}
# 명시적 전환만 저장한다. 저장에 실패하면 전환은 유지하고 코드 1로 알린다.
save_mode() {
  local tmp
  [ -n "$SAVED" ] || return 0
  # 디렉터리 등 일반 파일이 아닌 것이 있으면 mv가 그 안에 넣고 성공하므로 거절한다.
  [ ! -e "$SAVED" ] || [ -f "$SAVED" ] || return 1
  mkdir -p "$(dirname "$SAVED")" && tmp="$(mktemp "$SAVED.tmp.XXXXXX")" || return 1
  if ! { printf '%s\n' "$1" >"$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$SAVED"; }; then rm -f "$tmp"; return 1; fi
}
mode_write() {
  local tmp
  tmp="$(mktemp "$MODE.tmp.XXXXXX")" || return 1
  if ! { printf '%s\n' "$1" >"$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$MODE"; }; then rm -f "$tmp"; return 1; fi
}
# 편집 잠금 아래에서만 부른다. 사라진 모드 파일을 v3 대기·실행이 남아 있을 때만 되살린다.
mode_heal() {
  # 이 기능 전에 켠 모드는 저장값이 없다. 편집 잠금을 잡은 첫 호출이 지금 모드를 한 번 남긴다.
  if [ -n "$SAVED" ] && [ ! -f "$SAVED" ] && mode_file >/dev/null; then
    if save_mode "$(mode_file)"; then note "mode-save from=existing to=$(mode_file)"
    else say "재시동 뒤 유지할 모드를 저장하지 못했습니다: $SAVED"; note "mode-save from=existing to=$(mode_file) result=failed"; fi
  fi
  ! mode_file >/dev/null && v3_active || return 0
  mode_write round-robin || return 1
  note "mode-restore from=missing to=round-robin"
}
capabilities() {
  printf '{"protocol":3,"mode":"%s","paused":%s,"capabilities":["lease-json","generation-release","token-reentry","ancestor-reentry","supervisor-round-robin","events-jsonl","verifier-shared-slot"]}\n' \
    "$(mode_read)" "$(if [ -e "$PAUSED" ]; then echo true; else echo false; fi)"
}
control() {
  local cmd="$1" target="${2:-}" prev
  if [ "$cmd" = mode ] && [ $# = 1 ]; then mode_read; echo; return; fi
  case "$cmd:$#:$target" in reclaim:1: | pause:1: | resume:1: | mode:2:compat | mode:2:round-robin) ;;
    *) usage >&2; return 2 ;; esac
  lock_queue || return $?
  case "$cmd" in
    reclaim)
      prev="$(mode_read)"
      slot_reclaim "$prev" && { use_lane; slot_reclaim "$prev"; }
      ;;
    pause) (umask 077; touch "$PAUSED") ;;
    resume) rm -f "$PAUSED" ;;
    mode)
      if [ ! -e "$PAUSED" ] || [ -n "$(q_lines)" ] || [ -e "$XL" ] || [ -n "$(use_lane; q_lines)" ] || [ -e "$LXL" ]; then
        unlock_queue; say "전환 거절: pause 후 실행·대기자(구버전·검증 자리 포함)를 모두 drain해야 합니다"; return 4
      fi
      prev="$(mode_read)"
      # 순환 파일을 먼저 지운다. 실패하면 기존 모드를 유지한다.
      rm -f "$RING" "$LQ.rotation" || { unlock_queue; return 1; }
      mode_write "$target" || { unlock_queue; return 1; }
      save_mode "$target" || { say "모드는 바꿨지만 재시동 뒤 유지할 설정을 쓰지 못했습니다: $SAVED"; note "mode-change from=$prev to=$target save=failed"; unlock_queue; return 1; }
      note "mode-change from=$prev to=$target parent=$PPID:$(ps -o ucomm= -p "$PPID" 2>/dev/null | tr -d ' ')"
      ;;
  esac
  local rc=$?
  use_main
  unlock_queue
  return "$rc"
}
# 확정 사망 항목 회수. 모드는 일반 자리에서 읽은 값을 쓴다.
slot_reclaim() { if [ "$1" = round-robin ]; then rr_reclaim && ring_sync; else reclaim_dead; fi; }
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
# 최근 FAIR_WINDOW초 안에 끝난 차례(end·reclaim)의 보유 시간을 감독자별로 합친다. 줄 형식: U <감독자> <초>.
# 이벤트 파일은 순환하지 않으므로 끝의 일부만 읽는다(2026-11 최대 시간당 약 130줄). 구간 밖·미래 시각·잘린 줄은 버린다.
rr_usage() {
  local now
  [ "$FAIR_WINDOW" -gt 0 ] && [ -f "$EVENTS" ] || return 0
  now="$(date +%s)"
  tail -n 1000 "$EVENTS" 2>/dev/null | awk -v now="$now" -v since=$((now - FAIR_WINDOW)) '
    /"event":"(end|reclaim)"/ && /}$/ {
      if (!match($0, /"at":[0-9]+/)) next
      at = substr($0, RSTART + 5, RLENGTH - 5) + 0
      if (at < since || at > now) next
      if (!match($0, /"supervisor":"[^"]*"/)) next
      sup = substr($0, RSTART + 14, RLENGTH - 15)
      if (!match($0, /"heldSeconds":[0-9]+/)) next
      used[sup] += substr($0, RSTART + 14, RLENGTH - 14)
    }
    END { for (s in used) print "U", s, used[s] }'
  return 0
}
# 가장 최근 start 기록의 세대 (rr_acquire의 빈자리 타이머용).
rr_last_start() {
  tail -n 1000 "$EVENTS" 2>/dev/null | sed -n 's/^{"event":"start".*"generation":"\([^"]*\)".*/\1/p' | tail -n 1
  return 0
}
# 대기 줄이 있는 감독자 중 최근 사용 시간이 가장 적은 감독자의 첫 줄. 같으면 순환 순서가 앞선 쪽이다. ring이면 순환 순서만 쓴다.
rr_head() {
  { ring_read | sed 's/^/R /'; q_lines | sed 's/^/Q /'; [ "${1:-}" = ring ] || rr_usage; } | awk '
    $1=="R" { if ($2!="") ring[++n]=$2; next }
    $1=="U" { used[$2]=$3; next }
    {
      sup=""
      for (i=3;i<=NF;i++) if ($i ~ /^supervisor=/) sup=substr($i,12)
      if (sup!="" && !(sup in first)) first[sup]=$2
    }
    END {
      for (i=1;i<=n;i++) {
        s=ring[i]
        if (!(s in first)) continue
        u=used[s]+0
        if (best=="" || u<low) { best=first[s]; low=u }
      }
      printf "%s", best
    }'
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
  local registered=0 l owner rc count supcount now json head free_since='' last_start='' st
  case "$MAX_SUP:$MAX_ALL" in *[!0-9:]* | :* | *: | 0:* | *:0) say "pending 한도는 양의 정수여야 합니다"; return 2 ;; esac
  # 장기 holder는 호출자의 조상이어야 하며 시작 시각을 검증할 수 있어야 한다.
  [ -n "$HOLDER" ] || { HOLDER="$PPID"; HOLDER_START="$(proc_start "$PPID")" || HOLDER_START=-; }
  is_ancestor "$HOLDER" "$HOLDER_START" || { say "holder의 조상 관계·시작 시각을 검증하지 못했습니다"; return 6; }
  while :; do
    lock_queue || return $?
    if [ "$(mode_read)" != round-robin ]; then unlock_queue; say "round-robin이 꺼져 있습니다"; return 4; fi
    if [ "$registered" = 0 ]; then
      # 자리 선택과 첫 등록을 같은 편집 잠금 안에서 한다. 다른 요청의 등록·승격과 갈라지지 않는다.
      use_main; lane_route
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
    # 같은 빈자리가 10초 넘게 이어지면 사용 시간 없이 순환 순서로 고른다. 구버전 대기자가 섞이거나 기준이 갈려도
    # 모두 같은 순환 선두에 합의해 정체가 풀린다. 정상 인계는 FAST_POLL 안에 끝난다.
    # 확인 사이에 다른 실행이 시작됐으면(마지막 start 기록이 바뀜) 새 빈자리이므로 다시 센다. 대기 취소는 세지 않는다.
    head=''
    if [ -d "$XL" ]; then free_since=''
    else
      st="$(rr_last_start)"
      [ "$st" = "$last_start" ] || { free_since=''; last_start="$st"; }
      now="$(date +%s)"; [ -n "$free_since" ] || free_since="$now"
      if [ $((now - free_since)) -ge 10 ]; then head="$(rr_head ring)"; else head="$(rr_head)"; fi
    fi
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
  lock_queue || return $?
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
    status)
      case "$*" in
        '') do_status ;;
        --json) do_status_json ;;
        *) usage >&2; return 2 ;;
      esac
      return ;;
    capabilities | version) capabilities; return ;;
    pause | resume | mode | reclaim) control "$cmd" "$@"; return ;;
    -h | --help | help) usage; return 0 ;;
    release)
      if [ $# = 6 ] && [ "$1" = --generation ] && [ "$3" = --token ] && [ "$5" = --lease ]; then
        GEN="$2" TOKEN="$4" LEASE="$6"
        [ -z "$GEN" ] || [ "$GEN" != "$(json_str "$(lane_owner)" generation)" ] || use_lane
        rr_release; return
      fi
      [ $# = 1 ] || { usage >&2; return 2; }
      need_task "$1" || return
      ID="$1"
      ! lane_has_id || use_lane
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
      lane_nice
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
