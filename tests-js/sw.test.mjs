// spec-startup S16：本案改了 app.js／engine.js，sw.js 必須升 CACHE 版本，其餘設計不得變動。
// 基準為 commit 7ac1760 的 sw.js；下列字面值即該版內容（CI 為淺層 clone，無法保證取得該 commit）。
// 本機若取得到基準 commit，另以 git 內容交叉核對這些字面值沒有抄錯。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASELINE_COMMIT = '7ac1760';
const BASELINE = {
  cache: 'const CACHE = `${PREFIX}v3`;',
  prefix: "const PREFIX = 'nhi-price-shell-';",
  shell: "const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'engine.js', 'manifest.webmanifest', 'icon.svg'];",
  bypass: "  if (url.pathname.includes('/data/')) return;          // 資料不經 SW",
};

const root = fileURLToPath(new URL('..', import.meta.url));
const lines = (text) => text.split(/\r?\n/);
const current = lines(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'));
const only = (all, re, what) => {
  const hit = all.filter((l) => re.test(l));
  assert.equal(hit.length, 1, `${what} 應恰有一行`);
  return hit[0];
};

test('S16 sw.js：CACHE 值與基準不同', () => {
  const cache = only(current, /^const CACHE = /, 'CACHE 宣告');
  assert.notEqual(cache, BASELINE.cache);
  assert.match(cache, /^const CACHE = `\$\{PREFIX\}v\d+`;$/);
});

test('S16 sw.js：PREFIX、SHELL 清單、data/ 旁路判斷式與基準逐字相同', () => {
  assert.equal(only(current, /^const PREFIX = /, 'PREFIX 宣告'), BASELINE.prefix);
  assert.equal(only(current, /^const SHELL = /, 'SHELL 宣告'), BASELINE.shell);
  assert.equal(only(current, /\/data\//, 'data/ 旁路判斷式'), BASELINE.bypass);
});

test('S16 sw.js：除 CACHE 一行外，其餘內容與基準字面值所在的檔案結構一致（本機有基準 commit 時逐行比對）', (t) => {
  let baseline;
  try {
    baseline = lines(execFileSync('git', ['show', `${BASELINE_COMMIT}:sw.js`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    t.skip(`取不到基準 commit ${BASELINE_COMMIT}（淺層 clone）`);
    return;
  }
  for (const [name, literal] of Object.entries(BASELINE)) {
    assert.ok(baseline.includes(literal), `基準字面值 ${name} 與 ${BASELINE_COMMIT} 的 sw.js 不符`);
  }
  assert.equal(current.length, baseline.length, '行數');
  const changed = current.map((l, i) => (l === baseline[i] ? null : i + 1)).filter((n) => n !== null);
  assert.deepEqual(changed.map((n) => baseline[n - 1]), [BASELINE.cache], '只有 CACHE 一行可以不同');
});
