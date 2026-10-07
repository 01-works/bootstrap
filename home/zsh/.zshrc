export PATH="$HOME/.local/bin:$PATH"
alias clauded='claude --dangerously-skip-permissions'

# pnpm
export PNPM_HOME="$HOME/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME/bin:"*) ;;
  *) export PATH="$PNPM_HOME/bin:$PATH" ;;
esac
# pnpm end

alias codexa='codex --dangerously-bypass-approvals-and-sandbox'
alias codexd='codex --dangerously-bypass-approvals-and-sandbox'

[[ -f "$HOME/.zsh_secrets" ]] && source "$HOME/.zsh_secrets"

# Node versions and automatic project switching.
command -v fnm >/dev/null && eval "$(fnm env --use-on-cd --version-file-strategy recursive --shell zsh)"

# 이 기기에만 필요한 설정 (저장소에 넣지 않음)
if [[ -f "$HOME/.zshrc.local" ]]; then source "$HOME/.zshrc.local"; fi
