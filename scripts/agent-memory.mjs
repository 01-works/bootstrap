// Claude Code·Codex 로컬 메모리를 끄고, Claude 자동 요약 창이 없으면 넣는다. 사용: node scripts/agent-memory.mjs [--check|--dry-run]
// ZeroSub 계정 홈은 ~/.claude/settings.json에서 생성되고 ~/.codex/config.toml을 링크하므로 기본 홈만 고친다.
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] ?? '';
if (!['', '--check', '--dry-run'].includes(mode) || process.argv.length > 3) {
  console.error('사용법: node scripts/agent-memory.mjs [--check|--dry-run]');
  process.exit(1);
}
let failed = false;
const ok = text => console.log(`  ✓ ${text}`);
const fail = text => { console.error(`  ! ${text}`); failed = true; };

// 긴 세션이 1M 가까이 커지면 호출마다 다시 읽는 컨텍스트가 비용 대부분이 된다 (agents/claude-code.md#자동-요약).
// 기기에서 다른 값을 정했으면 그 값을 둔다.
const COMPACT_WINDOW = 400000;

function claude() {
  const file = join(homedir(), '.claude/settings.json');
  const label = 'Claude 자동 메모리·자동 요약 창';
  if (!existsSync(file)) {
    if (mode === '--dry-run') return console.log(`  [dry-run] ${label}: dotfiles 단계가 꺼진 기본값을 만든다`);
    return fail(`${label}: ~/.claude/settings.json 없음 → ./bootstrap.sh --only dotfiles`);
  }
  const before = readFileSync(file, 'utf8');
  const settings = JSON.parse(before);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json이 객체가 아닙니다');
  const wanted = {
    ...(settings.autoMemoryEnabled === false ? {} : { autoMemoryEnabled: false }),
    ...('autoCompactWindow' in settings ? {} : { autoCompactWindow: COMPACT_WINDOW }),
  };
  const changes = Object.entries(wanted).map(([key, value]) => `${key}=${value}`).join(', ');
  if (!changes) return ok(`${label} 맞음`);
  if (mode === '--check') return fail(`${label}: ${changes} 필요 → ./bootstrap.sh --only agents`);
  // 전환 전 링크는 저장소 파일을 가리킨다. 저장소 값이 받아지면 꺼지므로 작업 트리를 더럽히지 않는다.
  if (lstatSync(file).isSymbolicLink()) return fail(`${label}: settings.json이 저장소 링크라 그대로 둡니다 (저장소 값 확인)`);
  if (mode === '--dry-run') return console.log(`  [dry-run] ${label}: ${changes}`);
  const temp = `${file}.bootstrap.${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify({ ...settings, ...wanted }, null, 2)}\n`,
      { mode: statSync(file).mode & 0o777, flag: 'wx' });
    // Claude Code가 그사이 저장했으면 그 저장을 유지하고 다음 실행에서 다시 한다.
    if (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== before) throw new Error('고치는 중에 설정이 바뀌어 보류합니다');
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  ok(`${label}: ${changes} (새 세션부터)`);
}

function codex() {
  const label = 'Codex 메모리';
  const { CODEX_HOME, ...env } = process.env;
  const run = (...args) => spawnSync('codex', ['features', ...args], { env, encoding: 'utf8' });
  const enabled = () => {
    const list = run('list');
    const state = list.status === 0 && /^memories\s.*\s(true|false)\s*$/m.exec(list.stdout)?.[1];
    if (!state) throw new Error('codex features list에서 memories를 읽지 못했습니다');
    return state === 'true';
  };
  if (!enabled()) return ok(`${label} 꺼짐`);
  if (mode === '--check') return fail(`${label} 켜짐 → ./bootstrap.sh --only agents`);
  if (mode === '--dry-run') return console.log(`  [dry-run] ${label} 끄기`);
  if (run('disable', 'memories').status !== 0 || enabled()) throw new Error('codex features disable memories 실패');
  ok(`${label} 끔 (새 세션부터)`);
}

for (const [name, apply] of [['Claude 설정', claude], ['Codex 메모리', codex]]) {
  try {
    apply();
  } catch (error) {
    fail(`${name}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
