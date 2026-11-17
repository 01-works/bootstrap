// Paseo 기본 플러그인을 목록의 버전으로 맞추고, 목록에서 은퇴시킨 플러그인은 지우며, 목록이 정한 설정 키를 맞춘다.
// 개발용 폴더 설치와 다른 소스 설치는 건드리지 않는다.
// 설치·갱신은 실행 중인 데몬이 한다. 데몬이 꺼져 있으면 마지막 동기화 이후 목록이 바뀐 경우에만 데몬을 켠다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appRuntime } from './paseo-skills.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'agents/paseo-plugins.json');
const settingsClient = fileURLToPath(new URL('./paseo-plugins-settings-client.mjs', import.meta.url));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// github:owner/repo:path → Paseo가 기록하는 git 원격과 플러그인 경로. 레지스트리(owner/slug)는 null.
export function gitSource(source) {
  const match = /^github:([^/:]+\/[^/:]+):(.+)$/.exec(source);
  return match ? { remote: `https://github.com/${match[1]}.git`, pluginPath: match[2] } : null;
}

const sourceForm = source => gitSource(source) || /^[^/:\s]+\/[^/:\s]+$/.test(source);

// 설치 기록(identity)이 목록의 소스에서 온 것인지. 레지스트리는 npm·git 배포 모두 registry.id로 본다.
function sameSource(identity, source) {
  const git = gitSource(source);
  return git ? identity?.kind === 'git' && !identity.registry && identity.remote === git.remote && identity.pluginPath === git.pluginPath
    : identity?.registry?.id === source;
}

// 레지스트리 검토 버전: npm 배포는 version, git 배포는 commit.
export const reviewedTarget = target => target?.version ?? target?.commit;

export function validate(manifest) {
  if (!Array.isArray(manifest.plugins)) throw new Error('plugins는 배열이어야 합니다');
  if (manifest.retired !== undefined && !Array.isArray(manifest.retired)) throw new Error('retired는 배열이어야 합니다');
  const ids = new Set();
  for (const plugin of manifest.plugins) {
    if (!plugin || typeof plugin.id !== 'string' || !plugin.id || typeof plugin.source !== 'string' || !plugin.source) {
      throw new Error('플러그인에 id, source가 필요합니다');
    }
    if (ids.has(plugin.id)) throw new Error(`플러그인 id가 중복됩니다: ${plugin.id}`);
    ids.add(plugin.id);
    if (gitSource(plugin.source)) {
      if (!/^[0-9a-f]{40}$/.test(plugin.ref ?? '')) throw new Error(`${plugin.id}: git 소스는 ref에 커밋 전체 해시가 필요합니다`);
    } else if (!sourceForm(plugin.source)) {
      throw new Error(`${plugin.id}: 지원하지 않는 소스입니다 (github:owner/repo:path 또는 레지스트리 owner/slug)`);
    } else if (typeof plugin.version !== 'string' || !plugin.version) {
      throw new Error(`${plugin.id}: 레지스트리 소스는 version이 필요합니다`);
    }
    if (plugin.settings === undefined) continue;
    if (!isObject(plugin.settings)) throw new Error(`${plugin.id}: settings는 객체여야 합니다`);
    for (const [id, values] of Object.entries(plugin.settings)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(id) || !isObject(values) || !Object.keys(values).length) {
        throw new Error(`${plugin.id}: settings.${id}는 비어 있지 않은 키·값 객체여야 합니다`);
      }
    }
  }
  for (const plugin of manifest.retired ?? []) {
    if (!plugin || typeof plugin.id !== 'string' || !plugin.id || typeof plugin.source !== 'string' || !sourceForm(plugin.source)) {
      throw new Error('retired 항목에 id와 지원하는 source가 필요합니다');
    }
    if (ids.has(plugin.id)) throw new Error(`플러그인 id가 중복됩니다: ${plugin.id}`);
    ids.add(plugin.id);
  }
}

// 데몬에 저장된 플러그인 설정 값(Paseo의 plugin-settings/<플러그인>/<설정>.json). 없으면 빈 값, 읽을 수 없으면 null.
export function storedSettings(home, pluginId, settingsId) {
  try {
    const stored = JSON.parse(readFileSync(join(home, 'plugin-settings', pluginId, `${settingsId}.json`), 'utf8'));
    return isObject(stored?.values) ? stored.values : null;
  } catch (error) {
    return error.code === 'ENOENT' ? {} : null;
  }
}

