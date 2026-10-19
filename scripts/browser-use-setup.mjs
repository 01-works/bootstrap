// Browser Use 설치·공식 스킬 배치/검사만 수행한다. daemon/Chrome에는 연결하지 않는다.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { physical, present, skillDestinations } from './skill-paths.mjs';

// 공식 스킬이 없는 경로만 돌려준다. 다른 내용·파일·깨진 링크는 덮어쓰지 않고 중단한다.
export function skillPlan({ home, env, official }) {
  const destinations = skillDestinations('browser-use', { home, env });
  for (const path of destinations.filter(present)) {
    let text = null;
    try { text = readFileSync(join(path, 'SKILL.md'), 'utf8'); } catch {}
    if (text !== official) {
      throw new Error(`기존 스킬이 공식 CLI 내용과 다릅니다: ${path}. 덮어쓰지 않았습니다. CLI를 갱신했다면 이 폴더를 지우고 다시 실행하세요.`);
    }
  }
  return { plan: destinations.filter(path => !present(path)), paths: destinations.filter(present) };
}

export function setup({ home = homedir(), env = process.env, check = false, dryRun = false, run = spawnSync } = {}) {
  const cliEnv = { ...env, BH_TELEMETRY: '0', BH_UPDATE_CHECK: '0', BH_RECORD: '0' };
  const call = (command, args) => run(command, args, { env: cliEnv, encoding: 'utf8' });
  const checked = (command, args) => {
    const result = call(command, args);
    if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} 실패: ${result.error?.message || result.stderr}`);
    return result.stdout;
  };
  let version = call('browser-use', ['--version']);
  if (version.error?.code === 'ENOENT') {
    // ENOENT는 깨진 링크나 shebang 인터프리터 부재일 수도 있다.
    const entries = [...(env.PATH || '').split(':').filter(Boolean), join(home, '.local/bin')];
    for (const dir of entries) {
      const path = join(dir, 'browser-use');
      if (present(path)) throw new Error(`기존 browser-use 실행 경로 오류: ${path}. 교체하지 않았습니다.`);
    }
    if (check) throw new Error('browser-use 없음. ./bootstrap.sh --only homebrew,browser');
    // uv 패키지가 제공하는 별칭도 기존 설치를 가리지 않게 확인한다.
    for (const command of ['browser', 'browseruse', 'browser-use-tui', 'bu']) {
      const found = call('/bin/sh', ['-c', 'command -v "$1"', 'sh', command]);
      if (found.status === 0) throw new Error(`Browser Use 별칭 충돌: ${found.stdout.trim()}. 기존 실행 파일은 유지했습니다.`);
    }
    if (dryRun) {
      console.log('[dry-run] uv tool install --python 3.12 browser-use (기존 CLI는 설치/갱신하지 않음)');
      console.log('[dry-run] 설치 후 공식 스킬을 ~/.agents/skills(Codex)와 ~/.claude/skills(Claude)에 충돌 검사 후 배치');
      return;
    }
    checked('uv', ['--version']);
    checked('uv', ['tool', 'install', '--python', '3.12', 'browser-use']);
    version = call('browser-use', ['--version']);
  }
  if (version.error || version.status !== 0) throw new Error('기존 browser-use 실행 실패. 덮어쓰기/upgrade 없이 설치 경로를 확인하세요.');
  checked('browser-use', ['--help']);
  const official = checked('browser-use', ['skill']);
  if (!/^name: browser-use\s*$/m.test(official) || !official.startsWith('---\n')) {
    throw new Error('공식 browser-use skill 출력 형식 변경. 기존 스킬을 유지했습니다. CLI 도움말을 검토하세요.');
  }
  const { plan, paths } = skillPlan({ home, env, official });
  console.log(`Browser Use CLI 실행: ${version.stdout.trim()} (daemon 연결 없음)`);
  for (const path of paths) console.log(`공식 스킬 확인: ${path} → ${physical(path)}`);
  for (const path of plan) {
    console.log(`${check ? '누락' : dryRun ? '[dry-run] 설치' : '설치'}: ${path}`);
    if (check || dryRun) continue;
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path); // 동시 설치/충돌 시 실패하며 기존 항목 보존
    writeFileSync(join(path, 'SKILL.md'), official, { flag: 'wx' });
  }
  if (check && plan.length) throw new Error('Browser Use 공식 스킬 누락. ./bootstrap.sh --only browser');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--check', '--dry-run'].includes(arg))) throw new Error('지원 인자: --check --dry-run');
    setup({ check: args.includes('--check'), dryRun: args.includes('--dry-run') || process.env.DRY_RUN === '1' });
  } catch (error) { console.error(`Browser Use: ${error.message}`); process.exitCode = 1; }
}
