#!/usr/bin/env bash
# home/<묶음>/ 아래 파일을 ~ 같은 위치에 심볼릭 링크로 연결한다.
#   - 파일 단위로 링크한다. ~/.claude 같은 폴더 자체는 각 도구의 실행 상태가 섞여 있어서 링크하지 않는다.
#   - 이미 있는 파일은 ~/.local/state/bootstrap/backup/<시각>-<번호>/ 으로 옮긴 뒤 링크한다.
#   - 저장소 안의 심볼릭 링크(같은 내용을 두 도구가 쓰는 파일)도 연결 대상이다.
#   - 이름이 .seed로 끝나는 파일은 대상이 없을 때만 복사한다. 도구가 스스로 고쳐 쓰는 파일용.
#     기존 링크는 내용을 백업한 뒤 같은 내용의 로컬 일반 파일로 바꾼다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

backup_dir="$BOOTSTRAP_STATE/backup/$(date +%Y%m%d-%H%M%S)-$$"

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
    # 도구가 링크를 일반 파일로 바꿔 놓고 내용을 고쳤을 수 있다. 저장소에 옮길 게 있는지 알린다.
    if [[ -f "$dst" && ! -L "$dst" ]] && ! cmp -s "$dst" "$src"; then
      warn "$(pretty "$dst")의 내용이 저장소와 다릅니다. 필요한 변경은 저장소로 옮기세요: diff $(pretty "$bak") $(pretty "$src")"
    fi
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
  if [[ -L "$dst" ]]; then
    local content="$dst" bak="$backup_dir/${dst#"$HOME"/}"
    if [[ ! -f "$dst" ]]; then
      # settings.json → settings.json.seed를 받은 직후에는 예전 저장소 링크가 끊겨 있다.
      # 이 전환의 seed는 예전 파일과 내용이 같고, update는 실제 값 변경이 있으면 받지 않는다.
      if [[ "$src" == "$BOOTSTRAP_ROOT/home/claude/.claude/settings.json.seed" && "$(readlink "$dst")" == "${src%.seed}" ]]; then
        content="$src"
      else
        die "$(pretty "$dst") 링크 대상을 읽을 수 없어 그대로 둡니다"
      fi
    fi
    ensure_parent "$bak"
    run cp -pL "$content" "$bak"
    info "기존 링크 내용 백업 → $(pretty "$bak")"
    # 백업과 별도로 복사해 둔 일반 파일로 링크를 교체한다. 복사 실패 시 링크는 유지된다.
    run cp -p "$bak" "$bak.local"
    run mv -f "$bak.local" "$dst"
    ok "$(pretty "$dst") 로컬 일반 파일로 전환"
    return
  fi
  if [[ -e "$dst" ]]; then
    ok "$(pretty "$dst") (이미 있어서 그대로 둠)"
    return
  fi
  ensure_parent "$dst"
  run cp "$src" "$dst"
  ok "$(pretty "$dst") 기본값 복사"
}

for src_root in "$BOOTSTRAP_ROOT"/home/*; do
  info "[$(basename "$src_root")]"
  while IFS= read -r src; do
    rel="${src#"$src_root"/}"
    case "$rel" in
      *.seed) seed_file "$src" "$HOME/${rel%.seed}" ;;
      *) link_file "$src" "$HOME/$rel" ;;
    esac
  done < <(find "$src_root" \( -type f -o -type l \) ! -name .DS_Store | sort)
done
