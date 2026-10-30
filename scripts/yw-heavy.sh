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

usage() {
  cat <<'EOF'
사용법:
  yw-heavy run <ID> <worker> <supervisor> -- <명령…>   권장. 명령이 실행되는 동안만 차례를 잡는다. 종료 코드는 명령의 것
  yw-heavy acquire <ID> <worker> <supervisor> [--holder PID]
                                                        차례가 오면 "ACQUIRED <ID>". holder가 끝나면 다른 대기자가 회수한다
  yw-heavy release <ID>                                 차례(그 ID의 것일 때)와 그 ID의 대기 줄을 지운다
  yw-heavy enqueue <ID> <worker> <supervisor>           구버전 acquire 호환 전용 (구형식 줄)
  yw-heavy status                                       읽기 전용 상태
종료 코드: 0 성공, 1 내부 오류, 2 사용법 오류·holder가 처음부터 끝나 있음,
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
  EDIT_WARN="${YW_HEAVY_EDIT_WARN:-120}"
  # 구버전 편집 lock이 풀리기를 기다리는 주기. 1초보다 짧은 대기 주기(테스트)면 그것을 쓴다.
  case "$POLL" in 0* | .*) EDIT_POLL="$POLL" ;; *) EDIT_POLL=1 ;; esac
  LOCKF=/usr/bin/lockf
  ID='' WORKER='' SUP='' HOLDER='' HOLDER_START=- MYSTART=- MYMARK='' LOCKED=0 SIG='' HELD=0
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
json_str() { printf '%s' "$1" | sed -nE "s/.*\"$2\":\"([^\"]*)\".*/\\1/p" | head -1; }
json_num() { printf '%s' "$1" | sed -nE "s/.*\"$2\":[[:space:]]*([0-9]+).*/\\1/p" | head -1; }
json_esc() {
  local s="${1//\\/\\\\}"
  printf '%s' "${s//\"/\\\"}"
}
owner_v2() {
  local v
  v="$(json_num "$1" v)"
  [ -n "$v" ] && [ "$v" -ge 2 ]
}

# 회수·이어받기 기록: 기록 파일과 stderr에 한 줄. 기록에 실패해도 계속한다.
note() {
  local msg
  msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) $* by=$$:${ID:--}"
  say "$msg"
  { printf '%s\n' "$msg" >>"$LOG"; } 2>/dev/null || true
}

# ---- queue lock: 커널 flock + 구버전을 막는 호환 편집 lock -----------------------

lock_queue() {
  local rc
  # shellcheck disable=SC2093
  if ! exec 9>>"$FL"; then
    say "대기열 잠금 파일을 열 수 없음: $FL"
    return 1
  fi
  while :; do
    "$LOCKF" -s -t 60 9
    rc=$?
    [ "$rc" = 0 ] && break
    if [ "$rc" != 75 ]; then
      exec 9>&-
      say "lockf 실패 ($rc): $FL"
      return 1
    fi
    say "대기열 잠금을 기다리는 중: $FL"
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
      pid="$(json_num "$owner" pid)"
      if [ -n "$pid" ] && [ "$(proc_state "$pid")" = dead:esrch ]; then
        if [ "$(cat "$EL/owner.txt" 2>/dev/null)" = "$owner" ]; then
          rm -f "$EL/owner.txt"
          rmdir "$EL" 2>/dev/null &&
            note "reclaim kind=edit task=$(json_str "$owner" task) pid=$pid start=- reason=legacy-edit-esrch"
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
  local protect="${1:-}" owner task holder hs st drop='' l id pid start kept='' changed=0
  [ -e "$NR" ] && return 0
  owner="$(owner_read)"
  task="$(json_str "$owner" task)"
  holder="$(json_num "$owner" holder)"
  # 구형식 owner(pid가 $PPID라 믿을 수 없음)·zsh 형식·holder 없는 lock은 회수하지 않는다.
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
  printf '%s}\n' "$json" >"$XL/owner.txt"
}

