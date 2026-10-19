// Browser Use 설치·공식 스킬 배치/검사만 수행한다. daemon/Chrome에는 연결하지 않는다.
import { lstatSync, realpathSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function present(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function physical(path) {
  if (present(path)) return realpathSync(path); // 깨진 링크도 충돌로 취급
  return join(physical(dirname(path)), path.split('/').at(-1));
}

export function skillPlan({ home, env, official }) {
  const canonicalCodex = join(home, '.codex/skills/browser-use');
  const canonicalClaude = join(home, '.claude/skills/browser-use');
  const codex = join(env.CODEX_HOME || join(home, '.codex'), 'skills/browser-use');
  const claude = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills/browser-use');
  const shared = join(home, '.agents/skills/browser-use');
  const paths = [...new Set([canonicalCodex, canonicalClaude, codex, claude, shared])];
  for (const path of paths.filter(present)) {
    if (readFileSync(join(path, 'SKILL.md'), 'utf8') !== official) {
      throw new Error(`기존 스킬이 공식 CLI 내용과 다릅니다: ${path}. 덮어쓰지 않았습니다. 차이를 검토하세요.`);
    }
  }
  // Codex가 함께 검색하는 shared/전용 경로에 중복 스킬을 추가하지 않는다.
  for (const path of [canonicalCodex, codex]) {
    if (present(shared) && present(path) && physical(shared) !== physical(path)) {
      throw new Error(`Codex 중복 스킬: ${shared}, ${path}. 기존 항목을 유지했습니다.`);
    }
  }
  // provider 간에도 상위 skills 링크가 같은 실제 디렉터리를 가리킬 수 있다.
  // 아직 없는 shared 스킬도 Claude 경로를 통해 생성될 예정이면 함께 계획한다.
  const usesShared = [canonicalCodex, codex, canonicalClaude, claude]
    .some(path => physical(path) === physical(shared));
  if (usesShared && !present(shared) &&
      new Set([canonicalCodex, codex].filter(present).map(physical)).size > 1) {
    throw new Error(`Codex 중복 스킬: shared 생성 시 기존 원본이 충돌합니다: ${canonicalCodex}, ${codex}. 기존 항목을 유지했습니다.`);
  }
  const codexGroup = present(shared) ? [shared]
    : usesShared ? [canonicalCodex, codex, shared] : [canonicalCodex, codex];
  const planned = new Map();
  for (const group of [codexGroup, [canonicalClaude, claude]]) {
    const unique = [...new Map(group.map(path => [physical(path), path])).values()];
    const source = unique.find(present) || unique.find(path => planned.has(physical(path))) || unique[0];
    if (!present(source) && !planned.has(physical(source))) planned.set(physical(source), { path: source, official });
    for (const path of unique) {
      if (path !== source && !present(path) && !planned.has(physical(path))) planned.set(physical(path), { path, source });
    }
  }
  return { plan: [...planned.values()], paths: paths.filter(present) };
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
      console.log('[dry-run] 설치 후 공식 스킬과 양쪽 기본/실제 provider 경로 충돌 검사·누락만 배치');
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
  for (const item of plan) {
    console.log(`${check ? '누락' : dryRun ? '[dry-run] 설치' : '설치'}: ${item.path}`);
    if (check || dryRun) continue;
    mkdirSync(dirname(item.path), { recursive: true });
    if (item.source) symlinkSync(item.source, item.path, 'dir');
    else {
      // 공식 설치기는 기존 파일을 덮어쓴다. 같은 CLI의 skill 출력만 새 디렉터리에 배치한다.
      mkdirSync(item.path); // 동시 설치/충돌 시 실패하며 기존 항목 보존
      writeFileSync(join(item.path, 'SKILL.md'), item.official, { flag: 'wx' });
    }
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
