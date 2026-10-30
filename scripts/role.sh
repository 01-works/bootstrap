#!/usr/bin/env bash
# 기기 역할: ./bootstrap.sh role add|status|remove verifier
# 모든 기기가 같은 세팅이다. 일부 기기에만 필요한 설정은 역할로 켠다 (README "기기 역할"). 지금은 verifier 하나다.
# verifier: 무거운 검증을 맡는 기기. colima 메모리를 정하고, 에이전트 Chrome·Paseo 데몬·Paseo 업그레이드 자동 시작을 끄고,
#   로그 디렉터리를 만들고, 그 로그만 읽는 SSH 키(강제 명령 verifier-logs)를 등록한다.
# 켠 역할은 상태 파일(~/.config/bootstrap/roles/<역할>)로 남는다. roles 단계가 저장된 값으로 다시 맞춘다(apply-active).
# 특정 프로젝트를 알지 않는다. 로그 디렉터리 경로(~/.local/state/verifier/logs)만 로그를 남기는 쪽과의 약속이다.
# 종료 코드: 0 준비 완료, 2 수동 작업 대기, 1 실패·미설정.

BOOTSTRAP_ROOT="${BOOTSTRAP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export BOOTSTRAP_ROOT

usage() {
  cat <<'EOF'
사용법:
  ./bootstrap.sh role add verifier [--ssh-key <공개키 파일>] [--colima-memory <GiB>] [--dry-run]
                             역할 켜기. 처음에는 --ssh-key가 필요하다 (로그를 읽을 기기의 공개키)
  ./bootstrap.sh role status [verifier]
                             역할 상태 (0 준비 완료, 2 수동 작업 대기, 1 실패·꺼짐)
  ./bootstrap.sh role remove verifier [--dry-run]
                             역할 끄기. 바꾼 설정을 되돌리고 자동 시작을 다시 켠다. 남은 로그는 지우지 않는다
  ./bootstrap.sh role apply-active
                             켠 역할을 저장된 값으로 다시 맞춘다 (roles 단계)
EOF
}

ROLES=verifier
# GiB. 16GB 기기 기준: VM 안에서는 PostgreSQL 컨테이너만 돌고, 호스트의 Node가 heap을 최대 8GB 쓴다. --colima-memory로 바꾼다.
VERIFIER_DEFAULT_MEMORY=6
# 이 기기에서 자동 시작하지 않는 등록 (launch-agents.mjs가 상태 파일을 보고 끈다).
VERIFIER_AGENTS='agent-chrome paseo paseo-upgrade'
KEY_COMMENT=bootstrap-role-verifier

paths() {
  ROLE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/roles"
  STATE_FILE="$ROLE_DIR/verifier"
  COLIMA_CONFIG="${COLIMA_HOME:-$HOME/.colima}/default/colima.yaml"
  LOG_DIR="$HOME/.local/state/verifier/logs"
  LOGS_SRC="$BOOTSTRAP_ROOT/scripts/verifier-logs.sh"
  LOGS_BIN="$HOME/.local/bin/verifier-logs"
  SSH_DIR="$HOME/.ssh"
  AUTH_KEYS="$SSH_DIR/authorized_keys"
}

state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -1; }
perm() { stat -f %Lp "$1" 2>/dev/null; }
changing() { [[ "$DRY_RUN" != 1 ]]; }
dry() { info "[dry-run] $*"; }

# 설치·자동 갱신과 동시에 바꾸지 않는다. roles 단계에서 부르면 이미 잡혀 있다.
take_lock() {
  changing || return 0
  lock_acquire && return 0
  info '다른 설치·자동 갱신이 실행 중입니다. 끝나기를 기다립니다 (중단: Ctrl-C)'
  until lock_acquire; do sleep 5; done
}

# 공개키 파일의 키 한 줄을 "<종류> <본문>"으로 출력한다. 주석·옵션은 버린다.
key_from_file() {
  local file="$1" lines type body
  [[ -f "$file" ]] || { fail "공개키 파일 없음: $file"; return 1; }
  lines="$(grep -v '^[[:space:]]*$' "$file" | grep -v '^[[:space:]]*#')"
  if [[ -z "$lines" || "$(printf '%s\n' "$lines" | wc -l | tr -d ' ')" != 1 ]]; then
    fail "공개키 파일에는 키 한 줄만 있어야 합니다: $file"
    return 1
  fi
  read -r type body _ <<<"$lines"
  if ! [[ "$type" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$ ]] ||
    ! [[ "$body" =~ ^[A-Za-z0-9+/]+=*$ ]]; then
    fail "공개키 형식이 아닙니다 (<종류> <base64> [주석]): $file"
    return 1
  fi
  printf '%s %s' "$type" "$body"
}

