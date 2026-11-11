// Colima system provision와 즉시 적용이 같은 스크립트를 쓴다. 외부 패키지 없이 YAML 원문을 보존한다.
import { readFileSync } from 'node:fs';

export const dropIn = '[Service]\nCapabilityBoundingSet=~CAP_SYS_TIME\n';
// 원인: https://github.com/lima-vm/lima/issues/5543
// 수정: https://github.com/lima-vm/lima/pull/5565 (2026-11-11 open). 수정 버전 도입 후 재평가한다.
// timesyncd를 유지한다. 장기 drift·NTP 불통이면 chrony 필요성을 별도 재평가한다.
export function guestScript(action = 'apply') {
  return `#!/bin/sh
set -eu
file=/etc/systemd/system/lima-guestagent.service.d/10-no-clock-write.conf
owner=/var/lib/bootstrap/verifier-guest-clock
same() { printf '[Service]\\nCapabilityBoundingSet=~CAP_SYS_TIME\\n' | cmp -s - "$file"; }
owned() { [ -f "$owner" ] && grep -qx 'role' "$owner"; }
case ${action} in
  check)
    same || exit 1
    [ ! -e "$owner.pending" ] || exit 1
    caps=$(systemctl show lima-guestagent -p CapabilityBoundingSet --value) || exit 1
    printf '%s\\n' "$caps" | grep -qw cap_sys_time && exit 1
    systemctl is-active --quiet lima-guestagent
    ;;
  inspect)
    if [ -L "$file" ] || [ -L "$owner" ]; then exit 1
    elif same; then if owned; then echo role; else echo existing; fi
    elif [ -e "$file" ]; then exit 1
    else echo pending; fi
    ;;
  apply)
    [ ! -L "$file" ] || exit 1
    [ ! -L "$owner" ] || exit 1
    if same && [ ! -e "$owner.pending" ]; then echo '이미 적용됨'; exit 0; fi
    if [ -e "$file" ] && ! same; then echo 'guest clock drop-in 충돌' >&2; exit 1; fi
    if ! same; then
      mkdir -p "$(dirname "$owner")" "$(dirname "$file")"
      printf 'role\\n' > "$owner"
      touch "$owner.pending"
      tmp=$(mktemp "$file.XXXXXX")
      trap 'rm -f "$tmp"' EXIT
      printf '[Service]\\nCapabilityBoundingSet=~CAP_SYS_TIME\\n' > "$tmp"
      chmod 644 "$tmp"
      mv -f "$tmp" "$file"
      trap - EXIT
    fi
    systemctl daemon-reload
    systemctl try-restart lima-guestagent
    rm -f "$owner.pending"
    echo 'guest clock 적용함'
    ;;
  remove)
    if ! owned; then echo '기존 guest clock drop-in 보존'; exit 0; fi
    [ ! -L "$file" ] || exit 1
    [ ! -L "$owner" ] || exit 1
    if [ -e "$file" ] && ! same; then echo '수정된 guest clock drop-in 보존; 소유 기록 유지' >&2; exit 1; fi
    if [ -e "$file" ] || [ -e "$owner.pending" ]; then
      touch "$owner.pending"
      rm -f "$file"
      systemctl daemon-reload
      systemctl try-restart lima-guestagent
    fi
    rm -f "$owner" "$owner.pending"
    ;;
esac
`;
}

const begin = '# bootstrap-role-verifier-guest-clock begin';
const end = '# bootstrap-role-verifier-guest-clock end';
function block(indent) {
  return `${indent}${begin}\n${indent}- mode: system\n${indent}  script: |\n` +
    guestScript().trimEnd().split('\n').map(line => `${indent}    ${line}\n`).join('') + `${indent}${end}\n`;
}

export function config(text, action, before) {
  // 보편적인 Colima 형식만 고친다. 임의 inline YAML을 추측해서 손상시키지 않는다.
  const keys = [...text.matchAll(/^provision:[^\n]*(?:\n|$)/gm)];
  if (keys.length > 1) throw Error('중복 provision 키');
  const key = keys[0];
  let start = key?.index ?? text.length, stop = start, shape = 'absent', indent = '  ';
  if (key) {
    const value = key[0].slice('provision:'.length).replace(/[ \t]+#[^\n]*/, '').trim();
    if (value === '[]') shape = 'empty';
    else if (value === 'null' || value === '~') shape = 'null';
    else if (value === '') shape = 'block';
    else throw Error('provision은 [] 또는 block list 형식이어야 합니다');
    const tail = text.slice(start + key[0].length);
    const next = /^[A-Za-z_][\w-]*:/m.exec(tail);
    stop = next ? start + key[0].length + next.index : text.length;
    const body = text.slice(start + key[0].length, stop);
    const item = /^( *)- /m.exec(body);
    if (item) indent = item[1];
    else if (shape === 'block' && /[^\s#]/.test(body.replace(/^\s*#.*$/gm, ''))) throw Error('provision list를 해석할 수 없습니다');
  }
  const own = block(indent);
  const count = text.split(begin).length - 1;
  const present = count === 1 && text.includes(own) && text.indexOf(own) >= start && text.indexOf(own) + own.length <= stop;
  if ((count || text.includes(end)) && !present) throw Error('role provision이 수정되었거나 중복됨');
  if (action === 'inspect') return `${present ? 'present' : 'absent'} ${shape}${key ? ':' + Buffer.from(key[0]).toString('base64') : ''}\n`;
  if (action === 'add') {
    if (present) return text;
    if (!key) return text + (text.endsWith('\n') ? '' : '\n') + 'provision:\n' + own;
    const comment = /[ \t]+#.*(?=\n|$)/.exec(key[0])?.[0] ?? '';
    const header = `provision:${comment}\n`;
    return text.slice(0, start) + header + own + text.slice(start + key[0].length);
  }
  if (action === 'remove') {
    if (!present) return text;
    let result = text.replace(own, '');
    // 다른 provision은 보존하고 목록이 비었을 때만 원래 header로 복원한다.
    const body = result.slice(start + key[0].length, stop - own.length);
    if (!/^ *- /m.test(body)) {
      if (before === 'absent') result = result.slice(0, start) + result.slice(start + key[0].length);
      else if (before?.includes(':')) {
        const header = Buffer.from(before.slice(before.indexOf(':') + 1), 'base64').toString();
        if (!/^provision:[^\n]*(?:\n|$)$/.test(header)) throw Error('원래 provision header 소유 기록 오류');
        result = result.slice(0, start) + header + result.slice(start + key[0].length);
      }
    }
    return result;
  }
  throw Error('알 수 없는 config 작업');
}

if (process.argv[1]?.endsWith('/verifier-clock.mjs')) {
  try {
    const [kind, action, file, before] = process.argv.slice(2);
    process.stdout.write(kind === 'script' ? guestScript(action) : config(readFileSync(file, 'utf8'), action, before));
  } catch (error) { console.error(`guest clock: ${error.message}`); process.exitCode = 1; }
}
