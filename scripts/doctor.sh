#!/usr/bin/env bash
# 프로필대로 세팅되어 있는지 검증한다. 아무것도 바꾸지 않는다.
set -uo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

passed=0
failed=0
pass() { ok "$*"; passed=$((passed + 1)); }
miss() { fail "$*"; failed=$((failed + 1)); }

printf '프로필: %s\n' "$PROFILE"

step "Homebrew"
if has brew; then
  pass "brew"
  for f in $BREWFILES; do
    if brew bundle check --file="$BOOTSTRAP_ROOT/$f" --no-upgrade >/dev/null 2>&1; then
      pass "$f"
    else
      miss "$f 에서 빠진 항목:"
      brew bundle check --file="$BOOTSTRAP_ROOT/$f" --no-upgrade --verbose 2>&1 | grep '→' | sed 's/^/      /' | head -30
    fi
  done
else
  miss "brew 없음"
fi

step "명령어"
cmds="git gh gitleaks"
contains runtimes $STEPS && cmds="$cmds fnm node pnpm"
contains agents $STEPS && cmds="$cmds claude codex paseo"
for cmd in $cmds; do
  if has "$cmd"; then pass "$cmd"; else miss "$cmd 없음"; fi
done

if [[ -n "$DOTFILES" ]]; then
  step "설정 파일"
  for pkg in $DOTFILES; do
    src_root="$BOOTSTRAP_ROOT/home/$pkg"
    while IFS= read -r src; do
      rel="${src#"$src_root"/}"
      case "$rel" in
        *.seed)
          dst="$HOME/${rel%.seed}"
          if [[ -e "$dst" ]]; then pass "$(pretty "$dst")"; else miss "$(pretty "$dst") 없음"; fi
          ;;
        *)
          dst="$HOME/$rel"
          if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
            pass "$(pretty "$dst")"
          elif [[ -e "$dst" && ! -L "$dst" ]]; then
            # 아직 연결 전이거나, 도구가 링크를 일반 파일로 덮어쓴 경우. 차이를 저장소에 옮긴 뒤 연결한다.
            miss "$(pretty "$dst") 링크가 아니라 일반 파일 → diff $(pretty "$dst") $(pretty "$src") 확인 후 ./bootstrap.sh --only dotfiles"
          else
            miss "$(pretty "$dst") 연결 안 됨"
          fi
          ;;
      esac
    done < <(find "$src_root" -type f ! -name .DS_Store | sort)
  done
fi

if contains containers $STEPS; then
  step "docker 플러그인"
  for sub in compose buildx; do
    if docker "$sub" version >/dev/null 2>&1; then pass "docker $sub"; else miss "docker $sub 안 됨 (./bootstrap.sh --only containers)"; fi
  done
fi

if contains power $STEPS; then
  step "전원"
  if [[ "$(pmset -g custom | awk '$1 == "sleep" {print $2; exit}')" == 0 ]]; then
    pass "잠자기 꺼짐"
  else
    miss "잠자기 켜짐"
  fi
fi

step "인증"
if gh auth status >/dev/null 2>&1; then pass "GitHub 로그인"; else miss "GitHub 로그인 안 됨 (gh auth login)"; fi
if contains zsh $DOTFILES; then
  if [[ -f "$HOME/.zsh_secrets" ]]; then
    perm="$(stat -f '%Lp' "$HOME/.zsh_secrets")"
    if [[ "$perm" == 600 ]]; then pass "~/.zsh_secrets"; else miss "~/.zsh_secrets 권한이 $perm (chmod 600 필요)"; fi
  else
    miss "~/.zsh_secrets 없음 (templates/zsh_secrets.example 참고)"
  fi
fi

printf '\n%s통과 %d%s, %s실패 %d%s\n' "$_green" "$passed" "$_reset" "$_red" "$failed" "$_reset"
[[ "$failed" == 0 ]]
