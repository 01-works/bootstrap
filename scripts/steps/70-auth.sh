#!/usr/bin/env bash
# 직접 입력이 필요한 인증: GitHub 로그인, 데스크톱 자동 로그인, 남은 로그인 안내. 그래서 마지막 단계다.
# SSH 키는 만들지 않는다. git은 https를 쓰고, 다른 기기로 SSH 접속할 때만 필요하다 (development/git.md).
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# GitHub: git은 https + gh 자격 증명을 쓴다. 일회용 코드는 클립보드에 복사된다.
if gh auth status >/dev/null 2>&1; then
  ok "GitHub 로그인 ($(gh api user --jq .login 2>/dev/null || echo '?'))"
else
  run gh auth login --web --clipboard --git-protocol https
fi
helpers="$(git config --global --get-all credential.https://github.com.helper 2>/dev/null || true)"
if grep 'gh auth git-credential' <<<"$helpers" >/dev/null; then
  ok "git 자격 증명: gh"
else
  run gh auth setup-git
  ok "git 자격 증명을 gh로 설정"
fi

# 데스크톱: 정전 뒤에도 혼자 로그인까지 되도록 자동 로그인을 켠다 (macos/system-settings.md#원격-접속).
# 자동 로그인은 FileVault가 꺼져 있어야 켤 수 있다. FileVault를 끄는 것은 직접 한다(복호화가 끝날 때까지 시간이 걸릴 수 있다, fdesetup status로 확인).
pending=0
if ! is_laptop; then
  if ! filevault_off; then
    warn 'FileVault가 켜져 있거나 복호화 중이라 자동 로그인을 켤 수 없습니다 → sudo fdesetup disable, 복호화가 끝나면 ./bootstrap.sh --only auth'
    pending=2
  elif autologin_on; then
    ok "자동 로그인 ($(id -un))"
  else
    info '자동 로그인을 켭니다. 이 계정의 로그인 비밀번호를 입력하세요'
    run sudo sysadminctl -autologin set -userName "$(id -un)" -password -
    ok "자동 로그인 켬 ($(id -un))"
  fi
fi

# 직접 해야 하는 로그인을 마지막에 한 번에 보여 준다.
printf '\n    남은 로그인:\n'
printf '      %s\n' \
  'claude          터미널에서 처음 실행하면 로그인 안내' \
  'codex           터미널에서 처음 실행하면 "Sign in with ChatGPT"' \
  'vercel          vercel login' \
  'Claude·ChatGPT 앱, Tailscale 앱' \
  'Chrome Beta     에이전트 전용 창. 에이전트가 쓸 서비스에 한 번씩 로그인'

# 처음 한 번만 로그인할 앱을 열어 준다. 에이전트 Chrome은 전용 프로필로 띄워야 하므로 LaunchAgent로 시작한다.
marker="$BOOTSTRAP_STATE/login-apps-opened"
if [[ "$DRY_RUN" != 1 && ! -e "$marker" ]]; then
  for app in Claude ChatGPT Tailscale; do open -a "$app" 2>/dev/null || true; done
  launchctl kickstart "gui/$(id -u)/local.bootstrap.agent-chrome" 2>/dev/null || true
  mkdir -p "$BOOTSTRAP_STATE" && touch "$marker"
  info '로그인할 앱을 열었습니다. Dock의 Chrome Beta 아이콘으로 새로 띄우면 전용 프로필이 아니니, 열린 창에서 로그인하세요'
fi
exit "$pending"
