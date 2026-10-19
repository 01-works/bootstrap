# 로그인 셸 PATH. 시스템 path_helper 다음에 적용된다.
# /etc/paths.d/homebrew는 Homebrew를 시스템 경로 뒤에 붙인다. shellenv로 앞에 두고 HOMEBREW_PREFIX 등도 설정한다.
case "$(uname -m)" in
  arm64) [[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)" ;;
  x86_64) [[ -x /usr/local/bin/brew ]] && eval "$(/usr/local/bin/brew shellenv)" ;;
esac
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"

# Homebrew 설치 전에도 공식 fnm 설치기로 설치한 기존 fnm을 찾는다.
if ! command -v fnm >/dev/null && [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
fi