# authorized_keys에 넣는 정확한 한 줄. restrict로 전달·터미널을 막고, 어떤 명령을 요청해도 verifier-logs만 실행한다.
auth_line() { printf 'restrict,command="%s" %s %s' "$LOGS_BIN" "$1" "$KEY_COMMENT"; }

# 우리 줄이 아닌데 같은 키 본문이 있는 줄. sshd는 처음 일치한 줄을 쓰므로 그런 줄이 있으면 읽기 전용이 아니게 된다.
# 읽지 못하면 실패(1)를 돌려준다.
other_key_lines() {
  [[ -e "$AUTH_KEYS" ]] || return 0
  WANT="$(auth_line "$1")" KEY="${1#* }" awk '
    BEGIN { want = ENVIRON["WANT"]; key = ENVIRON["KEY"] }
    $0 != want { for (i = 1; i <= NF; i++) if ($i == key) { print NR; break } }' "$AUTH_KEYS"
}

# 이 역할이 넣은 줄 (키와 상관없이): restrict,command="<verifier-logs>" <종류> <본문> bootstrap-role-verifier
own_lines_filter() {
  PREFIX="restrict,command=\"$LOGS_BIN\" " COMMENT="$KEY_COMMENT" awk -v mode="$1" '
    BEGIN { p = ENVIRON["PREFIX"]; c = ENVIRON["COMMENT"] }
    { own = index($0, p) == 1 && split(substr($0, length(p) + 1), f, " ") == 3 && f[3] == c }
    (mode == "keep" && !own) || (mode == "own" && own)' "$AUTH_KEYS"
}

colima_memory_now() { awk '/^memory:/ { print $2; exit }' "$COLIMA_CONFIG" 2>/dev/null; }
colima_running() { has colima && colima status >/dev/null 2>&1; }

# 최상위 memory: 한 줄만 바꾼다. 같은 디렉터리의 임시 파일에 쓰고 mv로 바꾼다.
colima_memory_set() {
  local tmp
  tmp="$(mktemp "$(dirname "$COLIMA_CONFIG")/.colima.yaml.XXXXXX")" || return 1
  if ! { awk -v m="$1" '!done && /^memory:/ { print "memory: " m; done = 1; next } { print }' "$COLIMA_CONFIG" >"$tmp" &&
    chmod "$(perm "$COLIMA_CONFIG")" "$tmp" && mv -f "$tmp" "$COLIMA_CONFIG"; }; then
    rm -f "$tmp"
    return 1
  fi
}

# 파일을 원자적으로 쓴다: write_atomic <대상> <권한> <내용을 출력하는 명령...>
# 명령 출력을 같은 디렉터리의 임시 파일에 끝까지 쓰고, 명령이 성공했을 때만 mv로 바꾼다.
# 파이프로 받지 않는다. 앞 단계가 실패해도(예: 원래 파일을 읽지 못함) 빈 내용으로 덮어쓰지 않게 하기 위해서다.
write_atomic() {
  local target="$1" mode="$2" tmp
  shift 2
  tmp="$(mktemp "$(dirname "$target")/.$(basename "$target").XXXXXX")" || return 1
  if ! { "$@" >"$tmp" && chmod "$mode" "$tmp" && mv -f "$tmp" "$target"; }; then
    rm -f "$tmp"
    return 1
  fi
}

# 기존 authorized_keys 뒤에 한 줄을 붙인 내용. 읽지 못하면 실패한다.
keys_with_line() {
  if [[ -s "$AUTH_KEYS" ]]; then
    cat "$AUTH_KEYS" || return 1
    [[ -z "$(tail -c 1 "$AUTH_KEYS")" ]] || echo
  fi
  printf '%s\n' "$1"
}