// 목록이 정한 설정 키 중 저장값과 다른 것. 목록의 소스에서 설치되어 실행 중인 플러그인만 본다(설정은 실행 중인 플러그인이 받는다).
// 목록에 없는 키는 앱에서 바꾼 값을 그대로 둔다.
export function settingsDrift(manifest, listed, read) {
  if (!listed) return [];
  const drift = [];
  for (const plugin of manifest.plugins) {
    if (!plugin.settings) continue;
    const current = listed.find(item => item.id === plugin.id);
    if (!current || current.enabled === false || current.status !== 'running' || !sameSource(current.installation?.identity, plugin.source)) continue;
    for (const [id, values] of Object.entries(plugin.settings)) {
      const stored = read(plugin.id, id) ?? {};
      const keys = Object.keys(values).filter(key => JSON.stringify(stored[key]) !== JSON.stringify(values[key]));
      if (keys.length) drift.push({ plugin: plugin.id, id, values, keys });
    }
  }
  return drift;
}

// listed: 데몬의 `paseo plugin ls --json` 결과. 데몬이 꺼져 있으면 null이고 설정의 ID만으로 판단한다.
export function planPlugins(config, manifest, listed) {
  validate(manifest);
  const installed = new Map(listed
    ? listed.map(plugin => [plugin.id, plugin])
    : Object.entries(config.plugins ?? {}).map(([id, plugin]) => [id, { id, enabled: plugin?.enabled !== false }]));
  const plan = { enable: config.pluginsEnabled !== true, install: [], update: [], remove: [], dev: [], foreign: [], disabled: [], stopped: [], retiredKept: [] };
  for (const wanted of manifest.plugins) {
    const current = installed.get(wanted.id);
    if (!current) {
      plan.install.push(wanted);
      continue;
    }
    if (current.enabled === false) plan.disabled.push(wanted.id);
    else if (listed && current.status !== 'running') plan.stopped.push({ id: wanted.id, status: current.status, error: current.error });
    if (!listed) continue;
    const identity = current.installation?.identity;
    const revision = current.installation?.currentRevision;
    if (identity?.kind === 'directory') plan.dev.push({ id: wanted.id, path: identity.path });
    else if (sameSource(identity, wanted.source)) {
      const target = wanted.ref ?? wanted.version;
      if (revision !== target) plan.update.push({ plugin: wanted, from: revision ?? '?' });
    } else plan.foreign.push({ id: wanted.id, source: current.source ?? identity?.kind ?? '?' });
  }
  // 은퇴한 플러그인은 목록의 소스에서 설치된 것만 지운다. 데몬이 꺼져 있으면 소스를 알 수 없어 판단하지 않는다.
  for (const retired of manifest.retired ?? []) {
    const current = listed && installed.get(retired.id);
    if (!current) continue;
    const identity = current.installation?.identity;
    if (sameSource(identity, retired.source)) plan.remove.push(retired);
    else plan.retiredKept.push({ id: retired.id, source: identity?.kind === 'directory' ? identity.path : current.source ?? identity?.kind ?? '?' });
  }
  return plan;
}

