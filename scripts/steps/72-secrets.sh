#!/usr/bin/env bash
# 비밀값 동기화: Infisical의 한 폴더를 ~/.zsh_secrets.infisical로 받는다 (README "비밀값").
# 설정(~/.config/bootstrap/secrets.env)이 없는 기기는 아무것도 하지 않는다. 손으로 쓰는 ~/.zsh_secrets는 건드리지 않는다.
# 받은 값은 대화형 zsh만 읽는다(.zshrc). Paseo 데몬·에이전트·LaunchAgent 환경에는 넣지 않는다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

config="${BOOTSTRAP_SECRETS_CONFIG:-$HOME/.config/bootstrap/secrets.env}"
target="$HOME/.zsh_secrets.infisical"
keychain_service='bootstrap-infisical'
timeout_s="${BOOTSTRAP_SECRETS_TIMEOUT:-60}"
export INFISICAL_DISABLE_TELEMETRY=1 NO_COLOR=1

if [[ ! -f "$config" ]]; then
  ok "비밀값 동기화 설정 없음 (쓰려면 README \"비밀값\")"
  exit 0
fi

# 설정 파일은 식별자만 둔다(비밀값 아님). source하지 않고 정해진 키만 읽는다.
conf() { sed -n "s/^$1=//p" "$config" | tail -1 | tr -d '"'"'"; }
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

if ! has infisical; then
  if [[ "$DRY_RUN" == 1 ]]; then
    info '[dry-run] Infisical CLI 설치 후 비밀값 받기'
    exit 0
  fi
  warn 'Infisical CLI가 없습니다 → ./bootstrap.sh --only homebrew'
  exit 2
fi

# 명령이 사람 입력을 기다리며 멈추지 않게 입력을 막고 시간을 제한한다: limited <출력 파일> <명령...>
limited() {
  local out="$1"
  shift
  "$@" </dev/null >"$out" 2>"$out.err" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if ((waited >= timeout_s * 10)); then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      printf 'timeout after %ss\n' "$timeout_s" >>"$out.err"
      return 124
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid"
}

work="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-secrets.XXXXXX")"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# 인증: 키체인에 기기 계정(Universal Auth)이 있으면 그것을, 없으면 사람 로그인 세션을 쓴다.
# client secret과 토큰은 명령 인자가 아니라 환경 변수로만 넘긴다(ps에 보이지 않게).
client_id="$(security find-generic-password -s "$keychain_service" -a client-id -w 2>/dev/null || true)"
if [[ -n "$client_id" ]]; then
  client_secret="$(security find-generic-password -s "$keychain_service" -a client-secret -w 2>/dev/null || true)"
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
  if [[ "$status" != 0 || -z "$token" ]]; then
    fail "Infisical 기기 계정 로그인 실패 (exit $status): $(head -c 300 "$work/token.err" | tr '\n' ' ')"
    exit 1
  fi
  export INFISICAL_TOKEN="$token"
  unset token
  how='기기 계정'
else
  # login status는 로그인 여부와 관계없이 0으로 끝나므로 세션 목록을 본다.
  sessions="$(infisical login status --json 2>/dev/null || true)"
  if ! grep -q '"sessions": *\[ *{' <<<"$(tr -d '\n' <<<"$sessions")"; then
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
limited "$work/export" infisical export --silent --projectId "$project" --env "$env_slug" --path "$folder" --format dotenv-export || status=$?
if [[ "$status" != 0 ]]; then
  # 실패해도 stdout에 대화형 화면 문자가 섞여 나오므로 출력은 쓰지 않는다.
  fail "비밀값 받기 실패 (exit $status): $(grep -v '^\s*$' "$work/export.err" | head -3 | tr '\n' ' ' | head -c 300)"
  info "기존 $(pretty "$target")는 그대로 둡니다"
  exit 1
fi

# 모든 줄이 `export 이름=값` 한 줄이어야 한다. 여러 줄 값이나 다른 출력이 섞이면 쓰지 않는다.
count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  if [[ ! "$line" =~ ^export\ [A-Za-z_][A-Za-z0-9_]*= ]]; then
    fail "받은 내용에 export 줄이 아닌 것이 있어 쓰지 않습니다 (여러 줄 값은 지원하지 않음)"
    exit 1
  fi
  count=$((count + 1))
done <"$work/export"

# 같은 폴더에 600으로 쓰고 한 번에 바꾼다.
mkdir -p "$(dirname "$target")"
tmp="$(mktemp "$target.XXXXXX")"
chmod 600 "$tmp"
{
  printf '# bootstrap secrets 단계가 Infisical(%s %s)에서 받은 값. 직접 고치지 말 것. 기기별 값은 ~/.zsh_secrets\n' "$env_slug" "$folder"
  cat "$work/export"
} >"$tmp"
mv -f "$tmp" "$target"
chmod 600 "$target"
mkdir -p "$BOOTSTRAP_STATE/secrets"
printf 'synced_at=%s\ncount=%s\nauth=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$count" "$how" >"$BOOTSTRAP_STATE/secrets/last-sync"
ok "비밀값 ${count}개를 $(pretty "$target")에 받음 ($how). 새 터미널부터 적용"