do_acquire() {
  local registered=0 l pid start head capped=0 last_note="$SECONDS"
  while :; do
    lock_queue || return 1
    if [ "$registered" = 0 ]; then
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
        [ "$capped" = 1 ] || say "$ID: 감독자 $SUP의 대기 줄이 이미 2개라 자리가 날 때까지 기다립니다"
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
      if [ -n "$HOLDER" ]; then
        case "$(proc_state "$HOLDER" "$HOLDER_START")" in
          dead:*)
            q_drop "$ID"
            unlock_queue
            say "$ID: holder $HOLDER가 끝나 대기를 그만둡니다"
            return 3
            ;;
        esac
      fi
    fi
    head="$(line_id "$(q_lines | head -1)")"
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
release_id() {
  lock_queue || return 1
  if [ "$(json_str "$(owner_read)" task)" = "$ID" ]; then
    rm -f "$XL/owner.txt"
    rmdir "$XL" 2>/dev/null
  fi
  [ -z "$(q_line "$ID")" ] || q_drop "$ID"
  unlock_queue
  HELD=0
}

# 구버전 acquire가 "$0" enqueue로 부를 때: 대기자는 부모인 구 acquire라 pid 없는 구형식 줄을 쓴다.
do_enqueue_legacy() {
  while :; do
    lock_queue || return 1
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
  trap '[ "$HELD" = 0 ] || release_id' EXIT
  HOLDER="$$"
  HOLDER_START="$MYSTART"
  do_acquire || return $?
  say "ACQUIRED $ID"
  if [ -n "$SIG" ]; then
    release_id
    sig_code
    return
  fi
  "$@" 9>&-
  rc=$?
  release_id
  if [ -n "$SIG" ]; then
    sig_code
    return
  fi
  return "$rc"
}

do_status() {
  local l n=0 legacy=0 id pid start st owner task holder hs target age
  printf '대기열: %s\n' "$Q"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    n=$((n + 1))
    id="$(line_id "$l")"
    if is_v2 "$l"; then
      pid="$(lf "$l" pid)"
      start="$(lf "$l" start)"
      if [ "${pid:--}" = - ]; then st='holder 없음 (자동 회수 안 함)'; else st="pid $pid $(proc_state "$pid" "${start:--}")"; fi
      printf '  %d. %s  v2  %s  [%s]\n' "$n" "$id" "$(lf "$l" supervisor)" "$st"
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
    if [ -z "$owner" ]; then
      printf '실행 lock: %s (owner.txt 없음, 자동 회수 안 함)\n' "$XL"
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
      pid="$(json_num "$owner" pid)"
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
    '' | -* | *[[:space:]\\\"]*) return 1 ;;
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

main() {
  init
  local cmd="${1:-}" st
  [ $# -gt 0 ] && shift
  case "$cmd" in
    status) do_status; return ;;
    -h | --help | help) usage; return 0 ;;
    release)
      [ $# = 1 ] || { usage >&2; return 2; }
      need_task "$1" || return
      ID="$1"
      release_id || return 1
      echo "released $ID"
      return 0
      ;;
  esac
  [ $# -ge 3 ] || { usage >&2; return 2; }
  need_task "$1" "$2" "$3" || return
  ID="$1" WORKER="$2" SUP="$3"
  shift 3
  MYSTART="$(proc_start $$)" || MYSTART=-
  case "$cmd" in
    enqueue)
      [ $# = 0 ] || { usage >&2; return 2; }
      do_enqueue_legacy
      ;;
    acquire)
      if [ $# = 2 ] && [ "$1" = --holder ]; then
        case "$2" in '' | 0* | *[!0-9]*) usage >&2; say "--holder는 PID 숫자입니다: $2"; return 2 ;; esac
        HOLDER="$2"
        HOLDER_START="$(proc_start "$HOLDER")" || HOLDER_START=-
        st="$(proc_state "$HOLDER" "$HOLDER_START")"
        case "$st" in dead:*) say "holder $HOLDER가 이미 끝났습니다"; return 2 ;; esac
      elif [ $# != 0 ]; then
        usage >&2
        return 2
      fi
      do_acquire || return $?
      echo "ACQUIRED $ID"
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
