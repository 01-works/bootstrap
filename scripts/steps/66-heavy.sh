#!/usr/bin/env bash
# 공용 heavy 대기열 도구 yw-heavy를 ~/.local/bin에 설치한다. 모든 기기가 같다. 사용법·전환 절차는 agents/heavy-queue.md.
# 실행 중인 대기자가 이전 파일을 끝까지 읽도록 복사본을 같은 디렉터리에 만든 뒤 mv로 바꾼다. 저장소로 연결하는 링크는 쓰지 않는다
# (브랜치·worktree를 바꾸면 실행 중인 도구가 바뀐다). 예전 경로 /tmp/cc-yw-heavy.sh는 없을 때만 링크로 만들고, 있으면 그대로 둔다.
# /tmp는 재시동 때 비워진다. 링크는 이 단계가 다시 돌 때(yw-heavy 변경, 전체 설치, --only heavy)만 생긴다. 정식 경로는 ~/.local/bin/yw-heavy다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

src="$BOOTSTRAP_ROOT/scripts/yw-heavy.sh"
dst="$HOME/.local/bin/yw-heavy"
compat="${YW_HEAVY_COMPAT_PATH:-/tmp/cc-yw-heavy.sh}"
lockf="${YW_HEAVY_LOCKF_CHECK:-/usr/bin/lockf}"  # 테스트가 대역으로 바꾼다

# yw-heavy는 열어 둔 fd에 lockf를 거는 방식(fd 모드)으로 대기열 편집을 직렬화한다. 실제로 되는지 확인한다.
check="$(mktemp "${TMPDIR:-/tmp}/yw-heavy-lockf.XXXXXX")"
if ! (exec 9>"$check" && "$lockf" -s -t 0 9) 2>/dev/null; then
  rm -f "$check"
  die "$lockf 의 fd 모드 잠금이 동작하지 않습니다. yw-heavy를 설치하지 않습니다"
fi
rm -f "$check"

if [[ -x "$dst" ]] && cmp -s "$src" "$dst"; then
  ok "yw-heavy ($(pretty "$dst"))"
elif [[ "$DRY_RUN" == 1 ]]; then
  info "[dry-run] $(pretty "$dst")를 저장소 원본으로 교체 (복사 후 mv)"
else
  mkdir -p "$(dirname "$dst")"
  tmp="$(mktemp "$(dirname "$dst")/.yw-heavy.XXXXXX")"
  if ! { cp "$src" "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$dst"; }; then
    rm -f "$tmp"
    die "yw-heavy 설치 실패: $(pretty "$dst")"
  fi
  ok "yw-heavy 설치 ($(pretty "$dst"))"
fi

if [[ -L "$compat" && "$(readlink "$compat")" == "$dst" ]]; then
  ok "$compat → $(pretty "$dst")"
elif [[ -e "$compat" || -L "$compat" ]]; then
  info "$compat 는 이미 있어 그대로 둡니다. 새 도구로 바꾸는 절차는 agents/heavy-queue.md"
elif [[ "$DRY_RUN" == 1 ]]; then
  info "[dry-run] $compat → $(pretty "$dst") 링크"
elif ln -s "$dst" "$compat" 2>/dev/null; then
  # 링크 생성은 원자적이고, 그 사이 다른 파일이 생겼으면 덮어쓰지 않고 실패한다.
  ok "$compat → $(pretty "$dst")"
else
  info "$compat 를 만들지 못해 그대로 둡니다. 새 도구는 $(pretty "$dst")로 쓸 수 있습니다"
fi
