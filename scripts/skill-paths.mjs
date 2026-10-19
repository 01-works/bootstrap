// Claude·Codex 사용자 스킬 경로. agent-skills.mjs와 browser-use-setup.mjs가 같은 규칙을 쓴다.
// Codex 공식 사용자 경로는 ~/.agents/skills다. ~/.codex/skills에 같은 이름이 있으면 둘 다 보이므로 중복으로 본다.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function present(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// 아직 없는 경로도 상위 링크를 따라 실제 위치로 바꾼다. 깨진 링크는 그대로 둔다(충돌로 다룬다).
export function physical(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (present(path)) return path;
    return join(physical(dirname(path)), basename(path));
  }
}

// 설치할 경로 목록. 두 경로가 같은 실제 위치면 한 번만 돌려준다.
export function skillDestinations(name, { home, env = {} }) {
  const codex = join(home, '.agents/skills', name);
  const claude = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills', name);
  const legacy = join(env.CODEX_HOME || join(home, '.codex'), 'skills', name);
  const destinations = [...new Map([codex, claude].map(path => [physical(path), path])).values()];
  if (present(legacy) && !destinations.some(path => physical(path) === physical(legacy))) {
    throw new Error(`Codex 이전 경로에 같은 스킬이 있습니다: ${legacy}. ~/.agents/skills와 중복으로 보이므로 확인 후 옮기거나 지우세요. 기존 항목은 유지했습니다.`);
  }
  return destinations;
}
