# 로그인 셸 PATH. 시스템 path_helper 다음에 적용된다.
# /etc/paths.d/homebrew는 Homebrew를 시스템 경로 뒤에 붙인다. shellenv로 앞에 두고 HOMEBREW_PREFIX 등도 설정한다.
[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"
