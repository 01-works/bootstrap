// Colima system provision와 즉시 적용이 같은 스크립트를 쓴다. 외부 패키지 없이 YAML 원문을 보존한다.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const dropIn = '[Service]\nCapabilityBoundingSet=~CAP_SYS_TIME\n';
// 원인: https://github.com/lima-vm/lima/issues/5543
// 수정: https://github.com/lima-vm/lima/pull/5565 (2026-11-11 open). 수정 버전 도입 후 재평가한다.
// timesyncd를 유지한다. 장기 drift·NTP 불통이면 chrony 필요성을 별도 재평가한다.
export function guestScript(action = 'apply') {
  return `#!/bin/sh
# bootstrap-verifier-guest-clock id=clock-capability version=2
set -eu
file=/etc/systemd/system/lima-guestagent.service.d/10-no-clock-write.conf
owner=/var/lib/bootstrap/verifier-guest-clock
same() { printf '[Service]\\nCapabilityBoundingSet=~CAP_SYS_TIME\\n' | cmp -s - "$file"; }
owned() { [ -f "$owner" ] && grep -qx 'role' "$owner"; }
reload_needed() { [ "$(systemctl show lima-guestagent -p NeedDaemonReload --value)" != no ]; }
unit_safe() {
  caps=$(systemctl show lima-guestagent -p CapabilityBoundingSet --value) || return 1
  ! printf '%s\\n' "$caps" | grep -qw cap_sys_time
}
runtime_safe() {
  pid=$(systemctl show lima-guestagent -p MainPID --value) || return 1
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  bits=$(awk '/^CapBnd:/ { print $2 }' "/proc/$pid/status") || return 1
  case "$bits" in ''|*[!0-9a-fA-F]*) return 1 ;; esac
  low=$(printf '%s' "$bits" | awk '{ print substr($0, length($0) > 8 ? length($0)-7 : 1) }')
  [ $((0x$low & 0x02000000)) -eq 0 ] && systemctl is-active --quiet lima-guestagent
}
case ${action} in
  check)
    same || exit 1
    [ ! -e "$owner.pending" ] || exit 1
    ! reload_needed || exit 1
    unit_safe || exit 1
    runtime_safe
    ;;
  inspect)
    if [ -L "$file" ] || [ -L "$owner" ]; then echo conflict
    elif same; then if owned; then echo role; else echo existing; fi
    elif [ -e "$file" ]; then echo conflict
    else echo pending; fi
    ;;
  apply)
    [ ! -L "$file" ] || exit 1
    [ ! -L "$owner" ] || exit 1
    reload=0 restart=0
    if same && [ ! -e "$owner.pending" ] && ! reload_needed && unit_safe && runtime_safe; then
      echo '이미 적용됨'; exit 0
    fi
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
    if [ -e "$owner.pending" ]; then reload=1; restart=1; fi
    if reload_needed; then reload=1; fi
    if ! unit_safe; then reload=1; restart=1; fi
    if ! runtime_safe; then restart=1; fi
    if [ "$reload" = 1 ]; then systemctl daemon-reload; fi
    if [ "$restart" = 1 ]; then systemctl try-restart lima-guestagent; fi
    ! reload_needed && unit_safe && runtime_safe || exit 1
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

const identity = 'bootstrap-verifier-guest-clock id=clock-capability';
const legacyHash = '93ab549df3e076063799b5b26cc01990ac154316107a58994b9e11b9cde3141d'; // PR #75 초기판: ID 도입 전의 알려진 본문만 이관한다.
const normalized = script => script.trimEnd() + '\n';
const hash = script => createHash('sha256').update(normalized(script)).digest('hex');
const rubyParser = String.raw`require 'psych'
require 'json'
stream = Psych.parse_stream(STDIN.read)
raise 'single YAML document required' unless stream.children.length == 1
root = stream.children.first.root
raise 'root mapping required' unless root.is_a?(Psych::Nodes::Mapping)
keys = root.children.each_slice(2).select { |k,v| k.respond_to?(:value) && k.value == 'provision' }
raise 'duplicate provision key' if keys.length > 1
if keys.empty?
  puts JSON.generate(nil)
else
  key, value = keys.first
  data = {line: key.start_line, header_end: value.start_line, kind: 'block', items: []}
  if value.is_a?(Psych::Nodes::Sequence) && value.style == Psych::Nodes::Sequence::BLOCK
    value.children.each do |item|
      raise 'block mapping item required' unless item.is_a?(Psych::Nodes::Mapping) && item.style == Psych::Nodes::Mapping::BLOCK
      fields = {}
      item.children.each_slice(2) do |k,v|
        raise 'scalar mapping keys required' unless k.is_a?(Psych::Nodes::Scalar)
        raise 'duplicate item key' if fields.key?(k.value)
        fields[k.value] = v.is_a?(Psych::Nodes::Scalar) ? v.value : nil
      end
      data[:items] << {line: item.start_line, end_line: item.children.last.end_line, end_column: item.children.last.end_column, fields: fields}
    end
  elsif value.is_a?(Psych::Nodes::Sequence) && value.children.empty?
    data[:kind] = 'empty'
  elsif value.is_a?(Psych::Nodes::Scalar) && ['', 'null', '~'].include?(value.value)
    data[:kind] = 'null'
  else
    raise 'provision must be a block list, [] or null'
  end
  puts JSON.generate(data)
end
`;

// macOS 기본 Psych AST로 구조만 읽는다. YAML 태그/객체를 실행하지 않는다.
function parse(text) {
  const result = spawnSync('/usr/bin/ruby', ['-rpsych', '-rjson', '-e', rubyParser], { input: text, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw Error('provision YAML 해석 실패: ' + (result.error?.message ?? result.stderr ?? '').trim());
  return JSON.parse(result.stdout);
}
function block(indent) {
  return `${indent}- mode: system\n${indent}  script: |\n` +
    guestScript().trimEnd().split('\n').map(line => `${indent}    ${line}\n`).join('');
}
export function config(text, action, before) {
  const ast = parse(text), lines = text.split(/(?<=\n)/);
  const offset = line => lines.slice(0, line).join('').length;
  const headerStart = ast ? offset(ast.line) : text.length;
  const header = ast ? lines[ast.line] : '';
  const shape = ast ? ast.kind + ':' + Buffer.from(header).toString('base64') : 'absent';
  const items = ast?.items ?? [];
  const managed = [];
  for (const item of items) {
    const script = item.fields.script ?? '';
    const digest = hash(script);
    const version = digest === hash(guestScript()) ? 2 : digest === legacyHash ? 1 : 0;
    if (version || script.includes(identity) || script.includes('/var/lib/bootstrap/verifier-guest-clock')) {
      if (!version || item.fields.mode !== 'system' || Object.keys(item.fields).sort().join(',') !== 'mode,script') {
        throw Error('알 수 없게 수정된 guest clock provision (보존)');
      }
      managed.push({ ...item, version });
    }
  }
  if (managed.length > 1) throw Error('guest clock provision 중복 (보존)');
  const own = managed[0];
  if (action === 'inspect') return `${own ? own.version === 2 ? 'present' : 'upgrade' : 'absent'} ${shape}\n`;
  if (action === 'script') return own ? normalized(own.fields.script) : '';
  const indent = items.length ? /^ */.exec(lines[items[0].line])[0] : '  ';
  if (own) {
    let start = offset(own.line), stop = offset(own.end_line) + own.end_column;
    if (own.end_column) stop = text.indexOf('\n', stop) < 0 ? text.length : text.indexOf('\n', stop) + 1;
    // 초기판의 YAML 바깥 주석은 소유 판정에 쓰지 않고 편집할 때만 정리한다.
    if (lines[own.line - 1]?.trim() === '# bootstrap-role-verifier-guest-clock begin') start = offset(own.line - 1);
    if (text.slice(stop).startsWith(indent + '# bootstrap-role-verifier-guest-clock end\n')) stop += (indent + '# bootstrap-role-verifier-guest-clock end\n').length;
    if (action === 'add') return own.version === 2 ? text : text.slice(0, start) + block(indent) + text.slice(stop);
    if (action !== 'remove') throw Error('알 수 없는 config 작업');
    let result = text.slice(0, start) + text.slice(stop);
    if (items.length === 1) {
      if (before === 'absent') result = result.slice(0, headerStart) + result.slice(headerStart + header.length);
      else if (before?.includes(':')) {
        const original = Buffer.from(before.slice(before.indexOf(':') + 1), 'base64').toString();
        if (!/^provision:[^\n]*(?:\n|$)$/.test(original)) throw Error('원래 provision header 소유 기록 오류');
        result = result.slice(0, headerStart) + original + result.slice(headerStart + header.length);
      } else result = result.slice(0, headerStart) + 'provision: []\n' + result.slice(headerStart + header.length);
    }
    return result;
  }
  if (action === 'remove') return text;
  if (action !== 'add') throw Error('알 수 없는 config 작업');
  if (!ast) return text + (text.endsWith('\n') ? '' : '\n') + 'provision:\n' + block(indent);
  const comment = /[ \t]+#.*(?=\n|$)/.exec(header)?.[0] ?? '';
  return text.slice(0, headerStart) + `provision:${comment}\n` + block(indent) + text.slice(headerStart + header.length);
}

if (process.argv[1]?.endsWith('/verifier-clock.mjs')) {
  try {
    const [kind, action, file, before] = process.argv.slice(2);
    process.stdout.write(kind === 'script' ? guestScript(action) : config(readFileSync(file, 'utf8'), action, before));
  } catch (error) { console.error(`guest clock: ${error.message}`); process.exitCode = 1; }
}
