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
key_status=0
ssh_key_state "$HOME/.ssh/id_ed25519" || key_status=$?
pending=0
if [[ "$key_status" == 0 ]]; then
  ok 'SSH 개인키 파일 있음 (~/.ssh/id_ed25519, 실제 접속은 별도 확인)'
elif [[ "$key_status" == 2 ]]; then
  warn '기본 SSH 키가 불완전합니다. 공개키·기존 파일은 유지했습니다. development/git.md를 확인하세요'
  pending=2
elif confirm "이 기기용 SSH 키를 만들까요?"; then
  run ssh-keygen -t ed25519 -C "$(scutil --get ComputerName 2>/dev/null || hostname)" -f "$HOME/.ssh/id_ed25519"
else
  warn '기본 SSH 키 생성 보류. 필요할 때 ./bootstrap.sh --only auth'
fi

# 직접 해야 하는 로그인을 마지막에 한 번에 보여 준다.
printf '\n    남은 로그인:\n'
printf '      %s\n' \
  'claude          처음 실행하면 로그인 안내' \
  'codex           처음 실행하면 "Sign in with ChatGPT"' \
  'vercel          vercel login' \
  'Paseo 앱        실행 후 데몬 설정 → ./bootstrap.sh --only browser,paseo' \
  'Chrome          종료 후 browser 단계로 자동 설정; 연결 허용 창은 직접 승인' \
  'Claude·ChatGPT 앱' \
  'Tailscale 앱    실행 후 로그인'
exit "$pending"
