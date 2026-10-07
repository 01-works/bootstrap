#!/usr/bin/env bash
# 직접 입력이 필요한 인증: GitHub 로그인, SSH 키. 그래서 마지막 단계다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

# GitHub: git은 https + gh 자격 증명을 쓴다 (development/git.md).
if gh auth status >/dev/null 2>&1; then
  ok "GitHub 로그인 ($(gh api user --jq .login 2>/dev/null || echo '?'))"
else
  run gh auth login --web --git-protocol https
fi
helpers="$(git config --global --get-all credential.https://github.com.helper 2>/dev/null || true)"
if grep 'gh auth git-credential' <<<"$helpers" >/dev/null; then
  ok "git 자격 증명: gh"
else
  run gh auth setup-git
  ok "git 자격 증명을 gh로 설정"
fi

# SSH 키: 다른 기기·서버에 SSH로 접속할 때 쓴다. 기기마다 새로 만들고, 다른 기기의 키를 복사해 오지 않는다.
# git은 https로 쓰므로 GitHub에는 등록하지 않는다 (development/git.md).
if ls "$HOME"/.ssh/id_ed25519* >/dev/null 2>&1; then
  ok "SSH 키 있음 ($(cd "$HOME/.ssh" && ls id_ed25519*.pub | paste -sd ' ' -))"
elif confirm "이 기기용 SSH 키를 만들까요?"; then
  run ssh-keygen -t ed25519 -C "$(scutil --get ComputerName 2>/dev/null || hostname)" -f "$HOME/.ssh/id_ed25519"
fi

# 직접 해야 하는 로그인을 마지막에 한 번에 보여 준다.
printf '\n    남은 로그인:\n'
printf '      %s\n' \
  'claude          처음 실행하면 로그인 안내' \
  'codex           처음 실행하면 "Sign in with ChatGPT"' \
  'vercel          vercel login' \
  'Paseo 앱        실행 후 데몬 설정' \
  'Claude·ChatGPT 앱' \
  'Tailscale 앱    실행 후 로그인'