# 고칠 SSH 경로와 로그 디렉터리는 링크가 아니어야 한다. 링크면 권한 판정(lstat)과 chmod(대상)가 어긋난다.
# 문제가 있으면 알리고 1을 돌려준다.
check_paths() {
  local path
  for path in "$SSH_DIR" "$AUTH_KEYS" "$LOG_DIR"; do
    if [[ -L "$path" ]]; then
      fail "$(pretty "$path")가 링크라 고치지 않습니다. 실제 디렉터리·파일로 바꾼 뒤 다시 실행하세요"
      return 1
    fi
  done
  if [[ -e "$AUTH_KEYS" && ! -r "$AUTH_KEYS" ]]; then
    fail "$(pretty "$AUTH_KEYS")를 읽을 수 없어 고치지 않습니다 (권한 확인: ls -l $(pretty "$AUTH_KEYS"))"
    return 1
  fi
}

# launch-agents.mjs로 세 등록을 맞춘다. 상태 파일이 있으면 끄고, 없으면 이 기기 종류의 원래 등록으로 되돌린다.
# dry-run은 상태 파일을 아직 바꾸지 않았으므로 바꾼 뒤의 역할을 넘긴다: agents <verifier|none>
# 수동 작업 대기(2)로 끝난 대상은 AGENTS_PENDING에 남는다.
agents() {
  local name r st=0 extra=''
  [[ "$DRY_RUN" == 1 ]] && extra="--dry-run --roles $1"
  AGENTS_PENDING=''
  for name in $VERIFIER_AGENTS; do
    r=0
    # shellcheck disable=SC2086
    node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --only "$name" "$(device_flag)" $extra || r=$?
    case "$r" in
      0) ;;
      2) [[ "$st" == 1 ]] || st=2; AGENTS_PENDING="$AGENTS_PENDING $name" ;;
      *) st=1 ;;
    esac
  done
  AGENTS_PENDING="${AGENTS_PENDING# }"
  return "$st"
}