function paseo(args, options = {}) {
  const result = spawnSync('paseo', args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function json(result) {
  try { return JSON.parse(result.stdout); } catch { return null; }
}

// 실행 중인 데몬의 플러그인 목록. 데몬이 꺼져 있으면 null.
function listPlugins(home) {
  const result = paseo(['plugin', 'ls', '--json', '--home', home]);
  if (result.status !== 0 && /DAEMON_NOT_RUNNING/.test(result.stdout + result.stderr)) return null;
  const list = result.status === 0 ? json(result) : null;
  if (!Array.isArray(list)) throw new Error(`플러그인 목록 확인 실패: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return list;
}

function requireList(home) {
  const list = listPlugins(home);
  if (!list) throw new Error('Paseo 데몬에 연결할 수 없습니다');
  return list;
}

function report(plan) {
  if (plan.enable) console.log('켜기: 플러그인 사용 (pluginsEnabled)');
  for (const plugin of plan.install) console.log(`설치 필요: ${plugin.id} (${plugin.source})`);
  for (const { plugin, from } of plan.update) console.log(`버전 맞춤 필요: ${plugin.id} ${from} → ${plugin.ref ?? plugin.version}`);
  for (const plugin of plan.remove) console.log(`제거 필요 (목록에서 은퇴): ${plugin.id}`);
  for (const { id, source } of plan.retiredKept) console.log(`은퇴했지만 다른 소스 설치 (유지): ${id} ${source}`);
  for (const { id, path } of plan.dev) console.log(`개발 중 (폴더 설치, 유지): ${id} ${path}`);
  for (const { id, source } of plan.foreign) console.log(`다른 소스 설치 (유지): ${id} ${source}`);
  for (const id of plan.disabled) console.log(`꺼진 상태 (유지): ${id}`);
  for (const { id, status, error } of plan.stopped) console.log(`실행 안 됨: ${id} (${status}${error ? `: ${error}` : ''})`);
}

const pending = plan => plan.enable || plan.install.length || plan.update.length || plan.remove.length;
const reportDrift = drift => drift.forEach(({ plugin, id, keys }) => console.log(`설정 맞춤 필요: ${plugin} ${id} (${keys.join(', ')})`));

// 앱의 Node 런타임으로 설정 RPC를 부른다. 결과는 호출한 쪽이 저장값을 다시 읽어 확인한다.
function applySettings(home, drift) {
  const runtime = appRuntime();
  if (!runtime) {
    console.log('설정 맞춤 불가: PATH의 paseo가 Paseo 앱 안의 CLI가 아닙니다. 앱의 플러그인 설정에서 맞추세요');
    return;
  }
  const result = spawnSync(runtime.helper, ['--disable-warning=DEP0040', runtime.runner, 'node-script', settingsClient], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production', BOOTSTRAP_PASEO_HOME: home, BOOTSTRAP_PASEO_CLIENT: runtime.client,
      BOOTSTRAP_PLUGIN_SETTINGS: JSON.stringify(drift.map(({ plugin, id, values }) => ({ plugin, id, values })))
    }
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (output) console.log(output.slice(0, 1000));
}

function syncedPath(home) {
  const state = process.env.XDG_STATE_HOME || join(homedir(), '.local/state');
  return join(state, 'bootstrap/paseo-plugins', createHash('sha256').update(home).digest('hex').slice(0, 16));
}

// 레지스트리는 검토된 버전만 준다. 그 버전이 목록에서 승인한 버전일 때만 받는다.
// 결과: 'ok' 갱신함, 'kept' 검토 버전이 달라 유지, 'failed' 확인·갱신 실패.
function updateRegistry(home, plugin) {
  const result = paseo(['plugin', 'update', plugin.id, '--check', '--json', '--home', home]);
  const preview = json(result)?.[0];
  if (result.status !== 0 || !preview || preview.outcome === 'error') {
    console.log(`레지스트리 확인 실패: ${plugin.id} ${preview?.error ?? (result.stderr || result.stdout).trim().slice(0, 200)}`);
    return 'failed';
  }
  const target = reviewedTarget(preview.target);
  if (target !== plugin.version) {
    console.log(`유지: ${plugin.id} 레지스트리 검토 버전(${target ?? preview.outcome})이 목록의 ${plugin.version}과 다릅니다`);
    return 'kept';
  }
  return paseo(['plugin', 'update', plugin.id, '--yes', '--home', home], { stdio: 'inherit' }).status === 0 ? 'ok' : 'failed';
}

function apply(home, config, manifest) {
  const failed = new Set();
  const kept = new Set();
  const touched = new Set();
  let enabled = config.pluginsEnabled === true;
  let plan = planPlugins(config, manifest, requireList(home));
  if (plan.enable) {
    enabled = paseo(['daemon', 'config', 'set', 'pluginsEnabled', 'true', '--home', home], { stdio: 'inherit' }).status === 0;
    if (!enabled) failed.add('pluginsEnabled');
  }
  for (const plugin of plan.install) {
    console.log(`설치: ${plugin.id}`);
    touched.add(plugin.id);
    const ref = plugin.ref ? ['--ref', plugin.ref] : [];
    if (paseo(['plugin', 'install', plugin.source, '--id', plugin.id, ...ref, '--home', home], { stdio: 'inherit' }).status !== 0) failed.add(plugin.id);
  }
  for (const plugin of plan.remove) {
    console.log(`제거: ${plugin.id} (목록에서 은퇴)`);
    if (paseo(['plugin', 'remove', plugin.id, '--home', home], { stdio: 'inherit' }).status !== 0) failed.add(plugin.id);
  }
  // 레지스트리 설치는 그때의 검토 버전이 들어오므로 다시 보고 맞춘다.
  if (plan.install.length) plan = planPlugins({ ...config, pluginsEnabled: enabled }, manifest, requireList(home));
  for (const { plugin } of plan.update) {
    console.log(`버전 맞춤: ${plugin.id} → ${plugin.ref ?? plugin.version}`);
    touched.add(plugin.id);
    if (plugin.ref) {
      if (paseo(['plugin', 'update', plugin.id, '--ref', plugin.ref, '--home', home], { stdio: 'inherit' }).status !== 0) failed.add(plugin.id);
    } else {
      const outcome = updateRegistry(home, plugin);
      if (outcome === 'failed') failed.add(plugin.id);
      if (outcome === 'kept') kept.add(plugin.id);
    }
  }
  // 명령의 종료 코드만 믿지 않고 결과를 다시 읽어 확인한다.
  const list = requireList(home);
  const after = planPlugins({ ...config, pluginsEnabled: enabled }, manifest, list);
  const read = (plugin, id) => storedSettings(home, plugin, id);
  const drift = settingsDrift(manifest, list, read);
  if (drift.length) applySettings(home, drift);
  for (const { plugin, id } of settingsDrift(manifest, list, read)) failed.add(`${plugin} 설정 ${id}`);
  for (const plugin of after.install) failed.add(plugin.id);
  for (const { plugin } of after.update) if (!kept.has(plugin.id)) failed.add(plugin.id);
  for (const plugin of after.remove) failed.add(plugin.id);
  for (const { id, status } of after.stopped) if (touched.has(id)) failed.add(`${id}(${status})`);
  if (failed.size) throw new Error(`실패: ${[...failed].join(', ')}. paseo plugin ls·paseo plugin logs <id> 로 원인을 확인하고 다시 실행하세요`);
}

// 자체 플러그인은 그 폴더를 마지막으로 바꾼 main의 커밋(그 커밋의 CI가 하나 이상 있고 모두 성공일 때),
// 레지스트리는 이 기기에서 본 검토 버전으로 목록을 올린다.
function bump(home, manifest) {
  let changed = false;
  const gh = args => spawnSync('gh', ['api', ...args], { encoding: 'utf8' });
  for (const plugin of manifest.plugins) {
    const git = gitSource(plugin.source);
    let target;
    if (git) {
      const repo = git.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
      const last = gh([`repos/${repo}/commits?sha=main&path=${encodeURIComponent(git.pluginPath)}&per_page=1`, '--jq', '.[0].sha']);
      target = last.status === 0 ? last.stdout.trim() : '';
      if (!/^[0-9a-f]{40}$/.test(target)) { console.log(`건너뜀: ${plugin.id} 변경 기록 확인 실패 (gh 로그인 확인)`); continue; }
      if (target === plugin.ref) { console.log(`최신: ${plugin.id}`); continue; }
      const runs = gh([`repos/${repo}/commits/${target}/check-runs`, '--jq', '.check_runs[] | .status + " " + (.conclusion // "")']);
      if (runs.status !== 0) { console.log(`건너뜀: ${plugin.id} CI 결과 확인 실패 (gh 로그인 확인)`); continue; }
      const lines = runs.stdout.split('\n').filter(Boolean);
      const bad = lines.filter(line => !/^completed (success|skipped|neutral)$/.test(line));
      if (!lines.length || bad.length) {
        console.log(`건너뜀: ${plugin.id} ${target.slice(0, 7)}의 CI가 없거나 끝나지 않았거나 실패 (${bad.join(', ') || '기록 없음'})`);
        continue;
      }
      plugin.ref = target;
    } else {
      const result = paseo(['plugin', 'update', plugin.id, '--check', '--json', '--home', home]);
      const preview = json(result)?.[0];
      target = reviewedTarget(preview?.target) ?? (preview?.outcome === 'current' ? preview?.current?.currentRevision : undefined);
      if (!target) {
        console.log(`건너뜀: ${plugin.id} 레지스트리 검토 버전 확인 실패 (데몬이 켜져 있고 이 기기에 레지스트리로 설치되어 있어야 함)`);
        continue;
      }
      if (target === plugin.version) { console.log(`최신: ${plugin.id}`); continue; }
      plugin.version = target;
    }
    console.log(`올림: ${plugin.id} → ${target}`);
    changed = true;
  }
  if (!changed) return;
  const line = plugin => `{ ${Object.entries(plugin).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')} }`;
  const list = (key, items) => `  "${key}": [\n${items.map(plugin => `    ${line(plugin)}`).join(',\n')}\n  ]`;
  const sections = [list('plugins', manifest.plugins), ...(manifest.retired?.length ? [list('retired', manifest.retired)] : [])];
  writeFileSync(manifestPath, `{\n${sections.join(',\n')}\n}\n`);
  console.log('agents/paseo-plugins.json을 고쳤습니다. 커밋·push하면 자동 갱신으로 모든 기기에 적용됩니다.');
}

function main() {
  const args = process.argv.slice(2);
  let home = process.env.PASEO_HOME || join(homedir(), '.paseo');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home' && args[i + 1] && !args[i + 1].startsWith('--')) home = args[++i];
    else if (!['--check', '--dry-run', '--bump'].includes(args[i])) throw new Error(`알 수 없는 인자: ${args[i]}`);
  }
  home = resolve(home);
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === '1';
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  validate(manifest);
  if (args.includes('--bump')) return bump(home, manifest);
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) {
    console.log('Paseo 설정 없음: ./bootstrap.sh --only paseo 가 첫 설정을 합니다.');
    if (!dryRun) process.exitCode = 2;
    return;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Paseo 설정은 객체여야 합니다');
  const digest = createHash('sha256').update(raw).digest('hex');
  const synced = syncedPath(home);
  const inSync = existsSync(synced) && readFileSync(synced, 'utf8').trim() === digest;
  const listed = listPlugins(home);
  const plan = planPlugins(config, manifest, listed);
  const drift = settingsDrift(manifest, listed, (plugin, id) => storedSettings(home, plugin, id));
  report(plan);
  reportDrift(drift);

  if (check) {
    const offline = !listed && !inSync;
    if (offline) console.log('데몬이 꺼져 있고 마지막으로 맞춘 뒤 목록이 바뀌었습니다.');
    if (pending(plan) || drift.length || offline || plan.foreign.length || plan.disabled.length || plan.stopped.length) process.exitCode = 1;
    else console.log(`Paseo 플러그인이 저장소 목록과 일치합니다${listed ? '' : ' (데몬이 꺼져 있어 버전·실행 상태는 확인 못 함)'}.`);
    return;
  }
  // 데몬이 꺼져 있으면 이 기기에서 마지막으로 맞춘 기록만 본다. 그 뒤 목록이 바뀌었을 때만 데몬을 잠시 켠다.
  if (!listed && inSync) {
    console.log('데몬이 꺼져 있고 마지막으로 맞춘 뒤 목록이 바뀌지 않았습니다.');
    return;
  }
  if (listed && !pending(plan) && !drift.length) {
    console.log('맞출 플러그인이 없습니다.');
    if (!inSync && !dryRun) writeSynced(synced, digest);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] Paseo CLI로 맞출 예정${listed ? '' : ' (데몬을 잠시 켜서 확인)'}`);
    return;
  }
  if (!listed) {
    // 데몬이 이 실행의 환경을 물려받지 않게 한다 (65-paseo.sh의 onboard와 같은 이유).
    console.log('플러그인을 맞추려고 Paseo 데몬을 잠시 켭니다.');
    const env = { ...process.env };
    for (const key of ['BOOTSTRAP_UNATTENDED', 'BOOTSTRAP_LOCKED', 'BOOTSTRAP_RESULTS']) delete env[key];
    const started = paseo(['daemon', 'start', '--home', home, '--timeout', '120'], { stdio: ['ignore', 'inherit', 'inherit'], env });
    if (started.status !== 0) throw new Error('Paseo 데몬 시작 실패');
  }
  try {
    apply(home, config, manifest);
    writeSynced(synced, digest);
  } finally {
    // 꺼져 있던 데몬은 다시 끈다. 켜 둔 채 두면 백그라운드 실행에서 띄운 데몬이 계속 남는다.
    if (!listed && paseo(['daemon', 'stop', '--home', home], { stdio: ['ignore', 'inherit', 'inherit'] }).status !== 0) {
      console.log('경고: 잠시 켠 Paseo 데몬을 끄지 못했습니다 (paseo daemon stop)');
    }
  }
}

function writeSynced(path, digest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${digest}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`Paseo 플러그인: ${error.message}`); process.exitCode = 1; }
}
