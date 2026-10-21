// Paseo 기본 스킬(paseo, paseo-help 등)이 이 기기에 하나도 없으면 데몬에 설치를 요청한다. 앱 설정의 Orchestration skills와 같은 동작이다.
// 데몬은 시작할 때 이미 설치된 스킬만 갱신하고 처음 설치는 하지 않는다. 설치한 뒤의 갱신과 스킬 선택은 Paseo가 맡는다.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const clientScript = fileURLToPath(new URL('./paseo-skills-client.mjs', import.meta.url));
// Paseo가 관리하는 스킬 폴더의 표시
const MARKER = '.paseo-managed-files.json';

// Paseo가 설치하는 두 위치(데몬은 CLAUDE_CONFIG_DIR가 아니라 홈 기준으로 쓴다)에서 Paseo가 관리하는 스킬 이름.
export function installedSkills(home) {
  const names = new Set();
  for (const dir of [join(home, '.agents/skills'), join(home, '.claude/skills')]) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('paseo') && existsSync(join(dir, entry.name, MARKER))) names.add(entry.name);
    }
  }
  return [...names].sort();
}

// 앱 설정에서 스킬을 하나도 고르지 않았으면 일부러 설치하지 않은 상태다.
export function optedOut(config) {
  const selection = config?.skills?.selection;
  return selection?.mode === 'custom' && Array.isArray(selection.skills) && selection.skills.length === 0;
}

// PATH의 paseo가 앱 안의 CLI면 그 앱의 Node 런타임과 CLI 모듈 경로. 앱 없이 npm으로 설치한 CLI면 null.
export function appRuntime(pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const cli = join(dir, 'paseo');
    if (!existsSync(cli)) continue;
    const resources = dirname(dirname(realpathSync(cli)));
    const runtime = {
      helper: join(resources, '../Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper'),
      runner: join(resources, 'app.asar.unpacked/dist/daemon/node-entrypoint-runner.js'),
      client: join(resources, 'app.asar/node_modules/@getpaseo/cli/dist/utils/client.js')
    };
    // app.asar 안은 Paseo 런타임만 읽을 수 있어 client는 여기서 확인하지 않는다.
    return existsSync(runtime.helper) && existsSync(runtime.runner) && existsSync(join(resources, 'app.asar')) ? runtime : null;
  }
  return null;
}

function paseo(args, options = {}) {
  const result = spawnSync('paseo', args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function daemonRunning(home) {
  const result = paseo(['daemon', 'status', '--json', '--home', home]);
  try { return JSON.parse(result.stdout).localDaemon === 'running'; } catch { return false; }
}

// 앱의 CLI 런처(Resources/bin/paseo)와 같은 방식으로 Paseo 런타임에서 클라이언트 스크립트를 실행한다.
function requestInstall(runtime, home) {
  const result = spawnSync(runtime.helper, ['--disable-warning=DEP0040', runtime.runner, 'node-script', clientScript], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production', BOOTSTRAP_PASEO_HOME: home, BOOTSTRAP_PASEO_CLIENT: runtime.client }
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) throw new Error(`설치 요청 실패: ${(output || result.error?.message || '').slice(0, 300)}`);
  if (output) console.log(output);
}

function main() {
  const args = process.argv.slice(2);
  let home = process.env.PASEO_HOME || join(homedir(), '.paseo');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home' && args[i + 1] && !args[i + 1].startsWith('--')) home = args[++i];
    else if (!['--check', '--dry-run'].includes(args[i])) throw new Error(`알 수 없는 인자: ${args[i]}`);
  }
  home = resolve(home);
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) {
    console.log('Paseo 설정 없음: ./bootstrap.sh --only paseo 가 첫 설정을 합니다.');
    if (!dryRun) process.exitCode = 2;
    return;
  }
  const installed = installedSkills(homedir());
  if (installed.length) {
    console.log(`Paseo 기본 스킬 설치됨: ${installed.join(', ')}`);
    return;
  }
  if (optedOut(JSON.parse(readFileSync(configPath, 'utf8')))) {
    console.log('Paseo 기본 스킬을 앱 설정에서 하나도 고르지 않았습니다 (유지).');
    return;
  }
  console.log('Paseo 기본 스킬이 설치되어 있지 않습니다.');
  if (check) {
    process.exitCode = 1;
    return;
  }
  const runtime = appRuntime();
  const noRuntime = 'PATH의 paseo가 Paseo 앱 안의 CLI가 아니라 자동 설치할 수 없습니다. 앱 설정의 Orchestration skills에서 설치하세요';
  const running = daemonRunning(home);
  if (dryRun) {
    console.log(runtime ? `[dry-run] Paseo 데몬에 기본 스킬 설치를 요청할 예정${running ? '' : ' (데몬을 잠시 켜서)'}` : `[dry-run] ${noRuntime}`);
    return;
  }
  if (!runtime) throw new Error(noRuntime);
  if (!running) {
    // 데몬이 이 실행의 환경을 물려받지 않게 한다 (65-paseo.sh의 onboard와 같은 이유).
    console.log('스킬을 설치하려고 Paseo 데몬을 잠시 켭니다.');
    const env = { ...process.env };
    for (const key of ['BOOTSTRAP_UNATTENDED', 'BOOTSTRAP_LOCKED', 'BOOTSTRAP_RESULTS']) delete env[key];
    if (paseo(['daemon', 'start', '--home', home, '--timeout', '120'], { stdio: ['ignore', 'inherit', 'inherit'], env }).status !== 0) {
      throw new Error('Paseo 데몬 시작 실패');
    }
  }
  try {
    requestInstall(runtime, home);
  } finally {
    if (!running && paseo(['daemon', 'stop', '--home', home], { stdio: ['ignore', 'inherit', 'inherit'] }).status !== 0) {
      console.log('경고: 잠시 켠 Paseo 데몬을 끄지 못했습니다 (paseo daemon stop)');
    }
  }
  // 데몬의 응답만 믿지 않고 디스크를 다시 확인한다.
  const after = installedSkills(homedir());
  if (!after.length) throw new Error('설치를 요청했지만 스킬이 생기지 않았습니다. 앱 설정의 Orchestration skills에서 확인하세요');
  console.log(`Paseo 기본 스킬 설치: ${after.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`Paseo 스킬: ${error.message}`); process.exitCode = 1; }
}
