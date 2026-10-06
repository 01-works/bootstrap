# 로그인 셸 PATH. 시스템 path_helper 다음에 적용된다.
# Homebrew 설치 스크립트는 /etc/paths.d를 만들지 않으므로 여기서 brew를 PATH에 넣는다.
[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"
