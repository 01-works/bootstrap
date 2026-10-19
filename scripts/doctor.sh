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
  if brew bundle check --file="$BOOTSTRAP_ROOT/Brewfile" --no-upgrade >/dev/null 2>&1; then
    pass "Brewfile"
  else
    miss "Brewfile 설치·등록 상태 불일치 (앱이 있어도 Homebrew 미등록이면 표시됨):"
    brew bundle check --file="$BOOTSTRAP_ROOT/Brewfile" --no-upgrade --verbose 2>&1 | grep '→' | sed 's/^/      /' | head -30
  fi
else
  miss "brew 없음"
fi

step "명령어"
for cmd in git gh gitleaks fnm node pnpm colima docker paseo; do
  if has "$cmd"; then pass "$cmd"; else miss "$cmd 없음"; fi
done
for cmd in claude codex; do
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

step "사용자 스킬과 Paseo 프로필"
if has node; then
  if node "$BOOTSTRAP_ROOT/scripts/agent-skills.mjs" --check; then
    pass "사용자 스킬"
  else
    miss "사용자 스킬 연결 확인 필요 (./bootstrap.sh --only paseo)"
  fi
  if [[ ! -f "${PASEO_HOME:-$HOME/.paseo}/config.json" ]]; then
    wait_for_user 'Paseo 앱 초기 설정 후 ./bootstrap.sh --only paseo'
  elif node "$BOOTSTRAP_ROOT/scripts/paseo-profiles.mjs" --check; then
    pass "Paseo 프로필·도구 설정"
  else
    warn "Paseo 프로필·도구 설정 확인 필요 (agents/paseo.md 참고). 기기별 변경은 유지됩니다"
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
  browser_status=0
  node "$BOOTSTRAP_ROOT/scripts/browser-settings.mjs" --check || browser_status=$?
  if [[ "$browser_status" == 0 ]]; then
    pass "개인 Chrome 승인형 원격 디버깅 설정 (요청 시 연결, 승인은 사용자)"
  elif [[ "$browser_status" == 2 ]]; then
    wait_for_user '개인 Chrome 설정 대기 (위 안내 참고)'
  else
    miss "개인 Chrome 설정 확인 필요 (agents/browser.md 참고)"
  fi
fi

step "전원"
if is_laptop; then label="충전 중에는 잠자기 안 함 (노트북)"; else label="잠자기·화면 잠자기 꺼짐, 네트워크로 깨우기 켬"; fi
if power_ok; then pass "$label"; else miss "전원 설정이 다름: $label (./bootstrap.sh --only power)"; fi

step "인증"
if gh auth status >/dev/null 2>&1; then pass "GitHub 로그인"; else wait_for_user "GitHub 로그인 확인 필요 (gh auth status)"; fi
if [[ -d "$BOOTSTRAP_ROOT/.git" ]]; then
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

printf '\n통과 %d, 실패 %d, 수동 작업 대기 %d\n' "$passed" "$failed" "$pending"
[[ "$failed" == 0 ]] || exit 1
[[ "$pending" == 0 ]] || exit 2
exit 0
