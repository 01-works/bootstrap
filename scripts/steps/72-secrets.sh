#!/usr/bin/env bash
# 비밀값 동기화: Infisical의 한 폴더를 ~/.zsh_secrets.infisical로 받는다 (README "비밀값").
# 설정(~/.config/bootstrap/secrets.env)이 없는 기기는 아무것도 하지 않는다. 손으로 쓰는 ~/.zsh_secrets는 건드리지 않는다.
# 받은 값은 대화형 zsh만 읽는다(.zshrc). Paseo 데몬·에이전트·LaunchAgent 환경에는 넣지 않는다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"
umask 077

config="${BOOTSTRAP_SECRETS_CONFIG:-$HOME/.config/bootstrap/secrets.env}"
target="$HOME/.zsh_secrets.infisical"
keychain_service='bootstrap-infisical'
timeout_s="${BOOTSTRAP_SECRETS_TIMEOUT:-60}"
export INFISICAL_DISABLE_TELEMETRY=1 NO_COLOR=1

if [[ ! -f "$config" ]]; then
  ok "비밀값 동기화 설정 없음 (쓰려면 README \"비밀값\")"
  exit 0
fi

# 설정 파일은 식별자만 둔다(비밀값 아님). source하지 않고 정해진 키만 읽는다. 줄 끝 `# 주석`과 앞뒤 공백·따옴표는 뗀다.
conf() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$config" | tail -1 |
    sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr -d '"'"'"
}
project="$(conf INFISICAL_PROJECT_ID)"
env_slug="$(conf INFISICAL_ENV)"
folder="$(conf INFISICAL_PATH)"
domain="$(conf INFISICAL_DOMAIN)"
[[ -n "$project" ]] || die "$(pretty "$config")에 INFISICAL_PROJECT_ID가 없습니다"
env_slug="${env_slug:-prod}"
folder="${folder:-/common}"
[[ "$project" =~ ^[A-Za-z0-9-]+$ && "$env_slug" =~ ^[A-Za-z0-9_-]+$ && "$folder" =~ ^/[A-Za-z0-9_/-]*$ ]] ||
  die "$(pretty "$config")의 값 형식이 잘못됐습니다 (프로젝트 ID·환경·경로)"
if [[ -n "$domain" ]]; then
  [[ "$domain" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9/_-]*)?$ ]] || die "INFISICAL_DOMAIN은 https:// 주소여야 합니다"
  export INFISICAL_DOMAIN="$domain"
fi

for tool in infisical node; do
  if ! has "$tool"; then
    if [[ "$DRY_RUN" == 1 ]]; then
      info "[dry-run] $tool 설치 후 비밀값 받기"
      exit 0
    fi
    warn "$tool 명령이 없습니다 → ./bootstrap.sh --only homebrew,runtimes"
    exit 2
  fi
done

work="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-secrets.XXXXXX")"
tmp=''
trap 'rm -rf "$work"; [[ -z "$tmp" ]] || rm -f "$tmp"' EXIT
chmod 700 "$work"

# 명령이 사람 입력을 기다리며 멈추지 않게 입력을 막고 시간을 제한한다: limited <출력 파일> <명령...>
# 제한을 넘기면 TERM, 2초 뒤에도 살아 있으면 KILL을 보낸다. 종료 코드 124는 시간 초과.
limited() {
  local out="$1"
  shift
  "$@" </dev/null >"$out" 2>"$out.err" &
  # 반복 횟수가 아니라 벽시계(SECONDS)로 잰다. 부하가 있으면 sleep 0.1 한 번이 훨씬 길어진다.
  local pid=$! started=$SECONDS termed=0
  while kill -0 "$pid" 2>/dev/null; do
    if ((termed == 0 && SECONDS - started >= timeout_s)); then
      kill -TERM "$pid" 2>/dev/null || true
      printf 'timeout after %ss\n' "$timeout_s" >>"$out.err"
      termed=1
    elif ((termed == 1 && SECONDS - started >= timeout_s + 2)); then
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done
  local status=0
  wait "$pid" 2>/dev/null || status=$?
  if ((termed == 1)); then return 124; fi
  return "$status"
}

# 키체인 값: 못 읽거나 시간을 넘기면 빈 문자열.
keychain() {
  if limited "$work/keychain" security find-generic-password -s "$keychain_service" -a "$1" -w; then
    tr -d '\n' <"$work/keychain"
  fi
  rm -f "$work/keychain"
}

# 인증: 키체인에 기기 계정(Universal Auth)이 있으면 그것을, 없으면 사람 로그인 세션을 쓴다.
# client secret과 토큰은 명령 인자가 아니라 환경 변수로만 넘긴다(ps에 보이지 않게).
client_id="$(keychain client-id)"
if [[ -n "$client_id" ]]; then
  client_secret="$(keychain client-secret)"
  [[ -n "$client_secret" ]] || die "키체인 ${keychain_service}에 client-secret이 없습니다"
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] 기기 계정으로 Infisical 로그인 후 $folder 받기"
    exit 0
  fi
  status=0
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$client_id" INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$client_secret" \
    limited "$work/token" infisical login --method=universal-auth --silent --plain || status=$?
  unset client_secret
  token="$(tr -d '[:space:]' <"$work/token")"
  rm -f "$work/token"
  if [[ "$status" != 0 || -z "$token" ]]; then
    fail "Infisical 기기 계정 로그인 실패 (exit $status): $(head -c 300 "$work/token.err" | tr '\n' ' ')"
    exit 1
  fi
  export INFISICAL_TOKEN="$token"
  unset token
  how='기기 계정'