verifier_add() {
  local key_file='' memory='' key saved current before added line others r st=0 first=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ssh-key) [[ -n "${2:-}" ]] || { usage; fail '--ssh-key 다음에 공개키 파일이 필요합니다'; return 1; }; key_file="$2"; shift ;;
      --ssh-key=*) key_file="${1#*=}" ;;
      --colima-memory) [[ -n "${2:-}" ]] || { usage; fail '--colima-memory 다음에 GiB 값이 필요합니다'; return 1; }; memory="$2"; shift ;;
      --colima-memory=*) memory="${1#*=}" ;;
      --dry-run) DRY_RUN=1 ;;
      *) usage; fail "알 수 없는 인자: $1"; return 1 ;;
    esac
    shift
  done
  [[ -f "$STATE_FILE" ]] || first=1

  # 바꾸기 전에 입력과 충돌을 모두 확인한다. 실패하면 아무것도 바꾸지 않는다.
  saved="$(state_get ssh_key_line)"
  if [[ -n "$key_file" ]]; then
    key="$(key_from_file "$key_file")" || return 1
    if [[ -n "$saved" && "$key" != "$saved" ]]; then
      fail '저장된 키와 다릅니다. 키를 바꾸려면 ./bootstrap.sh role remove verifier 후 다시 add'
      return 1
    fi
  elif [[ -n "$saved" ]]; then
    key="$saved"
  else
    fail '처음 켤 때는 --ssh-key <공개키 파일>이 필요합니다 (로그를 읽을 기기의 공개키)'
    return 1
  fi
  memory="${memory:-$(state_get colima_memory)}"
  memory="${memory:-$VERIFIER_DEFAULT_MEMORY}"
  [[ "$memory" =~ ^[1-9][0-9]*$ ]] || { fail "--colima-memory는 GiB 단위 양의 정수여야 합니다: $memory"; return 1; }
  check_paths || return 1
  if ! others="$(other_key_lines "$key")"; then
    fail "$(pretty "$AUTH_KEYS")를 읽지 못해 고치지 않습니다"
    return 1
  fi
  if [[ -n "$others" ]]; then
    fail "$(pretty "$AUTH_KEYS")의 다른 줄(줄 $(printf '%s' "$others" | paste -sd , -))에 같은 키가 있습니다. sshd는 처음 일치한 줄을 써서 읽기 전용이 되지 않습니다. 그 줄을 정리하거나 다른 키를 쓰세요. 고치지 않았습니다"
    return 1
  fi
  has node || { fail 'Node 없음. ./bootstrap.sh --only runtimes 후 다시 실행하세요'; return 1; }

  # 상태 파일: 이 파일이 있으면 역할이 켜진 것이다. colima의 원래 값은 처음 본 값 하나만 남긴다(끌 때 되돌림).
  current=''
  [[ -f "$COLIMA_CONFIG" ]] && current="$(colima_memory_now)"
  before="$(state_get colima_memory_before)"
  before="${before:-$current}"
  added="$(state_get added_at)"
  added="${added:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  if changing; then
    mkdir -p "$ROLE_DIR" || return 1
    write_atomic "$STATE_FILE" 600 printf 'colima_memory=%s\ncolima_memory_before=%s\nssh_key_line=%s\nadded_at=%s\n' \
      "$memory" "$before" "$key" "$added" || { fail "상태 파일을 쓰지 못했습니다: $(pretty "$STATE_FILE")"; return 1; }
    ok "verifier 켬 ($(pretty "$STATE_FILE"))"
  else
    dry "상태 파일 $(pretty "$STATE_FILE") (colima_memory=$memory)"
  fi

  # 1. colima 메모리. 인스턴스 설정이 없으면 템플릿 대신 사람에게 맡긴다. colima 0.10은 템플릿을 그대로 쓰므로
  #    memory만 적은 템플릿은 cpu·disk·runtime이 빈 값으로 시작한다.
  if [[ ! -f "$COLIMA_CONFIG" ]]; then
    warn "colima 설정 없음 ($(pretty "$COLIMA_CONFIG")) → colima start --memory $memory 를 한 번 실행한 뒤 ./bootstrap.sh role add verifier"
    st=2
  elif [[ -z "$current" ]]; then
    fail "$(pretty "$COLIMA_CONFIG")에 memory: 줄이 없습니다"
    st=1
  elif [[ "$current" == "$memory" ]]; then
    ok "colima 메모리 ${memory} GiB"
  elif ! changing; then
    dry "colima 메모리 ${current} → ${memory} GiB"
  elif colima_memory_set "$memory"; then
    ok "colima 메모리 ${current} → ${memory} GiB"
    if colima_running; then info '실행 중인 colima에는 다음 시작부터 적용됩니다 (colima stop && colima start)'; fi
  else
    fail "colima 설정을 바꾸지 못했습니다: $(pretty "$COLIMA_CONFIG")"
    st=1
  fi

  # 2. 자동 시작 끄기. 이미 떠 있는 Paseo 데몬은 끄지 않는다(이 명령을 Paseo 세션에서 실행 중일 수 있다).
  r=0
  agents verifier || r=$?
  case "$r" in
    0) ok '에이전트 Chrome·Paseo 데몬·Paseo 업그레이드 자동 시작 꺼짐' ;;
    2) warn "실행 중이라 등록이 남은 자동 시작: ${AGENTS_PENDING}. 끝낸 뒤 다시 실행하거나 다음 로그인부터 꺼집니다"; [[ "$st" == 1 ]] || st=2 ;;
    *) fail '자동 시작을 끄지 못했습니다 (위 메시지)'; st=1 ;;
  esac
  [[ "$first" == 1 ]] && info '이미 떠 있는 Paseo 데몬은 그대로 둡니다. 이 기기에서 쓰지 않으면 paseo daemon stop'

  # 3. 로그 디렉터리
  if ! changing; then
    dry "로그 디렉터리 $(pretty "$LOG_DIR") (700)"
  elif mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"; then
    ok "로그 디렉터리 $(pretty "$LOG_DIR")"
  else
    fail "로그 디렉터리를 만들지 못했습니다: $(pretty "$LOG_DIR")"
    st=1
  fi

  # 4. 읽기 전용 SSH: 강제 명령을 설치하고 정확한 한 줄을 추가한다.
  if [[ -x "$LOGS_BIN" ]] && cmp -s "$LOGS_SRC" "$LOGS_BIN"; then
    ok "verifier-logs ($(pretty "$LOGS_BIN"))"
  elif ! changing; then
    dry "$(pretty "$LOGS_BIN")를 저장소 원본으로 교체 (복사 후 mv)"
  elif mkdir -p "$(dirname "$LOGS_BIN")" && write_atomic "$LOGS_BIN" 755 cat "$LOGS_SRC"; then
    ok "verifier-logs 설치 ($(pretty "$LOGS_BIN"))"
  else
    fail "verifier-logs 설치 실패: $(pretty "$LOGS_BIN")"
    st=1
  fi
  line="$(auth_line "$key")"
  if [[ -f "$AUTH_KEYS" ]] && grep -qxF "$line" "$AUTH_KEYS"; then
    ok "읽기 전용 SSH 키 ($(pretty "$AUTH_KEYS"))"
  elif ! changing; then
    dry "$(pretty "$AUTH_KEYS")에 읽기 전용 키 한 줄 추가"
  elif mkdir -p -m 700 "$SSH_DIR" && write_atomic "$AUTH_KEYS" 600 keys_with_line "$line"; then
    ok "읽기 전용 SSH 키 추가 ($(pretty "$AUTH_KEYS"))"
  else
    fail "$(pretty "$AUTH_KEYS")에 키를 넣지 못했습니다"
    st=1
  fi
  if changing && [[ -d "$SSH_DIR" ]]; then
    [[ "$(perm "$SSH_DIR")" == 700 ]] || chmod 700 "$SSH_DIR"
    [[ ! -f "$AUTH_KEYS" || "$(perm "$AUTH_KEYS")" == 600 ]] || chmod 600 "$AUTH_KEYS"
  fi

  # 5. 원격 로그인은 시스템 설정에서 사람이 켠다.
  if sharing_enabled com.openssh.sshd; then
    ok '원격 로그인'
  else
    warn '원격 로그인 꺼짐 → 시스템 설정 > 일반 > 공유 > 원격 로그인 켜기'
    [[ "$st" == 1 ]] || st=2
  fi
  return "$st"
}

