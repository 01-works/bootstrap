#!/usr/bin/env bash
# 저장소 설정대로 세팅되어 있는지 검증한다. 아무것도 바꾸지 않는다.
set -uo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

passed=0
failed=0
pending=0
pass() { ok "$*"; passed=$((passed + 1)); }
miss() { fail "$*"; failed=$((failed + 1)); }
wait_for_user() { warn "$*"; pending=$((pending + 1)); }

step "Homebrew"
if has brew; then
  pass "brew"
  # homebrew 단계와 같이 Homebrew 밖에서 설치된 앱은 검사에서 뺀다.
  outside="$("$BOOTSTRAP_ROOT/scripts/brew-outside-casks.sh" "$BOOTSTRAP_ROOT/Brewfile" || true)"
  HOMEBREW_BUNDLE_CASK_SKIP="$(cut -f1 <<<"$outside" | tr '\n' ' ')"
  export HOMEBREW_BUNDLE_CASK_SKIP
  if brew bundle check --file="$BOOTSTRAP_ROOT/Brewfile" --no-upgrade >/dev/null 2>&1; then
    pass "Brewfile"
  else
    miss "Brewfile 설치·등록 상태 불일치:"
    brew bundle check --file="$BOOTSTRAP_ROOT/Brewfile" --no-upgrade --verbose 2>&1 | grep '→' | sed 's/^/      /' | head -30
  fi
  while IFS=$'\t' read -r cask where; do
    [[ -n "$cask" ]] && info "Homebrew 밖에서 설치된 앱 (유지): $cask ($where)"
  done <<<"$outside"
else
  miss "brew 없음"
fi

step "명령어"
for cmd in git gh gitleaks fnm node pnpm colima docker paseo; do
  if has "$cmd"; then pass "$cmd"; else miss "$cmd 없음"; fi
done
for cmd in claude codex uv; do
  if cli_works "$cmd"; then pass "$cmd 실행"; else miss "$cmd 없음 또는 실행 실패 ($(command -v "$cmd" || true))"; fi
done
if vercel --version >/dev/null 2>&1; then pass "vercel"; else miss "vercel 실행 안 됨 (./bootstrap.sh --only runtimes)"; fi
if has node; then
  major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$major" == "$NODE_VERSION" ]]; then pass "Node 기본 버전 $NODE_VERSION"; else miss "Node 기본 버전이 $major (./bootstrap.sh --only runtimes)"; fi
fi

