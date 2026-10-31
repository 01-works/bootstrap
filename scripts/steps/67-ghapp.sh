#!/usr/bin/env bash
# 에이전트 세션의 gh·git push를 에이전트 전용 GitHub App 신원으로 돌리는 yw-gh를 설치한다. 동작·키 배치: agents/github-app.md
# 이 기기에 App 설정(~/.config/yw-gh-app/config.json)이 있을 때만 설치한다. 설정이 없으면 아무것도 바꾸지 않는다.
# 설치하고 나면 에이전트 모드는 설정이 사라져도 소유자 인증으로 넘어가지 않고 실패한다.
# yw-heavy처럼 같은 디렉터리에 복사본을 만든 뒤 mv로 바꾼다. 저장소로 연결하는 링크는 쓰지 않는다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

config_dir="${YW_GH_APP_CONFIG_DIR:-$HOME/.config/yw-gh-app}"
bin_dir="$HOME/.local/bin"
front="$bin_dir/gh"
core="$HOME/.local/share/yw-gh/yw-gh-app.mjs"
marker='# yw-gh: '

if [[ ! -f "$config_dir/config.json" ]]; then
  if [[ -f "$front" ]] && grep -q "^$marker" "$front"; then
    warn "App 설정이 없는데 yw-gh가 설치되어 있습니다. 에이전트의 gh가 실패합니다 (agents/github-app.md)"
  else
    info "App 설정이 없어 yw-gh를 설치하지 않습니다. 에이전트는 소유자 gh를 씁니다 (켜기: agents/github-app.md)"
  fi
  exit 0
fi

if [[ -e "$front" ]] && ! grep -q "^$marker" "$front"; then
  die "$(pretty "$front")가 이미 있고 yw-gh가 아닙니다. 옮긴 뒤 다시 실행하세요"
fi

# 실제 gh: PATH에서 ~/.local/bin을 뺀 첫 gh. 설치본에 절대 경로로 적어 앞단이 자기 자신을 다시 부르지 않게 한다.
real=''
IFS=: read -r -a path_dirs <<<"${YW_GH_SEARCH_PATH:-$PATH}"  # 테스트가 대역으로 바꾼다 (lib.sh가 PATH에 brew를 앞세운다)
for d in "${path_dirs[@]}"; do
  [[ -n "$d" && "$d" != "$bin_dir" && "$d" != "$bin_dir/" ]] || continue
  if [[ -x "$d/gh" && ! -d "$d/gh" ]]; then
    real="$d/gh"
    break
  fi
done
[[ -n "$real" ]] || die "실제 gh를 찾지 못했습니다 (brew install gh)"
case "$real$core$front" in
  *"'"*) die "경로에 작은따옴표가 있어 설치하지 않습니다: $real" ;;
esac

# install_copy <원본 내용 파일> <대상>
install_copy() {
  local src="$1" dst="$2" tmp
  if [[ -x "$dst" ]] && cmp -s "$src" "$dst"; then
    ok "$(pretty "$dst")"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] $(pretty "$dst")를 저장소 원본으로 교체 (복사 후 mv)"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  tmp="$(mktemp "$(dirname "$dst")/.yw-gh.XXXXXX")"
  if ! { cp "$src" "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$dst"; }; then
    rm -f "$tmp"
    die "yw-gh 설치 실패: $(pretty "$dst")"
  fi
  ok "설치 ($(pretty "$dst"))"
}

rendered="$(mktemp "${TMPDIR:-/tmp}/yw-gh-front.XXXXXX")"
trap 'rm -f "$rendered"' EXIT
content="$(cat "$BOOTSTRAP_ROOT/scripts/yw-gh.sh")"
content="${content//__YW_GH_REAL__/$real}"
content="${content//__YW_GH_CORE__/$core}"
content="${content//__YW_GH_SELF__/$front}"
printf '%s\n' "$content" >"$rendered"

install_copy "$BOOTSTRAP_ROOT/scripts/yw-gh-app.mjs" "$core"
install_copy "$rendered" "$front"
info "실제 gh: $(pretty "$real")"