verifier_status() {
  local bad=0 wait=0 memory current key line others name r
  s_ok() { ok "$*"; }
  s_bad() { fail "$*"; bad=1; }
  s_wait() { warn "$*"; wait=1; }
  if [[ ! -f "$STATE_FILE" ]]; then
    fail 'verifier 꺼짐 (켜기: ./bootstrap.sh role add verifier --ssh-key <공개키 파일>)'
    return 1
  fi
  if [[ "$(perm "$STATE_FILE")" == 600 ]]; then s_ok "상태 파일 $(pretty "$STATE_FILE")"; else s_bad "상태 파일 권한이 $(perm "$STATE_FILE") (600이어야 함)"; fi

  memory="$(state_get colima_memory)"
  if [[ ! -f "$COLIMA_CONFIG" ]]; then
    s_wait "colima 설정 없음 → colima start --memory ${memory} 후 ./bootstrap.sh role add verifier"
  else
    current="$(colima_memory_now)"
    if [[ -n "$memory" && "$current" == "$memory" ]]; then s_ok "colima 메모리 ${memory} GiB"; else s_bad "colima 메모리가 ${current:-없음} (verifier 값 ${memory:-없음}) → ./bootstrap.sh role add verifier"; fi
  fi

  for name in $VERIFIER_AGENTS; do
    r=0
    node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --check --only "$name" "$(device_flag)" >/dev/null 2>&1 || r=$?
    case "$r" in
      0) s_ok "자동 시작 꺼짐: $name" ;;
      2) s_wait "자동 시작: $name 실행 중이라 등록이 남음 (끝내거나 다음 로그인부터 꺼짐)" ;;
      *) s_bad "자동 시작이 남아 있음: $name → ./bootstrap.sh role add verifier" ;;
    esac
  done

  if [[ -L "$LOG_DIR" ]]; then s_bad "로그 디렉터리가 링크임: $(pretty "$LOG_DIR") (실제 디렉터리로 바꾼 뒤 ./bootstrap.sh role add verifier)"
  elif [[ -d "$LOG_DIR" && "$(perm "$LOG_DIR")" == 700 ]]; then s_ok "로그 디렉터리 $(pretty "$LOG_DIR")"; else s_bad "로그 디렉터리 없음 또는 권한이 700이 아님: $(pretty "$LOG_DIR")"; fi
  printf 'log_dir=%s\n' "$LOG_DIR"

  if [[ -x "$LOGS_BIN" ]] && cmp -s "$LOGS_SRC" "$LOGS_BIN"; then s_ok "verifier-logs 설치본이 저장소 원본과 같음"; else s_bad "verifier-logs 없음 또는 원본과 다름: $(pretty "$LOGS_BIN")"; fi

  key="$(state_get ssh_key_line)"
  line="$(auth_line "$key")"
  if [[ -z "$key" ]]; then
    s_bad '상태 파일에 SSH 키가 없음 → ./bootstrap.sh role add verifier --ssh-key <공개키 파일>'
  elif [[ -L "$SSH_DIR" || -L "$AUTH_KEYS" ]]; then
    s_bad "$(pretty "$SSH_DIR") 또는 $(pretty "$AUTH_KEYS")가 링크임 (실제 디렉터리·파일이어야 함)"
  elif [[ -e "$AUTH_KEYS" && ! -r "$AUTH_KEYS" ]]; then
    s_bad "$(pretty "$AUTH_KEYS")를 읽을 수 없음"
  elif [[ -f "$AUTH_KEYS" ]] && grep -qxF "$line" "$AUTH_KEYS"; then
    if ! others="$(other_key_lines "$key")"; then
      s_bad "$(pretty "$AUTH_KEYS")를 읽지 못함"
    elif [[ -n "$others" ]]; then
      s_bad "같은 키가 다른 줄(줄 $(printf '%s' "$others" | paste -sd , -))에도 있어 읽기 전용이 아님: $(pretty "$AUTH_KEYS")"
    elif [[ "$(perm "$SSH_DIR")" != 700 || "$(perm "$AUTH_KEYS")" != 600 ]]; then
      s_bad "권한: $(pretty "$SSH_DIR") $(perm "$SSH_DIR"), $(pretty "$AUTH_KEYS") $(perm "$AUTH_KEYS") (700/600이어야 함)"
    else
      s_ok "읽기 전용 SSH 키 (verifier-logs만 실행)"
    fi
  else
    s_bad "$(pretty "$AUTH_KEYS")에 읽기 전용 키 줄이 없음 → ./bootstrap.sh role add verifier"
  fi

  if sharing_enabled com.openssh.sshd; then s_ok '원격 로그인'; else s_wait '원격 로그인 꺼짐 → 시스템 설정 > 일반 > 공유 > 원격 로그인 켜기'; fi

  [[ "$bad" == 0 ]] || return 1
  [[ "$wait" == 0 ]] || return 2
  return 0
}

