// Chrome 승인형 디버깅과 Paseo Browser 설정. 인증·프로필 데이터는 저장소에 복사하지 않는다.
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function enableChromeDebugging(config) {
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(config) || (config.devtools != null && !isObject(config.devtools)) ||
      (config.devtools?.remote_debugging != null && !isObject(config.devtools.remote_debugging))) {
    throw new Error('Chrome devtools 설정이 객체 형식이 아닙니다. 기존 설정을 유지합니다.');
  }
  const result = structuredClone(config);
  result.devtools ??= {};
  result.devtools.remote_debugging ??= {};
  result.devtools.remote_debugging['user-enabled'] = true;
  return result;
}

const defaultStateHome = () => process.env.XDG_STATE_HOME || join(homedir(), '.local/state');

function backup(path, stateHome, label) {
  if (!existsSync(path)) return;
  const root = join(stateHome, 'bootstrap/backup');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, `browser-${label}-`));
  const dst = join(dir, label === 'chrome' ? 'Local State' : 'config.json');
  copyFileSync(path, dst);
  chmodSync(dst, 0o600);
  writeFileSync(join(dir, 'source-path.txt'), `${path}\n`, { mode: 0o600 });
  console.log(`설정 백업: ${dst}`);
}

function readObject(path) {
  const text = readFileSync(path, 'utf8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`객체 형식이 아닙니다: ${path}`);
  return { text, value };
}

// 경로와 외부 명령을 주입할 수 있어 실제 홈·브라우저 없이 파일 적용 경로를 검증한다.
export function configureChrome({ home = homedir(), stateHome = defaultStateHome(), check = false, dryRun = false, run = spawnSync } = {}) {
  const path = join(home, 'Library/Application Support/Google/Chrome/Local State');
  const before = existsSync(path) ? readObject(path) : { text: null, value: {} };
  if (before.value.devtools?.remote_debugging?.['user-enabled'] === true) {
    console.log('Chrome 승인형 원격 디버깅 설정: 켜짐 (실제 연결 승인은 별도)');
    return 0;
  }
  if (check) {
    console.error('Chrome 설정 대기: Chrome 종료 후 ./bootstrap.sh --only browser');
    return 2;
  }
  if (dryRun) {
    console.log('[dry-run] Chrome이 종료되어 있으면 승인형 원격 디버깅 설정; 실행 중이면 안내');
    return 0;
  }
  const running = () => {
    const result = run('/usr/bin/pgrep', ['-x', 'Google Chrome']);
    if (result.error || ![0, 1].includes(result.status)) throw new Error('Chrome 실행 상태 확인 실패');
    return result.status === 0;
  };
  if (running()) {
    console.error('Chrome 실행 중: 파일을 유지했습니다. chrome://inspect/#remote-debugging 에서 켜거나 종료 후 ./bootstrap.sh --only browser 를 실행하세요.');
    return 2;
  }
  const after = enableChromeDebugging(before.value);
  const assertUnchanged = () => {
    if ((existsSync(path) ? readFileSync(path, 'utf8') : null) !== before.text) throw new Error('Chrome 설정이 변경되었습니다. 다시 실행하세요.');
  };
  assertUnchanged();
  backup(path, stateHome, 'chrome');
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.bootstrap-${process.pid}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(after));
    // 준비 도중 Chrome이 시작되거나 설정을 바꾼 경우에도 원본을 보존한다.
    if (running()) { console.error('설정 준비 중 Chrome이 시작되었습니다. 종료 후 다시 실행하세요.'); return 2; }
    assertUnchanged();
    renameSync(temp, path);
  } finally {
    closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
  console.log('Chrome 승인형 원격 디버깅 설정 완료. 다음 Chrome 실행부터 적용됩니다.');
  return 0;
}

export function configurePaseo({ home = process.env.PASEO_HOME || join(homedir(), '.paseo'), stateHome = defaultStateHome(), check = false, dryRun = false, run = spawnSync } = {}) {
  const path = join(home, 'config.json');
  if (!existsSync(path)) {
    console.log('Paseo 설정 대기: 앱 초기 설정 후 ./bootstrap.sh --only browser,paseo');
    return dryRun ? 0 : 2;
  }
  const { value } = readObject(path);
  const wanted = ['daemon.mcp.injectIntoAgents', 'daemon.browserTools.enabled'];
  const missing = wanted.filter(key => key.split('.').reduce((v, k) => v?.[k], value) !== true);
  if (!missing.length) { console.log('Paseo 도구·Browser 설정: 켜짐'); return 0; }
  if (check) { console.error(`Paseo 설정 필요: ${missing.join(', ')}`); return 1; }
  if (dryRun) { console.log(`[dry-run] Paseo 설정·reload: ${missing.join(', ')}`); return 0; }
  backup(path, stateHome, 'paseo');
  for (const key of missing) {
    const result = run('paseo', ['daemon', 'config', 'set', key, 'true', '--home', home], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Paseo 설정 적용 실패. 일부 값이 저장되었을 수 있습니다. 저장 실패는 재실행, 저장 후 reload 실패는 해당 home으로 paseo reload를 실행하세요.');
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--dry-run', '--chrome', '--paseo'].includes(arg))) throw new Error('지원 인자: --check --dry-run --chrome --paseo');
  const options = { check: args.includes('--check'), dryRun: args.includes('--dry-run') || process.env.DRY_RUN === '1' };
  const targets = [];
  if (args.includes('--chrome') || !args.includes('--paseo')) targets.push(configureChrome);
  if (args.includes('--paseo') || !args.includes('--chrome')) targets.push(configurePaseo);
  const statuses = targets.map(configure => {
    try { return configure(options); }
    catch (error) { console.error(error.message); return 1; }
  });
  // 한쪽의 실패로 다른 쪽 적용을 막지 않는다. 실패가 수동 대기보다 우선한다.
  process.exitCode = statuses.includes(1) ? 1 : statuses.includes(2) ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
