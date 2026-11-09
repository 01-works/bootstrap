#!/usr/bin/env bash
# home/<묶음>/ 아래 파일을 ~ 같은 위치에 심볼릭 링크로 연결한다.
#   - 파일 단위로 링크한다. ~/.claude 같은 폴더 자체는 각 도구의 실행 상태가 섞여 있어서 링크하지 않는다.
#   - 이미 있는 파일은 ~/.local/state/bootstrap/backup/<시각>-<번호>/ 으로 옮긴 뒤 링크한다.
#   - 저장소 안의 심볼릭 링크(같은 내용을 두 도구가 쓰는 파일)도 연결 대상이다.
#   - .seed 파일과 claude/.claude/settings.json은 대상이 없을 때만 복사한다. 도구가 스스로 고쳐 쓰는 파일용.
#     기존 링크는 수동 작업 대기로 두고, 명시적인 수동 옵션으로만 일반 파일로 전환한다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

migrate_claude_settings=0
case "${1:-}" in
  '') ;;
  --migrate-claude-settings)
    [[ "$#" == 1 ]] || die '전환 옵션 뒤에는 인자를 받지 않습니다'
    unattended && die '자동 실행에서는 기존 설정 링크를 전환하지 않습니다'
    # comm은 인자를 제외한 실행 파일 경로다. ps를 대역으로 바꿔 테스트할 수 있다.
    processes="$(ps -axo comm=)" || die '프로세스를 조회하지 못해 전환을 거부합니다'
    if printf '%s\n' "$processes" | awk '
      { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); n = split($0, parts, "/"); if (parts[n] == "claude") found = 1 }
      END { exit !found }'; then
      die 'Claude Code(claude)가 실행 중이라 전환을 거부합니다. 모두 종료하고 전환이 끝날 때까지 새로 실행하지 마세요'
    fi
    migrate_claude_settings=1
    ;;
  *) die "알 수 없는 인자: $1" ;;
esac

backup_dir="$BOOTSTRAP_STATE/backup/$(date +%Y%m%d-%H%M%S)-$$"
pending=0
seed_tmp=''
trap '[[ -z "$seed_tmp" ]] || rm -f "$seed_tmp"' EXIT

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
    if [[ "$migrate_claude_settings" != 1 ]]; then
      warn "$(pretty "$dst") 기존 링크 전환 필요: Claude Code를 모두 종료하고 새로 실행하지 않는 동안 ./bootstrap.sh --only dotfiles --migrate-claude-settings 를 한 번 실행하세요. 전환 전에는 갱신 보류가 다시 생길 수 있습니다"
      pending=2
      return
    fi
    local target bak="$backup_dir/${dst#"$HOME"/}"
    target="$(readlink "$dst")"
    [[ -f "$dst" ]] || die "$(pretty "$dst") 링크 대상을 읽을 수 없어 그대로 둡니다"
    if [[ "$DRY_RUN" == 1 ]]; then
      info "[dry-run] $(pretty "$dst") 현재 링크 내용을 백업하고 재확인 후 로컬 일반 파일로 전환"
      return
    fi
    seed_tmp="$(mktemp "$dst.bootstrap.XXXXXX")"
    run cp -pL "$dst" "$seed_tmp"
    ensure_parent "$bak"
    run cp -p "$seed_tmp" "$bak"
    info "기존 링크 내용 백업 → $(pretty "$bak")"
    # 도구가 경로를 원자적으로 저장하거나 링크 대상을 고쳤으면 최신 저장을 유지한다.
    if [[ ! -L "$dst" || "$(readlink "$dst")" != "$target" ]] || ! cmp -s "$dst" "$seed_tmp"; then
      warn "$(pretty "$dst") 전환 중 설정이 바뀌어 보류합니다. 다음 실행에서 다시 확인합니다"
      run rm -f "$seed_tmp"
      seed_tmp=''
      pending=2
      return
    fi
    run mv -f "$seed_tmp" "$dst"
    seed_tmp=''
    if [[ ! -f "$dst" || -L "$dst" ]] || ! cmp -s "$dst" "$bak"; then
      die "$(pretty "$dst") 전환 후 내용 확인 실패. 현재 파일과 백업을 보존합니다: $(pretty "$bak")"
    fi
    ok "$(pretty "$dst") 로컬 일반 파일로 전환"
    return
  fi
  if [[ -e "$dst" ]]; then
    ok "$(pretty "$dst") (이미 있어서 그대로 둠)"
    return
  fi
  ensure_parent "$dst"
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] $(pretty "$dst") 임시 파일에 기본값 복사 후 대상이 없을 때만 생성"
    return
  fi
  seed_tmp="$(mktemp "$dst.bootstrap.XXXXXX")"
  run cp "$src" "$seed_tmp"
  # link(2)로 생성해 확인 이후 다른 프로세스가 만든 경로도 덮어쓰지 않는다.
  # link는 ln과 달리 대상이 디렉터리여도 그 안에 파일을 만들지 않는다.
  if run link "$seed_tmp" "$dst" 2>/dev/null; then
    ok "$(pretty "$dst") 기본값 복사"
  elif [[ -e "$dst" || -L "$dst" ]]; then
    ok "$(pretty "$dst") (다른 프로세스가 생성해서 그대로 둠)"
  else
    fail "$(pretty "$dst") 기본값 생성 실패"
    run rm -f "$seed_tmp"
    seed_tmp=''
    return 1
  fi
  run rm -f "$seed_tmp"
  seed_tmp=''
}

for src_root in "$BOOTSTRAP_ROOT"/home/*; do
  info "[$(basename "$src_root")]"
  while IFS= read -r src; do
    if [[ "$migrate_claude_settings" == 1 && "$src" != "$BOOTSTRAP_ROOT/home/claude/.claude/settings.json" ]]; then
      continue
    fi
    rel="${src#"$src_root"/}"
    case "${src#"$BOOTSTRAP_ROOT/home/"}" in
      *.seed | claude/.claude/settings.json) seed_file "$src" "$HOME/${rel%.seed}" ;;
      *) link_file "$src" "$HOME/$rel" ;;
    esac
  done < <(find "$src_root" \( -type f -o -type l \) ! -name .DS_Store | sort)
done
exit "$pending"
