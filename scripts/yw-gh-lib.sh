#!/usr/bin/env bash
# ghapp 단계(scripts/steps/67-ghapp.sh)와 doctor가 함께 쓰는 yw-gh 판정. 동작: agents/github-app.md
# 새 Mac의 bash 3.2에서 돈다. 설치된 앞단(scripts/yw-gh.sh)은 이 파일 없이 혼자 돌므로 끄기 파일 판정을 따로 갖고 있다. 둘을 같이 고친다.

# yw_gh_find_real <제외할 디렉터리>: PATH(테스트는 YW_GH_SEARCH_PATH)에서 그 디렉터리를 뺀 첫 gh. lib.sh가 PATH에 brew를 앞세운다.
yw_gh_find_real() {
  local skip="$1" d dirs
  IFS=: read -r -a dirs <<<"${YW_GH_SEARCH_PATH:-$PATH}"
  for d in "${dirs[@]}"; do
    [[ -n "$d" && "$d" != "$skip" && "$d" != "$skip/" ]] || continue
    if [[ -x "$d/gh" && ! -d "$d/gh" ]]; then
      printf '%s\n' "$d/gh"
      return 0
    fi
  done
  return 1
}

# yw_gh_render <실제 gh> <본체> <앞단>: 설치할 앞단 내용.
yw_gh_render() {
  local content
  content="$(cat "$BOOTSTRAP_ROOT/scripts/yw-gh.sh")"
  content="${content//__YW_GH_REAL__/$1}"
  content="${content//__YW_GH_CORE__/$2}"
  content="${content//__YW_GH_SELF__/$3}"
  printf '%s\n' "$content"
}

# yw_gh_helper_bypass <실제 gh>: global 범위(include한 ~/.gitconfig.local 포함)의 credential helper가 실제 gh를 직접 가리키면 0.
yw_gh_helper_bypass() {
  git config --global --includes --get-regexp '^credential\..*helper$' 2>/dev/null | grep -qF "$1"
}

# yw_gh_disabled <설정 디렉터리>: 기기 단위 끄기 파일을 믿을 수 있으면 0.
# 끄기 파일은 현재 사용자 소유의 일반 파일(링크 아님)이고, 설정 디렉터리는 현재 사용자 소유·링크 아님·group/other 쓰기 불가여야 한다.
yw_gh_disabled() {
  local dir="$1" perm
  [[ -d "$dir" && ! -L "$dir" && -O "$dir" && -f "$dir/disabled" && ! -L "$dir/disabled" && -O "$dir/disabled" ]] || return 1
  perm="$(/usr/bin/stat -f %Lp "$dir" 2>/dev/null)" || return 1
  (((8#$perm & 8#022) == 0))
}
