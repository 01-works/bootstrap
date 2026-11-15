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

# 명령어 자동 완성. Homebrew가 넣어 둔 brew·gh·docker·colima·fnm 등의 자동 완성을 쓴다.
autoload -Uz compinit && compinit

# bootstrap 자동 갱신이 실패·수동 작업 대기·보류 상태이거나 하루 넘게 저장소를 확인하지 못했으면 한 줄 알린다.
# 상태 파일만 읽는다 (네트워크 안 씀). 기록은 scripts/update.sh가 남긴다.
() {
  local dir="${XDG_STATE_HOME:-$HOME/.local/state}/bootstrap/update"
  local agent="$HOME/Library/LaunchAgents/local.bootstrap.update.plist" since line
  local repo="${${(%):-%x}:A:h:h:h}"  # ~/.zshrc는 저장소의 home/zsh/.zshrc를 가리킨다
  [[ -f "$agent" ]] || return 0
  if [[ -f "$dir/status" ]]; then
    for line in "${(@f)$(<"$dir/status")}"; do
      [[ "$line" == banner=?* ]] && print -r -- "! ${line#banner=}"
    done
  fi
  # 확인 기록이 아직 없으면 등록한 때부터 센다.
  since="$dir/checked"
  [[ -e "$since" ]] || since="$agent"
  local -a recent=("$since"(N.mh-24))
  (( $#recent )) || print -r -- "! bootstrap 자동 갱신이 하루 넘게 저장소를 확인하지 못했습니다 → ${(D)repo}/bootstrap.sh doctor"
}

# 이 기기에만 필요한 설정 (저장소에 넣지 않음)
if [[ -f "$HOME/.zshrc.local" ]]; then source "$HOME/.zshrc.local"; fi
