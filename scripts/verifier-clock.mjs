// Lima override 한 파일과 즉시 적용에 쓸 스크립트만 생성한다. YAML 파서는 필요 없다.
export const dropIn = '[Service]\nCapabilityBoundingSet=~CAP_SYS_TIME\n';
// 원인: https://github.com/lima-vm/lima/issues/5543
// 수정: https://github.com/lima-vm/lima/pull/5565 — 수정 Lima 도입 후 재평가한다.
export function guestScript(action = 'apply') {
  const common = `#!/bin/sh
set -eu
file=/etc/systemd/system/lima-guestagent.service.d/10-no-clock-write.conf
[ ! -L "$file" ] || { echo 'guest clock drop-in 링크 충돌' >&2; exit 1; }
same() { printf '[Service]\\nCapabilityBoundingSet=~CAP_SYS_TIME\\n' | cmp -s - "$file"; }
`;
  if (action === 'check') return common + `caps=$(systemctl show lima-guestagent -p CapabilityBoundingSet --value)
printf 'CapabilityBoundingSet=%s\\n' "$caps"
same || { echo 'guest clock drop-in 없음/내용 불일치' >&2; exit 1; }
! printf '%s\\n' "$caps" | grep -qw cap_sys_time
`;
  // 즉시 적용은 기존 수동 파일을 보존한다. 부팅 provision은 다른 내용도 정해진 값으로 맞춘다.
  if (!['apply', 'provision'].includes(action)) throw Error('알 수 없는 guest clock 작업');
  return common + `if same; then echo '이미 적용됨'; exit 0; fi
` + (action === 'apply' ? `[ ! -e "$file" ] || { echo 'guest clock drop-in 내용 충돌 (보존)' >&2; exit 1; }
` : '') + `mkdir -p "$(dirname "$file")"
printf '[Service]\\nCapabilityBoundingSet=~CAP_SYS_TIME\\n' > "$file"
systemctl daemon-reload
systemctl try-restart lima-guestagent
`;
}

// JSON의 quoted string은 YAML에서도 유효하다. shell 본문을 한 번만 정의한다.
export const overrideYaml = `provision:\n  - mode: system\n    script: ${JSON.stringify(guestScript('provision'))}\n`;
if (process.argv[1]?.endsWith('/verifier-clock.mjs')) {
  process.stdout.write(process.argv[2] === 'override' ? overrideYaml : guestScript(process.argv[2]));
}
