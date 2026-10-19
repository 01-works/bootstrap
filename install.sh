#!/bin/bash
# 새 Mac에서 한 줄로 시작한다: 저장소를 받은 뒤 bootstrap.sh를 실행한다.
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/01-works/bootstrap/main/install.sh)"
# bootstrap.sh에 인자를 넘기려면 뒤에 이름 하나를 두고 이어 쓴다:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/01-works/bootstrap/main/install.sh)" install --dry-run
# 이미 받은 저장소가 있으면 갱신(fast-forward)만 하고 실행한다. 위치는 BOOTSTRAP_DIR로 바꿀 수 있다.
set -euo pipefail

repo="${BOOTSTRAP_REPO:-https://github.com/01-works/bootstrap.git}"
dir="${BOOTSTRAP_DIR:-$HOME/dev/bootstrap}"

say() { printf '==> %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# https·ssh 주소를 같은 저장소로 비교하기 위해 "소유자/이름"만 남긴다.
slug() {
  local url="${1%.git}" name rest
  url="${url%/}"
  name="${url##*/}"
  rest="${url%/*}"
  printf '%s/%s' "${rest##*[:/]}" "$name"
}

[[ "$(uname -s)" == Darwin ]] || die 'macOS 전용입니다'
case "$(uname -m)" in
  arm64 | x86_64) ;;
  *) die '64비트 Intel 또는 Apple Silicon Mac이 필요합니다' ;;
esac
[[ "$(id -u)" != 0 ]] || die 'sudo 없이 실행하세요. 관리자 권한이 필요한 곳에서만 따로 묻습니다'

# git은 Xcode 명령줄 도구에 들어 있다. 없으면 설치 창을 띄우고 끝날 때까지 기다린다.
if ! xcode-select -p >/dev/null 2>&1; then
  say 'Xcode 명령줄 도구 설치: 뜨는 창에서 설치를 누르고 끝날 때까지 기다립니다 (중단: Ctrl-C)'
  xcode-select --install >/dev/null 2>&1 || true
  until xcode-select -p >/dev/null 2>&1; do sleep 5; done
fi

if [[ -d "$dir/.git" ]]; then
  origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  [[ -n "$origin" && "$(slug "$origin")" == "$(slug "$repo")" ]] ||
    die "$dir 는 다른 저장소입니다 (origin: ${origin:-없음}). BOOTSTRAP_DIR로 다른 위치를 지정하세요"
  say "기존 저장소 갱신: $dir"
  git -C "$dir" pull --ff-only || die "git pull 실패. $dir 의 로컬 변경·브랜치를 정리한 뒤 다시 실행하세요"
elif [[ -e "$dir" ]]; then
  die "$dir 가 이미 있고 git 저장소가 아닙니다. 옮기거나 BOOTSTRAP_DIR로 다른 위치를 지정하세요"
else
  say "저장소 받기: $repo → $dir"
  mkdir -p "$(dirname "$dir")"
  git clone "$repo" "$dir"
fi

say "실행: $dir/bootstrap.sh $*"
exec "$dir/bootstrap.sh" "$@"