else
  # 0.45.8: 로그인이 없으면 종료 코드 0과 빈 세션 목록, 만료·거절된 세션이면 종료 코드 1이다. 둘 다 로그인이 필요하다.
  status=0
  limited "$work/status" infisical login status --json || status=$?
  sessions=0
  if [[ "$status" == 0 ]]; then
    sessions="$(node -e 'try { const s = JSON.parse(require("fs").readFileSync(0, "utf8")).sessions; console.log(Array.isArray(s) ? s.length : 0) } catch { console.log(0) }' <"$work/status")"
  fi
  if [[ "$sessions" == 0 ]]; then
    if needs_person 'Infisical 로그인'; then exit 2; fi
    if [[ "$DRY_RUN" == 1 ]]; then
      info '[dry-run] infisical login 후 비밀값 받기'
      exit 0
    fi
    [[ -t 0 ]] || { warn 'Infisical 로그인이 필요합니다 → 터미널에서 infisical login'; exit 2; }
    info 'Infisical에 로그인합니다. 브라우저가 열립니다'
    infisical login ${domain:+--domain="$domain"}
  fi
  how='사람 로그인'
fi

if [[ "$DRY_RUN" == 1 ]]; then
  info "[dry-run] $folder ($env_slug)를 $(pretty "$target")로 받기"
  exit 0
fi

status=0
limited "$work/export.json" infisical export --silent --projectId "$project" --env "$env_slug" --path "$folder" --format json || status=$?
if [[ "$status" != 0 ]]; then
  # 실패해도 stdout에 대화형 화면 문자가 섞여 나오므로 출력은 쓰지 않는다.
  fail "비밀값 받기 실패 (exit $status): $(grep -v '^\s*$' "$work/export.json.err" | head -3 | tr '\n' ' ' | head -c 300)"
  info "기존 $(pretty "$target")는 그대로 둡니다"
  exit 1
fi

# CLI의 dotenv-export는 값 안의 작은따옴표를 이스케이프하지 않아 source할 때 셸 코드가 될 수 있다.
# 그래서 JSON으로 받아 이름을 검사하고 값을 직접 POSIX 작은따옴표로 감싼다('는 '\''로).
status=0
node -e '
const fs = require("fs");
let list;
try { list = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.error("JSON이 아닙니다"); process.exit(3); }
if (!Array.isArray(list)) { console.error("배열이 아닙니다"); process.exit(3); }
const lines = [];
for (const item of list) {
  const key = item && item.key, value = item && item.value;
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { console.error("쓸 수 없는 이름이 있습니다"); process.exit(3); }
  if (item.secretValueHidden === true) { console.error(`${key}: 값을 읽을 권한이 없습니다`); process.exit(3); }
  if (typeof value !== "string" || value.includes("\0")) { console.error(`${key}: 값이 문자열이 아닙니다`); process.exit(3); }
  lines.push(`export ${key}=\x27${value.replace(/\x27/g, "\x27\\\x27\x27")}\x27`);
}
fs.writeFileSync(process.argv[2], lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
console.log(lines.length);
' "$work/export.json" "$work/rendered" >"$work/count" 2>"$work/render.err" || status=$?
if [[ "$status" != 0 ]]; then
  fail "받은 내용을 쓸 수 없어 그대로 둡니다: $(head -c 300 "$work/render.err" | tr '\n' ' ')"
  exit 1
fi
count="$(cat "$work/count")"
# 한 번 더: zsh 문법으로 읽히는지 실행 없이 확인한다.
if ! /bin/zsh -n "$work/rendered" 2>"$work/syntax.err"; then
  fail "만든 파일이 zsh 문법 검사를 통과하지 못해 쓰지 않습니다"
  exit 1
fi

# 같은 폴더에 600으로 쓰고 한 번에 바꾼다. 실패하면 trap이 임시 파일을 지운다.
mkdir -p "$(dirname "$target")"
# 링크는 깨진 것도 거부한다(-e는 깨진 링크에 거짓이라 -L을 따로 본다).
if [[ -L "$target" ]] || [[ -e "$target" && ! -f "$target" ]]; then
  die "$(pretty "$target")가 일반 파일이 아니라 쓰지 않습니다"
fi
tmp="$(mktemp "$target.XXXXXX")"
chmod 600 "$tmp"
{
  printf '# bootstrap secrets 단계가 Infisical(%s %s)에서 받은 값. 직접 고치지 말 것. 기기별 값은 ~/.zsh_secrets\n' "$env_slug" "$folder"
  cat "$work/rendered"
} >"$tmp"
mv -f "$tmp" "$target"
tmp=''
chmod 600 "$target"
mkdir -p "$BOOTSTRAP_STATE/secrets"
printf 'synced_at=%s\ncount=%s\nauth=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$count" "$how" >"$BOOTSTRAP_STATE/secrets/last-sync"
ok "비밀값 ${count}개를 $(pretty "$target")에 받음 ($how). 새 터미널부터 적용"