verifier_remove() {
  local memory before current st=0 r
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      *) usage; fail "알 수 없는 인자: $1"; return 1 ;;
    esac
    shift
  done
  memory="$(state_get colima_memory)"
  before="$(state_get colima_memory_before)"

  # colima: 아직 verifier 값일 때만 원래 값으로 되돌린다. 그 사이 사람이 바꿨으면 그대로 둔다.
  if [[ -n "$memory" && -n "$before" && -f "$COLIMA_CONFIG" ]]; then
    current="$(colima_memory_now)"
    if [[ "$current" == "$before" ]]; then
      ok "colima 메모리 ${before} GiB (원래 값)"
    elif [[ "$current" != "$memory" ]]; then
      warn "colima 메모리가 ${current:-없음} GiB로 verifier 값(${memory})과 달라 바꾼 값으로 보고 그대로 둡니다"
    elif ! changing; then
      dry "colima 메모리 ${current} → ${before} GiB"
    elif colima_memory_set "$before"; then
      ok "colima 메모리 ${current} → ${before} GiB (다음 시작부터)"
    else
      # 원래 값은 상태 파일에만 있다. 지우지 않고 멈춰서, 원인을 고친 뒤 다시 실행하면 이어서 끈다.
      fail "colima 설정을 되돌리지 못했습니다: $(pretty "$COLIMA_CONFIG") (원래 값 ${before} GiB). 아무것도 더 바꾸지 않았습니다. 고친 뒤 다시: ./bootstrap.sh role remove verifier"
      return 1
    fi
  fi

  # 이 역할이 넣은 줄만 지운다. 링크이거나 읽을 수 없으면 알리고 남긴다.
  if [[ -L "$SSH_DIR" || -L "$AUTH_KEYS" ]]; then
    fail "$(pretty "$SSH_DIR") 또는 $(pretty "$AUTH_KEYS")가 링크라 읽기 전용 키 줄을 지우지 않았습니다. 직접 지우세요 (끝이 bootstrap-role-verifier인 줄)"
    st=1
  elif [[ -e "$AUTH_KEYS" && ! -r "$AUTH_KEYS" ]]; then
    fail "$(pretty "$AUTH_KEYS")를 읽을 수 없어 읽기 전용 키 줄을 지우지 않았습니다. 권한을 고친 뒤 다시: ./bootstrap.sh role remove verifier"
    st=1
  elif [[ -f "$AUTH_KEYS" && -n "$(own_lines_filter own)" ]]; then
    if ! changing; then
      dry "$(pretty "$AUTH_KEYS")에서 읽기 전용 키 줄 지우기"
    elif write_atomic "$AUTH_KEYS" 600 own_lines_filter keep; then
      ok "읽기 전용 SSH 키 지움 ($(pretty "$AUTH_KEYS"))"
    else
      fail "$(pretty "$AUTH_KEYS")에서 키를 지우지 못했습니다"
      st=1
    fi
  fi

  if [[ -e "$LOGS_BIN" ]]; then
    if ! cmp -s "$LOGS_SRC" "$LOGS_BIN"; then
      warn "$(pretty "$LOGS_BIN")가 저장소 원본과 달라 그대로 둡니다"
    elif ! changing; then
      dry "$(pretty "$LOGS_BIN") 지우기"
    else
      rm -f "$LOGS_BIN" && ok "verifier-logs 지움"
    fi
  fi

  # 로그는 지우지 않는다. 빈 디렉터리만 정리한다.
  if [[ -L "$LOG_DIR" ]]; then
    warn "로그 디렉터리가 링크라 그대로 둡니다: $(pretty "$LOG_DIR")"
  elif [[ -d "$LOG_DIR" ]]; then
    if [[ -n "$(ls -A "$LOG_DIR" 2>/dev/null)" ]]; then
      info "로그를 보존합니다: $(pretty "$LOG_DIR")"
    elif ! changing; then
      dry "빈 로그 디렉터리 $(pretty "$LOG_DIR") 지우기"
    else
      rmdir "$LOG_DIR" && rmdir "$(dirname "$LOG_DIR")" 2>/dev/null
      ok "빈 로그 디렉터리 지움"
    fi
  fi

  if [[ -f "$STATE_FILE" ]]; then
    if changing; then rm -f "$STATE_FILE" && ok "verifier 끔"; else dry "상태 파일 $(pretty "$STATE_FILE") 지우기"; fi
  else
    info 'verifier는 이미 꺼져 있습니다'
  fi

  # 상태 파일이 없어졌으니 launch-agents.mjs가 이 기기 종류의 원래 자동 시작을 다시 등록한다.
  r=0
  agents none || r=$?
  case "$r" in
    0) ok '자동 시작을 원래대로 맞춤' ;;
    2) warn "수동 작업 대기인 자동 시작: ${AGENTS_PENDING} (위 메시지)"; [[ "$st" == 1 ]] || st=2 ;;
    *) fail '자동 시작을 되돌리지 못했습니다 (위 메시지). 고친 뒤 ./bootstrap.sh --only browser,paseo'; st=1 ;;
  esac
  return "$st"
}

