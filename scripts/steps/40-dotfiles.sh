#!/usr/bin/env bash
# home/<묶음>/ 아래 파일을 ~ 같은 위치에 심볼릭 링크로 연결한다. 묶음은 프로필의 DOTFILES.
#   - 파일 단위로 링크한다. ~/.claude 같은 폴더 자체는 각 도구의 실행 상태가 섞여 있어서 링크하지 않는다.
#   - 이미 있는 파일은 ~/.local/state/bootstrap/backup/<시각>/ 으로 옮긴 뒤 링크한다.
#   - 이름이 .seed로 끝나는 파일은 대상이 없을 때만 복사한다. 도구가 스스로 고쳐 쓰는 파일용.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

backup_dir="$BOOTSTRAP_STATE/backup/$(date +%Y%m%d-%H%M%S)"

ensure_parent() {
  [[ -d "$(dirname "$1")" ]] || run mkdir -p "$(dirname "$1")"
}

link_file() {
  local src="$1" dst="$2"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    ok "$(pretty "$dst")"
    return
  fi
  if [[ -e "$dst" || -L "$dst" ]]; then
    local bak="$backup_dir/${dst#"$HOME"/}"
    ensure_parent "$bak"
    run mv "$dst" "$bak"
    info "기존 파일 백업 → $(pretty "$bak")"
  fi
  ensure_parent "$dst"
  run ln -s "$src" "$dst"
  ok "$(pretty "$dst") 연결"
}

seed_file() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]]; then
    ok "$(pretty "$dst") (이미 있어서 그대로 둠)"
    return
  fi
  ensure_parent "$dst"
  run cp "$src" "$dst"
  ok "$(pretty "$dst") 기본값 복사"
}

if [[ -z "$DOTFILES" ]]; then
  info "이 프로필은 설정 파일을 연결하지 않습니다"
  exit 0
fi

for pkg in $DOTFILES; do
  src_root="$BOOTSTRAP_ROOT/home/$pkg"
  [[ -d "$src_root" ]] || { warn "home/$pkg 이 없습니다"; continue; }
  info "[$pkg]"
  while IFS= read -r src; do
    rel="${src#"$src_root"/}"
    case "$rel" in
      *.seed) seed_file "$src" "$HOME/${rel%.seed}" ;;
      *) link_file "$src" "$HOME/$rel" ;;
    esac
  done < <(find "$src_root" -type f ! -name .DS_Store | sort)
done
