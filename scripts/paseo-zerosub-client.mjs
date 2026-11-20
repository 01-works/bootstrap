// ZeroSub의 계정 추가 화면과 같은 RPC를 로컬 Paseo 앱의 클라이언트로 호출한다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRuntime, runAppScript } from './paseo-skills.mjs';

const endpoint = 'https://api.anthropic.com';
const accountIdentity = key => 'api|anthropic|' + createHash('sha256').update(key).digest('hex').slice(0, 16);

async function register(home, accounts) {
  const { connectToDaemon } = await import(process.env.BOOTSTRAP_PASEO_CLIENT);
  const client = await connectToDaemon({ target: { kind: 'instance', home }, timeout: 15_000 });
  try {
    const view = await client.invokePluginRpc('zerosub', 'zerosub.state', {});
    // 화면의 계정 목록에는 키 식별자가 없다. ZeroSub가 기록한 식별자로 동일한 키를 다시 만들지 않는다.
    let stored = [];
    try { stored = JSON.parse(readFileSync(join(home, 'zerosub/state.json'), 'utf8')).accounts; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const existing = accounts.map(({ key, label }) => {
      const identity = accountIdentity(key);
      const match = stored.find(a => a.family === 'claude' && a.auth === 'api' &&
        a.identity?.replace(`api|${endpoint}|`, 'api|anthropic|') === identity);
      if (match && (!match.signedIn || match.disabled)) throw new Error('저장된 API 계정이 비활성입니다.');
      if (!match && view.accounts.some(a => a.family === 'claude' && a.label.toLowerCase() === label.toLowerCase())) {
        throw new Error('ZeroSub 계정 이름이 이미 사용 중입니다.');
      }
      return match?.id;
    });

    const selection = {};
    for (const [index, { provider, label, key }] of accounts.entries()) {
      const result = existing[index] ? { accountId: existing[index] } :
        await client.invokePluginRpc('zerosub', 'zerosub.accounts.api.add', {
          family: 'claude', label, key, keyKind: 'api_key', baseUrl: endpoint,
          disableTelemetry: false, disableErrorReporting: false, disableNonessentialTraffic: false
        });
      if (typeof result?.accountId !== 'string') throw new Error('ZeroSub 등록 응답이 올바르지 않습니다.');
      selection[provider] = result.accountId;
    }
    const updated = await client.invokePluginRpc('zerosub', 'zerosub.state', {});
    if (!Object.values(selection).every(id => updated.accounts.some(account => account.id === id))) {
      throw new Error('ZeroSub 계정 목록에 등록이 반영되지 않았습니다.');
    }
    return selection;
  } finally {
    await client.close();
  }
}

try {
  const input = readFileSync(0, 'utf8');
  if (process.env.BOOTSTRAP_ZEROSUB_CLIENT === '1') {
    console.log(JSON.stringify(await register(process.env.BOOTSTRAP_PASEO_HOME, JSON.parse(input))));
  } else {
    const runtime = appRuntime();
    if (!runtime) throw new Error('Paseo 앱 런타임을 찾을 수 없습니다.');
    const result = runAppScript(runtime, fileURLToPath(import.meta.url), process.argv[2],
      { BOOTSTRAP_ZEROSUB_CLIENT: '1' }, input);
    if (result.status !== 0) throw new Error('ZeroSub 계정 등록에 실패했습니다.');
    // 앱 런타임 출력에는 RPC 오류의 원문이 들어갈 수 있어 상태 ID만 반환한다.
    const ids = JSON.parse(result.stdout);
    if (Object.keys(ids).some(key => !['claude-api-office', 'claude-api-k', 'claude-api-y', 'claude-api-hi'].includes(key)) ||
        Object.values(ids).some(id => typeof id !== 'string' || !/^claude-[a-f0-9]{12}$/.test(id))) {
      throw new Error('ZeroSub 계정 식별자가 올바르지 않습니다.');
    }
    console.log(JSON.stringify(ids));
  }
} catch {
  console.error('ZeroSub 계정 등록을 확인할 수 없습니다.');
  process.exitCode = 1;
}
