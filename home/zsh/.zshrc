export PATH="$HOME/.local/bin:$PATH"
alias clauded='claude --dangerously-skip-permissions'

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# pnpm
export PNPM_HOME="$HOME/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME/bin:"*) ;;
  *) export PATH="$PNPM_HOME/bin:$PATH" ;;
esac
# pnpm end

tl() {
  local session picked query key
  local -a picked_lines

  if (( $# > 0 )); then
    session="$1"
  else
    if ! command -v fzf >/dev/null 2>&1; then
      echo "tl: fzf is required for interactive selection" >&2
      return 1
    fi

    picked=$(tmux list-sessions -F '#S' 2>/dev/null \
      | fzf --prompt='tmux> ' --height=40% --reverse --border \
          --header='Enter: attach  Ctrl-N: create typed name' \
          --expect=ctrl-n --print-query \
          --bind 'enter:accept-or-print-query') || return

    picked_lines=("${(@f)picked}")
    query="${picked_lines[1]}"
    key="${picked_lines[2]}"
    session="${picked_lines[3]}"
    [[ "$key" == "ctrl-n" ]] && session="$query"
    [[ -z "$session" ]] && session="$query"
  fi

  [[ -z "$session" ]] && return 1

  if [[ -n "$TMUX" ]]; then
    tmux has-session -t "=$session" 2>/dev/null || tmux new-session -d -s "$session"
    tmux switch-client -t "=$session"
  else
    tmux new-session -A -s "$session"
  fi
}

td() {
  if [[ -z "$TMUX" ]]; then
    echo "td: not inside tmux" >&2
    return 1
  fi

  tmux detach-client
}

tk() {
  local session

  if (( $# > 0 )); then
    session="$1"
  else
    if [[ -z "$TMUX" ]]; then
      echo "tk: pass a session name or run inside tmux" >&2
      return 1
    fi
    session=$(tmux display-message -p '#S')
  fi

  [[ -z "$session" ]] && return 1

  read -q "confirm?kill tmux session '$session'? [y/N] " || {
    echo
    return 1
  }
  echo

  tmux kill-session -t "=$session"
}

alias codexa='codex --dangerously-bypass-approvals-and-sandbox'
alias codexd='codex --dangerously-bypass-approvals-and-sandbox'

# VS Code CLI selectors.
vscode() { "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" "$@" }
code() { vscode "$@" }

[[ -f "$HOME/.zsh_secrets" ]] && source "$HOME/.zsh_secrets"

# Node versions and automatic project switching.
command -v fnm >/dev/null && eval "$(fnm env --use-on-cd --version-file-strategy recursive --shell zsh)"

# 이 기기에만 필요한 설정 (저장소에 넣지 않음)
if [[ -f "$HOME/.zshrc.local" ]]; then source "$HOME/.zshrc.local"; fi
