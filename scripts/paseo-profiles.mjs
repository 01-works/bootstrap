// Paseo 프로필 병합과 에이전트 도구 제공 설정. 설정 검증·저장·reload는 Paseo CLI에 맡긴다.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fields = ['name', 'provider', 'model', 'modeId', 'thinkingOptionId', 'featureValues', 'notes'];

function validate(profiles) {
  if (!Array.isArray(profiles)) throw new Error('agentProfiles는 배열이어야 합니다');
  const ids = new Set();
  const names = new Set();
  for (const profile of profiles) {
    if (!profile || !['id', 'name', 'provider'].every(key => typeof profile[key] === 'string' && profile[key])) {
      throw new Error('프로필에 id, name, provider가 필요합니다');
    }
    if (ids.has(profile.id) || names.has(profile.name)) throw new Error('프로필 id 또는 이름이 중복됩니다');
    ids.add(profile.id);
    names.add(profile.name);
  }
}

export function mergeProfiles(existing, manifest, update = false) {
  validate(existing);
  validate(manifest.profiles);
  const profiles = structuredClone(existing);
  const changes = [];
  const drift = [];
  for (const wanted of manifest.profiles) {
    const matches = profiles.filter(profile => profile.id === wanted.id || profile.name === wanted.name ||
      manifest.renames?.[profile.name] === wanted.name);
    if (matches.length > 1) throw new Error(`프로필 매칭이 모호합니다: ${wanted.name}`);
    const current = matches[0];
    if (!current) {
      profiles.push(structuredClone(wanted));
      changes.push(`추가: ${wanted.name}`);
    } else if (fields.some(key => !isDeepStrictEqual(current[key], wanted[key]))) {
      if (!update) {
        drift.push(wanted.name);
        continue;
      }
      // 기존 ID·아이콘·색상 등은 유지하고 실행 설정은 제공자에 맞게 교체한다.
      for (const key of fields) {
        delete current[key];
        if (Object.hasOwn(wanted, key)) current[key] = structuredClone(wanted[key]);
      }
      changes.push(`갱신: ${wanted.name}`);
    }
  }
  validate(profiles);
  return { profiles, changes, drift };
}

function main() {
  const args = process.argv.slice(2);
  let home = process.env.PASEO_HOME || join(homedir(), '.paseo');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home' && args[i + 1] && !args[i + 1].startsWith('--')) home = args[++i];
    else if (!['--check', '--dry-run', '--update'].includes(args[i])) throw new Error(`알 수 없는 인자: ${args[i]}`);
  }
  home = resolve(home);
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) {
    console.log('Paseo 설정 없음: ./bootstrap.sh --only paseo 가 첫 설정을 합니다.');
    if (!(args.includes('--dry-run') || process.env.DRY_RUN === '1')) process.exitCode = 2;
    return;
  }
  const original = readFileSync(configPath, 'utf8');
  const config = JSON.parse(original);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Paseo 설정은 객체여야 합니다');
  const manifest = JSON.parse(readFileSync(join(root, 'agents/paseo-profiles.json'), 'utf8'));
  const { profiles, changes, drift } = mergeProfiles(config.daemon?.agentProfiles ?? [], manifest, args.includes('--update'));
  for (const change of changes) console.log(change);
  for (const name of drift) console.log(`기존 설정 유지 (저장소와 다름): ${name}`);
  // 기존 설정에 쓸 값. 프로필은 바뀐 것이 있을 때만, Paseo 도구(yw-supervisor가 사용)는 꺼져 있을 때만.
  const settings = [];
  if (changes.length) settings.push(['daemon.agentProfiles', JSON.stringify(profiles)]);
  if (config.daemon?.mcp?.injectIntoAgents !== true) {
    console.log('켜기: 에이전트에 Paseo 도구 제공 (daemon.mcp.injectIntoAgents)');
    settings.push(['daemon.mcp.injectIntoAgents', 'true']);
  }
  if (args.includes('--check')) {
    if (settings.length || drift.length) process.exitCode = 1;
    else console.log('Paseo 프로필·도구 설정이 저장소와 일치합니다.');
    return;
  }
  if (!settings.length) {
    console.log('추가로 저장할 설정이 없습니다.');
    return;
  }
  if (args.includes('--dry-run') || process.env.DRY_RUN === '1') {
    console.log('[dry-run] Paseo CLI로 검증·저장·reload 예정');
    return;
  }
  if (readFileSync(configPath, 'utf8') !== original) throw new Error('Paseo 설정이 변경되었습니다. 다시 실행하세요.');
  const state = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'bootstrap/backup');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const backupDir = mkdtempSync(join(state, 'paseo-'));
  const backup = join(backupDir, 'config.json');
  copyFileSync(configPath, backup);
  chmodSync(backup, 0o600);
  console.log(`기존 설정 백업: ${backup}`);
  for (const [key, value] of settings) {
    const result = spawnSync('paseo', ['daemon', 'config', 'set', key, value, '--home', home], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Paseo 설정 적용 실패 (${key}). 앞의 값은 저장되었을 수 있습니다. CLI 출력의 저장·reload 상태를 확인하고 다시 실행하세요.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`Paseo 프로필: ${error.message}`); process.exitCode = 1; }
}