step "설정 파일"
for src_root in "$BOOTSTRAP_ROOT"/home/*; do
  while IFS= read -r src; do
    rel="${src#"$src_root"/}"
    case "$rel" in
      *.seed)
        dst="$HOME/${rel%.seed}"
        if [[ -e "$dst" ]]; then pass "$(pretty "$dst")"; else miss "$(pretty "$dst") 없음"; fi
        ;;
      *)
        dst="$HOME/$rel"
        if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
          pass "$(pretty "$dst")"
        elif [[ -e "$dst" && ! -L "$dst" ]]; then
          # 아직 연결 전이거나, 도구가 링크를 일반 파일로 덮어쓴 경우. 차이를 저장소에 옮긴 뒤 연결한다.
          miss "$(pretty "$dst") 링크가 아니라 일반 파일 → diff $(pretty "$dst") $(pretty "$src") 확인 후 ./bootstrap.sh --only dotfiles"
        else
          miss "$(pretty "$dst") 연결 안 됨"
        fi
        ;;
    esac
  done < <(find "$src_root" \( -type f -o -type l \) ! -name .DS_Store | sort)
done

step "사용자 스킬과 Paseo 프로필·플러그인"
if has node; then
  if node "$BOOTSTRAP_ROOT/scripts/agent-skills.mjs" --check; then
    pass "사용자 스킬"
  else
    miss "사용자 스킬 연결 확인 필요 (./bootstrap.sh --only paseo)"
  fi
  if [[ ! -f "${PASEO_HOME:-$HOME/.paseo}/config.json" ]]; then
    wait_for_user 'Paseo 첫 설정 필요: ./bootstrap.sh --only paseo'
  elif node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs" --check; then
    pass "Paseo 프로필·도구 설정"
  else
    warn "Paseo 프로필·도구 설정 확인 필요 (agents/paseo.md 참고). 기기별 변경은 유지됩니다"
  fi
  if [[ -f "${PASEO_HOME:-$HOME/.paseo}/config.json" ]]; then
    if node "$BOOTSTRAP_ROOT/scripts/paseo-plugins.mjs" --check; then
      pass "Paseo 기본 플러그인"
    else
      warn "Paseo 기본 플러그인 확인 필요 (./bootstrap.sh --only paseo, agents/paseo.md#플러그인)"
    fi
    if node "$BOOTSTRAP_ROOT/scripts/paseo-skills.mjs" --check; then
      pass "Paseo 기본 스킬"
    else
      warn "Paseo 기본 스킬 설치 필요 (./bootstrap.sh --only paseo)"
    fi
  fi
  if ! is_laptop; then
    if node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --check --only paseo --desktop; then
      pass "Paseo 로그인 시 자동 시작"
    else
      miss "Paseo 자동 시작 확인 필요 (./bootstrap.sh --only paseo)"
    fi
  fi
else
  warn "Node가 없어 사용자 스킬·Paseo 프로필 확인을 건너뜁니다"
fi

step "브라우저"
if has node && node "$BOOTSTRAP_ROOT/scripts/browser-use-setup.mjs" --check; then
  pass "Browser Use 실행·Codex/Claude 공식 스킬 (연결 검사는 별도)"
else
  miss "Browser Use 설치/스킬 확인 필요 (./bootstrap.sh --only homebrew,browser)"
fi
if has node; then
  if node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --check --only agent-chrome "$(device_flag)"; then
    pass "에이전트 Chrome 자동 시작·Browser Use 기본 연결"
  else
    miss "에이전트 Chrome 설정 확인 필요 (./bootstrap.sh --only homebrew,browser)"
  fi
  if curl -fsS --max-time 3 http://127.0.0.1:9333/json/version >/dev/null 2>&1; then
    pass "에이전트 Chrome 실행 중 (127.0.0.1:9333)"
  elif is_laptop; then
    info "에이전트 Chrome 꺼짐. 노트북은 필요할 때 시작: launchctl kickstart gui/$(id -u)/local.bootstrap.agent-chrome"
  else
    miss "에이전트 Chrome이 응답하지 않음 (launchctl kickstart gui/$(id -u)/local.bootstrap.agent-chrome)"
  fi
fi

step "전원"
if is_laptop; then label="충전 중에는 잠자기 안 함 (노트북)"; else label="잠자기 꺼짐, 화면 ${DISPLAY_SLEEP_MINUTES}분 뒤 끔, 네트워크로 깨우기·정전 후 자동 켜기"; fi
if power_ok; then pass "$label"; else miss "전원 설정이 다름: $label (./bootstrap.sh --only power)"; fi
if is_laptop; then
  if filevault_off; then wait_for_user 'FileVault 꺼짐 → 노트북은 시스템 설정 > 개인정보 보호 및 보안 > FileVault에서 켜기'; else pass 'FileVault 켬'; fi
else
  if filevault_off; then pass 'FileVault 끔 (무인 재시동용)'; else wait_for_user 'FileVault 켜짐 → 데스크톱은 sudo fdesetup disable 후 ./bootstrap.sh --only auth'; fi
  if autologin_on; then pass "자동 로그인 ($(id -un))"; else wait_for_user '자동 로그인 꺼짐 → ./bootstrap.sh --only auth'; fi
fi

step "원격 접속"
if ! is_laptop; then
  for svc in com.openssh.sshd:원격\ 로그인 com.apple.screensharing:화면\ 공유; do
    if sharing_enabled "${svc%%:*}"; then pass "${svc#*:}"; else wait_for_user "${svc#*:} 꺼짐 → 시스템 설정 > 일반 > 공유에서 켜기"; fi
  done
fi
# 노트북은 로그인만 되어 있으면 된다(앱은 쓸 때 켠다). 데스크톱은 재시동 뒤에도 밖에서 붙도록
# 로그인과 함께 떠서 연결되어 있고 키가 만료되지 않아야 한다.
read -r ts_state ts_expiry <<<"$(tailscale_status)"
if is_laptop; then
  case "$ts_state" in
    Running | Stopped) pass "Tailscale 로그인" ;;
    '') info 'Tailscale 앱이 꺼져 있어 로그인 여부는 확인하지 않음' ;;
    *) wait_for_user "Tailscale $ts_state → 앱에서 로그인" ;;
  esac
else
  case "$ts_state" in
    Running) pass "Tailscale 연결" ;;
    '') wait_for_user 'Tailscale 앱이 꺼져 있음 → 앱을 열고 로그인' ;;
    *) wait_for_user "Tailscale $ts_state → 앱에서 로그인·연결" ;;
  esac
  # 만료 시각은 로그인된 상태에서만 의미가 있다. 로그인 전에는 값이 없어 -로 나온다.
  if [[ "$ts_state" == Running || "$ts_state" == Stopped ]]; then
    if [[ "$ts_expiry" == - ]]; then
      pass "Tailscale 키 만료 꺼짐"
    else
      wait_for_user "Tailscale 키가 ${ts_expiry%%T*}에 만료 → 관리 콘솔 Machines에서 이 기기 Disable key expiry"
    fi
  fi
  if tailscale_starts_on_login; then
    pass "Tailscale 로그인 시 실행"
  else
    warn 'Tailscale 로그인 시 실행이 꺼진 것으로 보임 → 앱 설정에서 켜기 (앱 내부 설정값으로 판단해 틀릴 수 있음)'
  fi
fi

step "인증"
if gh auth status >/dev/null 2>&1; then pass "GitHub 로그인"; else wait_for_user "GitHub 로그인 확인 필요 (gh auth status)"; fi
if git -C "$BOOTSTRAP_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ "$(git -C "$BOOTSTRAP_ROOT" config core.hooksPath 2>/dev/null)" == .githooks ]]; then
    pass "커밋 전 검사 훅"
  else
    miss "커밋 전 검사 훅 꺼짐 (./bootstrap.sh --only xcode)"
  fi
fi
if [[ -f "$HOME/.zsh_secrets" ]]; then
  perm="$(stat -f '%Lp' "$HOME/.zsh_secrets")"
  if [[ "$perm" == 600 ]]; then pass "~/.zsh_secrets 권한 600"; else miss "~/.zsh_secrets 권한이 $perm (chmod 600 필요)"; fi
fi

step "자동 갱신"
if has node && node "$BOOTSTRAP_ROOT/scripts/launch-agents.mjs" --check --only update "$(device_flag)"; then
  pass "자동 갱신 등록 (로그인할 때와 10분마다)"
else
  miss "자동 갱신 확인 필요 (./bootstrap.sh --only autoupdate)"
fi
update_status="$BOOTSTRAP_UPDATE_STATE/status"
case "$(sed -n 's/^result=//p' "$update_status" 2>/dev/null)" in
  failed) miss "$(sed -n 's/^banner=//p' "$update_status")" ;;
  pending | held) wait_for_user "$(sed -n 's/^banner=//p' "$update_status")" ;;
esac
checked="$BOOTSTRAP_UPDATE_STATE/checked"
if [[ ! -e "$checked" ]]; then
  info "저장소 확인 기록 없음 (등록 뒤 첫 주기에 생김)"
elif [[ -z "$(find "$checked" -mmin +1440 2>/dev/null)" ]]; then
  pass "마지막 저장소 확인: $(stat -f '%Sm' -t '%F %T' "$checked")"
else
  warn "하루 넘게 저장소를 확인하지 못함 (마지막: $(stat -f '%Sm' -t '%F %T' "$checked")). 네트워크와 $(pretty "$BOOTSTRAP_UPDATE_STATE")/update.log 확인"
fi

# 공식 확인 방법이 없어 자동으로 검사하지 못하는 것. 새 기기에서 한 번 처리한다 (macos/initial-setup.md).
printf '\n%s직접 확인할 것%s (자동 검사 불가, 새 기기에서 한 번):\n' "$_bold" "$_reset"
printf '    - %s\n' \
  'iCloud 사진·메시지 끄기: 시스템 설정 > Apple 계정 > iCloud' \
  '디스플레이 가장 작은 배율("더 많은 공간"): 시스템 설정 > 디스플레이' \
  'Chrome Beta(에이전트 전용 창)에서 에이전트가 쓸 서비스 로그인'
if ! is_laptop; then
  printf '    - %s\n' \
    'Computer Use: Claude 앱 설정 > 이 컴퓨터에서 켜고, ChatGPT 앱 Plugins > Computer Use 설치' \
    '권한: 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용·화면 녹음에서 Claude, Codex Computer Use 허용'
fi

printf '\n통과 %d, 실패 %d, 수동 작업 대기 %d\n' "$passed" "$failed" "$pending"
[[ "$failed" == 0 ]] || exit 1
[[ "$pending" == 0 ]] || exit 2
exit 0
