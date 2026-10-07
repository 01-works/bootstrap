#!/usr/bin/env bash
# 직접 입력이 필요한 인증: GitHub 로그인, SSH 키, 비밀값 파일. 그래서 마지막 단계다.
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

# SSH 키: 기기마다 새로 만든다. 다른 기기의 키를 복사해 오지 않는다.
if ls "$HOME"/.ssh/id_ed25519* >/dev/null 2>&1; then
  ok "SSH 키 있음 ($(cd "$HOME/.ssh" && ls id_ed25519*.pub | paste -sd ' ' -))"
elif confirm "이 기기용 SSH 키를 만들고 GitHub에 등록할까요?"; then
  name="$(scutil --get ComputerName 2>/dev/null || hostname)"
  run ssh-keygen -t ed25519 -C "$name" -f "$HOME/.ssh/id_ed25519"
  run gh ssh-key add "$HOME/.ssh/id_ed25519.pub" --title "$name" ||
    warn "등록 실패. 권한 추가 후 다시: gh auth refresh -s admin:public_key"
fi

# 비밀값: ~/.zsh_secrets (저장소 밖, .zshrc가 읽음)
if [[ -f "$HOME/.zsh_secrets" ]]; then
  ok "$(pretty "$HOME/.zsh_secrets")"
elif contains zsh $DOTFILES; then
  run cp "$BOOTSTRAP_ROOT/templates/zsh_secrets.example" "$HOME/.zsh_secrets"
  run chmod 600 "$HOME/.zsh_secrets"
  warn "~/.zsh_secrets 를 만들었습니다. 값을 채워 넣으세요"
fi

cat <<'EOF'

    남은 수동 설정:
      Tailscale 앱    실행 후 로그인, 설정 → CLI integration → Install Now (tailscale 명령어)
EOF