main() {
  set -uo pipefail
  # shellcheck source=scripts/lib.sh
  source "$BOOTSTRAP_ROOT/scripts/lib.sh"
  paths
  local cmd="${1:-}"
  [[ $# == 0 ]] || shift
  case "$cmd" in
    add | remove)
      if [[ "${1:-}" != verifier ]]; then
        usage
        fail "역할 이름이 필요합니다 (가능: $ROLES)"
        return 1
      fi
      shift
      case " $* " in *' --dry-run '*) DRY_RUN=1 ;; esac
      take_lock
      "verifier_$cmd" "$@"
      ;;
    status)
      case "${1:-}" in
        '')
          if [[ -f "$STATE_FILE" ]]; then
            step '기기 역할: verifier'
            verifier_status
          else
            info '기기 역할 없음'
          fi
          ;;
        verifier) verifier_status ;;
        *) usage; fail "알 수 없는 역할: $1 (가능: $ROLES)"; return 1 ;;
      esac
      ;;
    apply-active)
      if [[ ! -f "$STATE_FILE" ]]; then
        info '기기 역할 없음'
        return 0
      fi
      take_lock
      info '기기 역할: verifier (저장된 값으로 맞춤)'
      verifier_add
      ;;
    -h | --help) usage ;;
    *) usage; [[ -z "$cmd" ]] || fail "알 수 없는 명령: $cmd"; return 1 ;;
  esac
}

# 같은 줄의 exit: 자동 갱신이 이 파일을 바꿔도 읽던 내용이 섞이지 않는다.
main "$@"; exit $?
