#!/usr/bin/env bash
# 에이전트 세션의 gh·git push를 에이전트 전용 GitHub App 신원으로 돌리는 yw-gh를 설치한다. 동작·키 배치: agents/github-app.md
# 모든 기기에 설치한다. 에이전트 모드는 App 설정이 없으면 소유자 인증으로 넘어가지 않고 실패하므로, 설정도 기기 단위 끄기 파일
# (~/.config/yw-gh-app/disabled)도 없으면 수동 작업 대기(2)로 알린다. 끄기 파일은 사람이 명시적으로 만든다 (이 단계는 만들지 않는다).
# yw-heavy처럼 같은 디렉터리에 복사본을 만든 뒤 mv로 바꾼다. 저장소로 연결하는 링크는 쓰지 않는다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

config_dir="${YW_GH_APP_CONFIG_DIR:-$HOME/.config/yw-gh-app}"
bin_dir="$HOME/.local/bin"
front="$bin_dir/gh"
core="$HOME/.local/share/yw-gh/yw-gh-app.mjs"
marker='# yw-gh: '

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

# gh auth setup-git이 실제 gh 절대 경로를 helper로 적었으면 에이전트의 git push가 이 앞단을 건너뛴다. 고치지는 않고 알린다.
pending=0
if git config --global --get-regexp '^credential\..*helper$' 2>/dev/null | grep -qF "$real"; then
  if [[ -L "$HOME/.gitconfig" ]]; then
    warn "~/.gitconfig(저장소 home/git/.gitconfig 링크)의 credential helper가 실제 gh를 직접 가리킵니다. 저장소에서 그 파일 변경을 되돌리세요 (git checkout home/git/.gitconfig)"
  else
    warn "~/.gitconfig의 credential helper가 실제 gh를 직접 가리킵니다. 값을 '!gh auth git-credential'로 바꾸세요"
  fi
  pending=2
fi

if [[ -e "$config_dir/disabled" ]]; then
  info "끄기 파일이 있어 이 기기의 에이전트도 소유자 gh를 씁니다 ($(pretty "$config_dir/disabled"))"
elif [[ ! -f "$config_dir/config.json" ]]; then
  warn "App 설정이 없어 이 기기 에이전트의 gh가 실패합니다. 키를 배치하거나 기기 단위로 끄세요 (agents/github-app.md)"
  pending=2
fi
exit "$pending"
