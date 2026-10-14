import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, parseOutcome, extractRuns, runsForHunk, hunkStatus, decidingRun, isTargeted, splitSegments } from '../src/runs.js';

const FORBIDDEN = /tested|verified|covered|proof that it works/i;
const produced = [];
function parse(runner, stdout, stderr = '', isError = false) {
  const r = parseOutcome(runner, stdout, stderr, isError);
  produced.push(r.summary ?? '');
  return r;
}

// ---------------------------------------------------------------------------
// classifyRun
// ---------------------------------------------------------------------------
describe('classifyRun: runner detection through prefixes', () => {
  const cases = [
    ['pytest', 'pytest'],
    ['python3 -m pytest tests/ -q', 'pytest'],
    ['/home/u/.venvs/env/bin/python -m pytest test_lof.py -q -p no:cacheprovider --rootdir=$S 2>&1', 'pytest'],
    ['timeout 90 python3 -m unittest discover -s python/tests 2>&1', 'unittest'],
    ['uv run pytest -x', 'pytest'],
    ['poetry run mypy src/', 'mypy'],
    ['pipenv run pyright app', 'pyright'],
    ['uvx ruff@0.14.3 check --config pyproject.toml pkg/tests/test_x.py', 'ruff'],
    ['npx vitest run src/x.test.ts 2>&1 | tail -6', 'vitest'],
    ['npx -y vitest run', 'vitest'],
    ['pnpm exec tsc --noEmit -p tsconfig.json', 'tsc'],
    ['yarn jest src/foo.test.ts', 'jest'],
    ['npx jest --runInBand', 'jest'],
    ['npx mocha test/', 'mocha'],
    ['node --test dist-test/alias.test.js 2>&1', 'node:test'],
    ['node --test --test-reporter=spec dist-test/', 'node:test'],
    ['TEST_DATABASE_URL=postgres://u:p@localhost:55432/db node --test dist-test/db/integration.test.js 2>&1', 'node:test'],
    ['DATABASE_URL=postgres://x:x@localhost:5432/x npx vitest run tests/astra.test.ts', 'vitest'],
    ['export PATH=$HOME/.nvm/versions/node/v22.17.1/bin:$PATH && npx tsc --noEmit 2>&1 | head -40', 'tsc'],
    ['cd /repo/web && npx tsc --noEmit 2>&1 | head -40', 'tsc'],
    ['source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null 2>&1; node -v; npx tsc --noEmit', 'tsc'],
    ['npx eslint lib/a.ts lib/a.test.ts 2>&1 | tail -5', 'eslint'],
    ['go test ./... -run TestFoo', 'go'],
    ['go vet ./...', 'go'],
    ['cargo clippy --all-targets', 'cargo'],
    ['cargo test -p core', 'cargo'],
    ['make test 2>&1', 'make'],
    ['cd /repo && make start > /tmp/scratch/make_start.log 2>&1', 'make'],
    ['npm run build 2>&1 | tail -40', 'npm'],
    ['npm test', 'npm'],
    ['pnpm run typecheck', 'npm'],
    ['bun test', 'bun'],
    ['python3 scripts/check.py --fast', 'python'],
    ['timeout 300 python3 pull.py', 'python'],
    ['node shot.mjs 2>&1 | head -20', 'node'],
    ['npx tsx scripts/seed.ts', 'node'],
    ['bash scripts/verify.sh > /tmp/scratch/verify.log 2>&1; echo rc=$?; tail -5 /tmp/scratch/verify.log', 'script'],
    ['./scripts/verify.sh', 'script'],
    ['bash -c "cd app && npx jest src/a.test.ts"', 'jest'],
    ['(npx tsc --noEmit -p . 2>&1 | tail -5; echo TSC_DONE) & (npx eslint lib/a.ts 2>&1 | tail -5)', 'tsc+eslint'],
    ['npx vitest run 2>&1 | grep -E "Tests "; npx tsc --noEmit 2>&1 | grep -c "error TS"', 'vitest+tsc'],
  ];
  for (const [cmd, runner] of cases) {
    test(`${runner} <= ${cmd.slice(0, 60)}`, () => {
      const r = classifyRun(cmd);
      assert.equal(r.runner, runner);
      assert.equal(r.isRun, true);
      assert.equal(r.writes, false);
    });
  }
});

describe('classifyRun: not runs', () => {
  const notRuns = [
    'grep -rn "pytest" src | head',
    'git status --short && git log --oneline -3',
    'ls src/**/__tests__ 2>/dev/null | head',
    'npm install --silent',
    'npm ls -g --depth=0',
    'pip install pytest hypothesis',
    'python3 -c "import json; print(json.dumps({\\"a\\": 1}))"',
    'python3 - <<\'EOF\'\nimport pytest\nprint("hi")\nEOF',
    'node -e "console.log(require(\'./package.json\').version)"',
    'cat package.json | grep vitest',
    'echo "npx vitest run" > notes.txt',
    'curl -s https://example.invalid/api | head',
    'docker compose up -d',
    'gh pr view 1 --json title',
    'python3 -m venv .venv',
    'python3 -m pip install -q ruff',
    'npm run dev',
  ];
  for (const cmd of notRuns) {
    test(`not a run: ${cmd.slice(0, 60)}`, () => {
      const r = classifyRun(cmd);
      assert.equal(r.isRun, false, JSON.stringify(r));
    });
  }
});

describe('classifyRun: commands that write files or commit are not runs', () => {
  const writers = [
    ['sed -i "s/a/b/" x.py; python3 -m pytest x.py', 'pytest'],
    ['echo hi > out.txt && pytest', 'pytest'],
    ['cat > tests/test_x.py <<\'EOF\'\nimport pytest\ndef test_a(): pass\nEOF\npytest tests/test_x.py', 'pytest'],
    ['git commit -qam "fix" && npx vitest run', 'vitest'],
    ['git stash push -q src/route.ts && npx vitest run src/x.test.ts 2>&1 | grep Tests; git stash pop -q', 'vitest'],
    ['python3 - <<\'EOF\'\np="a.py"; s=open(p).read(); open(p,"w").write(s.replace("a","b"))\nEOF\nnpx vitest run a.test.ts', 'vitest'],
    ['python3 -c "\nimport json\nopen(\'x.json\',\'w\').write(\'1\')\n" && pytest tests/', 'pytest'],
    ['npx prettier --write src/a.ts && npx vitest run', 'prettier+vitest'],
    ['npx eslint --fix src/ && npm test', 'eslint+npm'],
    ['ruff format pkg/ && pytest', 'ruff+pytest'],
    ['npx vitest run 2>&1 | tee out.log', 'vitest'],
    ['cp fixtures/a.json src/a.json && node --test test/', 'node:test'],
    ['git checkout -q main && git pull -q && npm test', 'npm'],
  ];
  for (const [cmd, runner] of writers) {
    test(`writes: ${cmd.slice(0, 60)}`, () => {
      const r = classifyRun(cmd);
      assert.equal(r.writes, true, JSON.stringify(r));
      assert.equal(r.isRun, false);
      assert.equal(r.runner, runner);
    });
  }
  test('log capture of a runner output is not a write', () => {
    assert.deepEqual(classifyRun('pytest > results.txt 2>&1; tail results.txt'), { isRun: true, runner: 'pytest', writes: false, targets: [], silentOk: false });
    assert.equal(classifyRun('make test > /tmp/x/maketest.log 2>&1; echo "exit $?"; tail -20 /tmp/x/maketest.log').isRun, true);
    assert.equal(classifyRun('npx vitest run 2>&1 | tee /dev/null').isRun, true);
    assert.equal(classifyRun('npx vitest run > /dev/null 2>&1').isRun, true);
  });
  test('ruff format --check / --diff are runs, ruff format and --fix are writes', () => {
    assert.equal(classifyRun('uvx ruff@latest format --check --config pyproject.toml pkg/x.py').isRun, true);
    assert.equal(classifyRun('ruff format --diff pkg/x.py').isRun, true);
    assert.equal(classifyRun('ruff format pkg/x.py').writes, true);
    assert.equal(classifyRun('ruff check --fix pkg/').writes, true);
  });
});

describe('classifyRun: operators inside quotes are data, not segment splits', () => {
  const quoted = [
    "grep -A6 -E '^== (script|node|npm|node:test|vitest|make|prettier|pytest|ruff|eslint)$' /tmp/x/evidence.txt | cut -c1-330",
    'grep -n "VITEST_MAX_WORKERS\\|vitest run\\|npm run test" scripts/verify.sh | head; docker ps --format "{{.Names}}"',
    "ssh root@203.0.113.7 'cd /srv/app && nohup ./deploy.sh > /tmp/deploy-34.log 2>&1 &' ; echo launched",
    'echo "pytest && make test" > notes.txt',
    "awk '{ print $1 \"|\" $2 }' data.txt | sort",
  ];
  for (const cmd of quoted) {
    test(`not a run: ${cmd.slice(0, 60)}`, () => {
      const r = classifyRun(cmd);
      assert.equal(r.isRun, false, JSON.stringify(r));
      assert.equal(r.runner, null);
    });
  }
  test('splitSegments honours single, double and backtick quotes and keeps 2>&1 together', () => {
    assert.deepEqual(splitSegments("grep -E 'a|b' f | cut -c1"), ["grep -E 'a|b' f", 'cut -c1']);
    assert.deepEqual(splitSegments('ssh h "cd x && make" ; echo done'), ['ssh h "cd x && make"', 'echo done']);
    assert.deepEqual(splitSegments('a 2>&1 | b && c || d & e'), ['a 2>&1', 'b', 'c', 'd', 'e']);
    assert.deepEqual(splitSegments('x=$(git rev-parse HEAD); echo `date +%s; ls`'), ['git rev-parse HEAD', 'echo `date +%s; ls`']);
    assert.deepEqual(splitSegments('echo "a \\" ; b" ; c'), ['echo "a \\" ; b"', 'c']);
  });
  test('the real cases still split on real operators', () => {
    assert.equal(classifyRun('npx vitest run 2>&1 | grep -E "Tests "; npx tsc --noEmit 2>&1 | grep -c "error TS"').runner, 'vitest+tsc');
    assert.equal(classifyRun('cd /r && npx tsc --noEmit 2>&1 | tail -3').runner, 'tsc');
  });
});

describe('classifyRun: hunkproof itself is never a run', () => {
  for (const cmd of ['node bin/hunkproof.js --pr 1 --repo ~/hunkproof', 'node /home/u/hunkproof/bin/hunkproof.js --pr 457 --no-note', 'npx hunkproof --pr 1', './bin/hunkproof.js stats', 'cd ~/hunkproof && node bin/hunkproof.js --pr 1 | head -3']) {
    test(cmd, () => {
      const r = classifyRun(cmd);
      assert.equal(r.isRun, false, JSON.stringify(r));
    });
  }
  test('a project script that merely contains the word still is', () => {
    assert.equal(classifyRun('node scripts/hunkproof-check.js').isRun, true);
  });
});

describe('classifyRun: silentOk (empty output may mean pass)', () => {
  const cases = [
    ['npx tsc --noEmit', true],
    ['cd /r && npx tsc --noEmit 2>&1', true],
    ['bash scripts/verify.sh', true],
    ['npx tsc --noEmit 2>&1 | tail -5', false],
    ['bash scripts/verify.sh > /tmp/v.log 2>&1; echo exit $?; grep GREEN /tmp/v.log | tail -15', false],
    ['bash scripts/verify.sh > /tmp/v.log 2>&1', false],
    ['npx tsc --noEmit > /dev/null 2>&1', true],
    ['npx tsc --noEmit && echo done', false],
  ];
  for (const [cmd, ok] of cases) {
    test(`${ok ? 'silent ok' : 'not silent ok'}: ${cmd}`, () => {
      assert.equal(classifyRun(cmd).silentOk, ok, JSON.stringify(classifyRun(cmd)));
    });
  }
});

describe('classifyRun: targets', () => {
  test('paths and -k stems, config values excluded, parens stripped', () => {
    assert.deepEqual(classifyRun('uv run pytest -k lof -x tests/test_lof.py').targets, ['lof', 'tests/test_lof.py']);
    assert.deepEqual(classifyRun('cd ~/x && (uvx ruff@latest format --check --config pkg/pyproject.toml pkg/tests/test_lof.py; uvx ruff@latest check --config pkg/pyproject.toml pkg/tests/test_lof.py) 2>&1').targets, ['pkg/tests/test_lof.py']);
    assert.deepEqual(classifyRun('npx vitest run src/lib/__tests__/a.test.ts src/app/api/__tests__/b.test.ts 2>&1').targets, ['src/lib/__tests__/a.test.ts', 'src/app/api/__tests__/b.test.ts']);
    assert.deepEqual(classifyRun('npx vitest run src/lib/scraping 2>&1 | tail -6').targets, ['src/lib/scraping']);
    assert.deepEqual(classifyRun('pytest tests/test_x.py::test_one').targets, ['tests/test_x.py']);
    assert.deepEqual(classifyRun('python3 scripts/check.py --fast data/in.csv').targets, ['scripts/check.py', 'data/in.csv']);
    assert.deepEqual(classifyRun('go test ./... -run TestFoo').targets, ['TestFoo']);
    assert.deepEqual(classifyRun('bash -c "cd app && npx jest src/a.test.ts"').targets, ['src/a.test.ts']);
  });
  test('whole-project runs have no targets', () => {
    assert.deepEqual(classifyRun('npx tsc --noEmit').targets, []);
    assert.deepEqual(classifyRun('make test').targets, []);
    assert.deepEqual(classifyRun('npm run lint -- --max-warnings 0').targets, []);
    assert.deepEqual(classifyRun('cargo test').targets, []);
    assert.deepEqual(classifyRun('pnpm exec tsc --noEmit -p tsconfig.json').targets, []);
  });
});

describe('classifyRun: package scripts and make targets', () => {
  const ctx = { packageScripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', verify: 'bash scripts/verify.sh', dev: 'next dev', 'test:unit': 'node --test dist-test/' } };
  test('npm scripts resolve to the underlying runner', () => {
    assert.equal(classifyRun('npm test', ctx).runner, 'vitest');
    assert.equal(classifyRun('npm run test -- src/a.test.ts', ctx).runner, 'vitest');
    assert.deepEqual(classifyRun('npm run test -- src/a.test.ts', ctx).targets, ['src/a.test.ts']);
    assert.equal(classifyRun('pnpm lint', ctx).runner, 'eslint');
    assert.equal(classifyRun('yarn typecheck', ctx).runner, 'tsc');
    assert.equal(classifyRun('bun run test:unit', ctx).runner, 'node:test');
    assert.equal(classifyRun('npm run verify', ctx).runner, 'script');
  });
  test('unknown or dev scripts are not runs; known script words fall back to npm', () => {
    assert.equal(classifyRun('npm run dev', ctx).isRun, false);
    assert.equal(classifyRun('npm run deploy', ctx).isRun, false);
    assert.equal(classifyRun('npm run build').runner, 'npm');
    assert.equal(classifyRun('npm run build', { packageScripts: { build: 'next build' } }).runner, 'npm');
  });
});

// ---------------------------------------------------------------------------
// parseOutcome: samples taken from local transcripts (paths and names replaced)
// ---------------------------------------------------------------------------
describe('parseOutcome: pytest', () => {
  test('pass with warnings', () => {
    const out = '    warnings.warn(\n\n-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html\n18 passed, 1 warning in 4.39s';
    assert.deepEqual(parse('pytest', out), { outcome: 'pass', summary: 'pytest: 18 passed, 1 warning' });
  });
  test('fail with -x stop', () => {
    const out = '=========================== short test summary info ============================\nFAILED test_lof.py::test_nof_matches_sklearn[5-float32]\n!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!!\n1 failed in 2.46s';
    assert.equal(parse('pytest', out, '', true).outcome, 'fail');
  });
  test('mixed failed/passed is fail', () => {
    const out = 'FAILED test_lof.py::test_mode_guards\n1 failed, 17 passed, 2 warnings in 4.13s';
    const r = parse('pytest', out);
    assert.equal(r.outcome, 'fail');
    assert.equal(r.summary, 'pytest: 1 failed, 17 passed, 2 warnings');
  });
  test('deselected and skipped pass', () => {
    const out = '............................                                             [100%]\n109 passed, 2 skipped, 2242 deselected, 6 warnings in 10.33s';
    assert.equal(parse('pytest', out).outcome, 'pass');
  });
  test('verbose banner form', () => {
    const out = '============================== 28 passed in 8.23s ==============================';
    assert.deepEqual(parse('pytest', out), { outcome: 'pass', summary: 'pytest: 28 passed' });
  });
  test('collection error (conftest import) is fail', () => {
    const out = "ImportError while loading conftest '/repo/python/tests/conftest.py'.\nconftest.py:15: in <module>\nE   ModuleNotFoundError: No module named 'pynvml'";
    assert.equal(parse('pytest', out).outcome, 'fail');
  });
  test('errors during collection count as fail', () => {
    assert.equal(parse('pytest', '=========== 2 errors in 0.40s ===========').outcome, 'fail');
  });
  test('no tests ran is unparsed', () => {
    assert.equal(parse('pytest', '============================ no tests ran in 0.01s =============================').outcome, 'unparsed');
  });
});

describe('parseOutcome: unittest', () => {
  test('OK', () => {
    const out = '----------------------------------------------------------------------\nRan 14 tests in 0.703s\n\nOK';
    assert.deepEqual(parse('unittest', out), { outcome: 'pass', summary: 'unittest: ran 14, OK' });
  });
  test('FAILED', () => {
    const out = 'Ran 14 tests in 0.703s\n\nFAILED (failures=1, errors=2)';
    assert.equal(parse('unittest', out, '', true).outcome, 'fail');
  });
});

describe('parseOutcome: vitest', () => {
  test('ANSI-coloured pass line', () => {
    const out = 'ok\n\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m339 passed\x1b[39m\x1b[22m\x1b[90m (339)\x1b[39m\nGREEN-GATE PASSED - safe to commit and open a PR.\n';
    assert.deepEqual(parse('vitest', out), { outcome: 'pass', summary: 'vitest: Tests 339 passed (339)' });
  });
  test('all files failed to load, no tests', () => {
    const out = ' ❯ lib/llm/model-mention.ts:9:1\n ❯ tests/model-mention.test.ts:2:1\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯\n\n\n Test Files  3 failed (3)\n      Tests  no tests\n   Start at  12:08:29\n   Duration  6.44s (transform 3.54s, setup 0ms, import 0ms, tests 0ms, environment 1ms)\n\nShell cwd was reset to /repo';
    const r = parse('vitest', out, '', true);
    assert.equal(r.outcome, 'fail');
    assert.match(r.summary, /Test Files 3 failed/);
  });
  test('one file failed while tests pass is fail', () => {
    const out = ' FAIL  tests/council.test.ts [ tests/council.test.ts ]\nError: SOME_KEY is required\n Test Files  1 failed | 2 passed (3)\n      Tests  41 passed (41)\n   Start at  12:09:15\n';
    assert.equal(parse('vitest', out).outcome, 'fail');
  });
  test('full pass block', () => {
    const out = ' RUN  v4.0.18 /repo\n\n ✓ src/app/api/__tests__/mcp.test.ts (6 tests) 150ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Start at  09:35:12\n   Duration  959ms (transform 120ms, setup 0ms, import 500ms, tests 150ms, environment 0ms)\n\n';
    assert.deepEqual(parse('vitest', out), { outcome: 'pass', summary: 'vitest: Tests 6 passed (6); Test Files 1 passed (1)' });
  });
  test('failed tests block filtered by grep', () => {
    const out = "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\nAssertionError: get_balance: expected 'undefined' to be 'boolean' // Object.is equality\n      Tests  1 failed | 5 passed (6)\n";
    assert.deepEqual(parse('vitest', out), { outcome: 'fail', summary: 'vitest: Tests 1 failed | 5 passed (6)' });
  });
  test('summary filtered out entirely, assertion remains: generic fail', () => {
    const out = "AssertionError: expected [] to deeply equal [ 'someone@example.invalid' ]";
    assert.equal(parse('vitest', out).outcome, 'fail');
  });
});

describe('parseOutcome: node --test', () => {
  test('TAP summary with failures', () => {
    const out = "ok 9 - alias : resolve\n  ---\n  duration_ms: 3.9068\n  type: 'test'\n  ...\n1..9\n# tests 9\n# suites 0\n# pass 6\n# fail 3\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 976.314704\n";
    assert.deepEqual(parse('node:test', out, '', true), { outcome: 'fail', summary: 'node --test: pass 6, fail 3' });
  });
  test('TAP summary pass', () => {
    assert.deepEqual(parse('node:test', 'ok 14 - revue : refus\n# pass 14\n# fail 0\n'), { outcome: 'pass', summary: 'node --test: pass 14, fail 0' });
  });
  test('spec reporter (ℹ) pass through npm test', () => {
    const out = 'exit=0\nℹ pass 352\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 23782.674219';
    assert.deepEqual(parse('npm', out), { outcome: 'pass', summary: 'node --test: pass 352, fail 0' });
  });
  test('not ok with connection error', () => {
    const out = "not ok 1 - Postgres : claim, holder lines et revocation\n  error: 'connect ECONNREFUSED 127.0.0.1:55432'\n# pass 0\n# fail 1\n#\n";
    assert.equal(parse('node:test', out, '', true).outcome, 'fail');
  });
  test('grep-filtered not ok lines only', () => {
    assert.deepEqual(parse('node:test', 'not ok 2 - alias : missing\n'), { outcome: 'fail', summary: 'node --test: not ok' });
  });
  test('tail-truncated output: fail 0 kept, pass line cut', () => {
    // `npm test 2>&1 | tail -5` keeps the last lines only; the pass count is
    // unknown, not zero
    const out = 'ℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 4521.1\n';
    assert.deepEqual(parse('node:test', out), { outcome: 'pass', summary: 'node --test: pass count not in output, fail 0' });
  });
});

describe('parseOutcome: go', () => {
  test('ok packages with no test files', () => {
    const out = '?   \tapp/cmd/docs\t[no test files]\nok  \tapp/cmd/generators\t0.021s\n?   \tapp/cmd/server\t[no test files]\n';
    assert.deepEqual(parse('go', out), { outcome: 'pass', summary: 'go: ok (1 package)' });
  });
  test('verbose PASS', () => {
    const out = '--- PASS: TestLiveList (1.99s)\n=== RUN   TestRawToFloat\n--- PASS: TestRawToFloat (0.00s)\nPASS\nok  \tapp/internal/clients/chain\t3.445s\n';
    assert.equal(parse('go', out).outcome, 'pass');
  });
  test('FAIL', () => {
    const out = '--- FAIL: TestX (0.00s)\n    x_test.go:12: want 1 got 2\nFAIL\nFAIL\tapp/pkg\t0.012s\n';
    assert.deepEqual(parse('go', out, '', true), { outcome: 'fail', summary: 'go: FAIL TestX' });
  });
  test('build error', () => {
    assert.equal(parse('go', '# app/pkg\n./x.go:12:3: undefined: foo\n', '', true).outcome, 'fail');
  });
  test('silent go vet is pass', () => {
    assert.deepEqual(parse('go', '', ''), { outcome: 'pass', summary: 'go: no output, exit ok' });
  });
});

describe('parseOutcome: tsc', () => {
  test('error TS lines', () => {
    const out = "src/components/app/saved-view.tsx(144,65): error TS2352: Conversion of type 'Record<string, unknown>' to type 'Filters' may be a mistake.\nsrc/db/integration.test.ts(91,11): error TS2451: Cannot redeclare block-scoped variable 'relu'.\n";
    assert.deepEqual(parse('tsc', out, '', true), { outcome: 'fail', summary: 'tsc: 2 errors (error TS)' });
  });
  test('pretty Found N errors with TS codes', () => {
    const out = "src/agent.ts(264,1): error TS1128: Declaration or statement expected.\nexit=1\n\nFound 1 error in src/agent.ts:264\n";
    assert.deepEqual(parse('tsc', out), { outcome: 'fail', summary: 'tsc: 1 error (error TS)' });
  });
  test('silence is pass', () => {
    assert.deepEqual(parse('tsc', '', ''), { outcome: 'pass', summary: 'tsc: no output, exit ok' });
  });
  test('other segments output without error TS stays unparsed', () => {
    assert.equal(parse('tsc', 'auth-helpers.test.ts\nllm.test.ts\n').outcome, 'unparsed');
  });
});

describe('parseOutcome: eslint', () => {
  test('warnings only pass', () => {
    const out = '  1436:66  warning  Expected an assignment or function call and instead saw an expression  @typescript-eslint/no-unused-expressions\n\n✖ 2 problems (0 errors, 2 warnings)\n\nShell cwd was reset to /repo\n\n';
    assert.deepEqual(parse('eslint', out), { outcome: 'pass', summary: 'eslint: 2 problems (0 errors, 2 warnings)' });
  });
  test('errors fail', () => {
    const out = "  79:5  error  Error: Calling setState synchronously within an effect can trigger cascading renders\n✖ 16 problems (1 error, 15 warnings)\n  0 errors and 1 warning potentially fixable with the `--fix` option.\n";
    assert.deepEqual(parse('eslint', out, '', true), { outcome: 'fail', summary: 'eslint: 16 problems (1 error, 15 warnings)' });
  });
  test('empty is pass', () => {
    assert.equal(parse('eslint', '').outcome, 'pass');
  });
});

describe('parseOutcome: ruff', () => {
  test('Found 1 error', () => {
    const out = '16 |\n   |\n\nFound 1 error.\n[*] 1 fixable with the `--fix` option.\n';
    assert.deepEqual(parse('ruff', out, '', true), { outcome: 'fail', summary: 'ruff: Found 1 error' });
  });
  test('All checks passed', () => {
    assert.deepEqual(parse('ruff', 'Installed 1 package in 37ms\nAll checks passed!\n'), { outcome: 'pass', summary: 'ruff: All checks passed!' });
  });
  test('format --check would reformat is fail, even after a check pass', () => {
    const out = 'All checks passed!\nWould reformat: pkg/tests/test_lof.py\n1 file would be reformatted\n';
    assert.equal(parse('ruff', out, '', true).outcome, 'fail');
  });
  test('Found N errors does not trigger tsc', () => {
    const r = parse('ruff', 'Found 1 error.\n');
    assert.equal(r.summary, 'ruff: Found 1 error');
  });
});

describe('parseOutcome: jest / mocha / cargo / mypy / pyright / prettier (synthetic)', () => {
  test('jest', () => {
    assert.equal(parse('jest', 'Test Suites: 1 passed, 1 total\nTests:       3 passed, 3 total\nSnapshots:   0 total\nTime:        1.2 s').outcome, 'pass');
    assert.equal(parse('jest', 'Tests:       1 failed, 2 passed, 3 total', '', true).outcome, 'fail');
    assert.equal(parse('jest', 'Test Suites: 1 failed, 1 total\nTests:       0 total', '', true).outcome, 'fail');
  });
  test('mocha', () => {
    assert.deepEqual(parse('mocha', '  5 passing (120ms)\n'), { outcome: 'pass', summary: 'mocha: 5 passing, 0 failing' });
    assert.equal(parse('mocha', '  5 passing (120ms)\n  1 failing\n', '', true).outcome, 'fail');
  });
  test('cargo', () => {
    assert.equal(parse('cargo', 'test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s').outcome, 'pass');
    assert.equal(parse('cargo', 'test result: FAILED. 11 passed; 1 failed; 0 ignored', '', true).outcome, 'fail');
    assert.equal(parse('cargo', 'error[E0308]: mismatched types\n --> src/main.rs:2:5', '', true).outcome, 'fail');
    assert.equal(parse('cargo', '    Checking core v0.1.0\n    Finished dev [unoptimized] target(s) in 0.5s').outcome, 'pass');
  });
  test('mypy', () => {
    assert.equal(parse('mypy', 'Success: no issues found in 12 source files').outcome, 'pass');
    assert.equal(parse('mypy', 'Found 3 errors in 2 files (checked 12 source files)', '', true).outcome, 'fail');
  });
  test('pyright', () => {
    assert.equal(parse('pyright', '0 errors, 2 warnings, 0 informations ').outcome, 'pass');
    assert.equal(parse('pyright', '3 errors, 0 warnings, 0 informations', '', true).outcome, 'fail');
  });
  test('prettier --check', () => {
    assert.equal(parse('prettier', 'Checking formatting...\nAll matched files use Prettier code style!').outcome, 'pass');
    assert.equal(parse('prettier', 'Checking formatting...\n[warn] src/a.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.', '', true).outcome, 'fail');
  });
});

describe('parseOutcome: npm scripts, make and generic fall-through', () => {
  test('next build through npm run build', () => {
    const out = '> app@1.0.0 build\n> next build\n\n   ▲ Next.js 15.1.6\n\n   Creating an optimized production build ...\n ✓ Compiled successfully\n   Skipping linting\n   Checking validity of types ...\n   Collecting page data ...';
    assert.deepEqual(parse('npm', out), { outcome: 'pass', summary: 'next build: compiled successfully' });
  });
  test('nested runner summary in a shell script wrapper', () => {
    const out = 'rc=0\n Test Files  27 passed (27)\n      Tests  226 passed (226)\n ✓ Compiled successfully\n';
    const r = parse('script', out);
    assert.equal(r.outcome, 'pass');
    assert.match(r.summary, /vitest: Tests 226 passed/);
  });
  test('error string result (merged output) is fail with the first error line', () => {
    const out = "Error: Exit code 1\nnode:internal/modules/cjs/loader:1433\n  throw err;\n  ^\n\nError: Cannot find module '@/lib/prisma'\nRequire stack:\n- /app/dist/lib/email/resend.js";
    const r = parse('node', out, '', true);
    assert.equal(r.outcome, 'fail');
    assert.equal(r.summary, "exit code 1: Error: Cannot find module '@/lib/prisma'");
  });
  test('python traceback is fail', () => {
    const out = 'Traceback (most recent call last):\n  File "/repo/outreach/inbox.py", line 43, in <module>\n    main()\n  File "/repo/outreach/inbox.py", line 30, in main\nKeyError: \'x\'';
    assert.equal(parse('python', out).outcome, 'fail');
    assert.equal(parse('python', 'Error: Exit code 1\n' + out, '', true).summary, 'exit code 1: Traceback (most recent call last):');
  });
  test('plain script output is unparsed', () => {
    assert.deepEqual(parse('python', 'list_credit_packs - {\'readOnlyHint\': True}\n{"balance":5}'), { outcome: 'unparsed', summary: null });
  });
  test('no output for make/npm is unparsed, not pass', () => {
    assert.deepEqual(parse('make', ''), { outcome: 'unparsed', summary: 'no output' });
    assert.deepEqual(parse('npm', ''), { outcome: 'unparsed', summary: 'no output' });
  });
  test('isError with no output is fail', () => {
    assert.equal(parse('make', 'Error: Exit code 2', '', true).outcome, 'fail');
    assert.equal(parse('script', '', '', true).outcome, 'fail');
  });
  test('silent pass is off when the caller says the exit code is not the runner\'s', () => {
    const r = parseOutcome('script', '', '', false, { silentPass: false });
    produced.push(r.summary);
    assert.equal(r.outcome, 'unparsed');
    assert.match(r.summary, /no runner output captured/);
    assert.equal(parseOutcome('script', '', '', true, { silentPass: false }).outcome, 'fail', 'an error exit still fails');
    assert.equal(parseOutcome('script', 'GREEN-GATE PASSED\n', '', false, { silentPass: false }).outcome, 'unparsed', 'real output is still read normally');
    assert.equal(parseOutcome('pytest', '3 passed in 0.1s', '', false, { silentPass: false }).outcome, 'pass');
  });
  test('FAILED line from a custom script is fail', () => {
    assert.equal(parse('script', 'FAIL inscription :: TimeoutError: page.goto: Timeout 30000ms exceeded.').outcome, 'fail');
  });
  test('parsed pass with a non-zero exit from a later segment keeps the runner verdict', () => {
    const r = parse('vitest', '      Tests  6 passed (6)\nssh: connect to host example.invalid port 22: Connection refused', '', true);
    assert.equal(r.outcome, 'pass');
    assert.match(r.summary, /command exited with an error/);
  });
  test('stderr is read as well as stdout', () => {
    assert.equal(parse('pytest', '', '2 failed in 0.3s', true).outcome, 'fail');
  });
});

// ---------------------------------------------------------------------------
// extractRuns / runsForHunk / hunkStatus
// ---------------------------------------------------------------------------
function ev(ts, command, result, extra = {}) {
  return { type: 'tool', ts, sessionId: 's1', toolUseId: `tu-${ts}`, tool: { name: 'Bash', input: { command }, result }, ...extra };
}

describe('extractRuns', () => {
  const events = [
    ev('2026-10-14T10:00:05.000Z', 'npx tsc --noEmit', { stdout: '', stderr: '', isError: false }),
    ev('2026-10-14T10:00:01.000Z', 'npx vitest run src/a.test.ts 2>&1 | tail -5', { stdout: '      Tests  6 passed (6)\n', stderr: '', isError: false }),
    ev('2026-10-14T10:00:02.000Z', 'grep -rn foo src', { stdout: 'src/a.ts:1:foo', stderr: '', isError: false }),
    ev('2026-10-14T10:00:03.000Z', 'node --test test/', 'Error: Exit code 1\nnot ok 1 - a\n# pass 0\n# fail 1\n'),
    ev('2026-10-14T10:00:04.000Z', 'pytest tests/', null),
    ev('2026-10-14T10:00:06.000Z', 'python3 - <<\'EOF\'\np="a.py"; s=open(p).read(); open(p,"w").write(s)\nEOF\npytest', { stdout: '3 passed in 0.1s', stderr: '', isError: false }),
    ev('2026-10-14T10:00:07.000Z', 'npx tsc --build tsconfig.test.json && node --test dist-test/', { stdout: '# pass 3\n# fail 0', stderr: '', isError: false, bashEditDiff: { files: [{ filePath: '/repo/dist-test/a.js', hunks: [] }], moreFiles: 0 } }),
    ev('2026-10-14T10:00:08.000Z', 'npm test > /tmp/log 2>&1; tail -3 /tmp/log', { stdout: '# pass 9\n# fail 0', stderr: '', isError: false, bashEditDiff: { files: [], moreFiles: 0 } }),
    { type: 'tool', ts: '2026-10-14T10:00:09.000Z', sessionId: 's1', toolUseId: 'x', tool: { name: 'Read', input: { file_path: '/repo/a.ts' }, result: null } },
    { type: 'edit', ts: '2026-10-14T10:00:10.000Z', sessionId: 's1', edit: { tool: 'Edit', file: '/repo/a.ts' } },
  ];
  const runs = extractRuns(events, { repoRoot: '/repo' });
  test('keeps only runner commands, sorted by ts', () => {
    assert.deepEqual(runs.map((r) => r.runner), ['vitest', 'node:test', 'pytest', 'tsc', 'npm']);
    assert.deepEqual(runs.map((r) => r.ts), ['2026-10-14T10:00:01.000Z', '2026-10-14T10:00:03.000Z', '2026-10-14T10:00:04.000Z', '2026-10-14T10:00:05.000Z', '2026-10-14T10:00:08.000Z']);
  });
  test('string error results are parsed as merged output with isError', () => {
    const r = runs[1];
    assert.equal(r.isError, true);
    assert.equal(r.outcome, 'fail');
    assert.equal(r.summary, 'node --test: pass 0, fail 1');
    assert.equal(r.toolUseId, 'tu-2026-10-14T10:00:03.000Z');
  });
  test('missing result is unparsed', () => {
    assert.equal(runs[2].outcome, 'unparsed');
    assert.equal(runs[2].summary, 'no result recorded');
    assert.deepEqual(runs[2].targets, ['tests/']);
  });
  test('silent tsc is pass', () => {
    assert.equal(runs[3].outcome, 'pass');
  });
  test('bashEditDiff with files inside the repo excludes the command; empty files list does not', () => {
    assert.ok(!runs.some((r) => r.command.startsWith('npx tsc --build')));
    assert.equal(runs[4].command, 'npm test > /tmp/log 2>&1; tail -3 /tmp/log');
  });
  test('bashEditDiff files the command does not name do not turn a run into an edit', () => {
    // a concurrent agent's Write landed while `npm test` ran
    const list = extractRuns([
      ev('2026-10-14T10:35:00.000Z', 'npm test 2>&1 | tail -3', { stdout: '# pass 9\n# fail 0', stderr: '', isError: false, bashEditDiff: { files: [{ filePath: '/repo/src/other.js', hunks: [] }], moreFiles: 0 } }, { cwd: '/repo' }),
      ev('2026-10-14T10:36:00.000Z', 'node --test test/a.test.js', { stdout: '# pass 1\n# fail 0', stderr: '', isError: false, bashEditDiff: { files: [{ filePath: '/repo/test/a.test.js', hunks: [] }], moreFiles: 0 } }, { cwd: '/repo' }),
      ev('2026-10-14T10:37:00.000Z', 'cd /repo && bash scripts/verify.sh | tail -3', { stdout: 'GREEN', stderr: '', isError: false, bashEditDiff: { files: [{ filePath: '/repo/README.md', hunks: [] }], moreFiles: 0 } }, { cwd: '/elsewhere' }),
    ], { repoRoot: '/repo' });
    assert.deepEqual(list.map((r) => r.ts.slice(11, 16)), ['10:35', '10:37']);
  });
  test('a command moved to the background is unparsed whatever its stdout', () => {
    const list = extractRuns([
      ev('2026-10-14T15:00:12.000Z', 'bash scripts/verify.sh > /tmp/verify.log 2>&1; echo exit $?; grep GREEN /tmp/verify.log | tail -15', { stdout: '', stderr: '', isError: false, backgroundTaskId: 'bdby3u41x', timedOutAfterMs: 600000 }),
      ev('2026-10-14T15:01:28.000Z', 'npx tsc --noEmit', { stdout: '', stderr: '', isError: false, backgroundTaskId: 'bvgza2pu9' }),
    ], { repoRoot: '/repo' });
    assert.equal(list.length, 2);
    for (const r of list) {
      assert.equal(r.outcome, 'unparsed');
      assert.equal(r.summary, 'moved to background, output not captured');
      produced.push(r.summary);
    }
  });
  test('empty stdout after a redirect or a trailing echo is unparsed, not pass', () => {
    const list = extractRuns([
      ev('2026-10-14T15:00:12.000Z', 'bash scripts/verify.sh > /tmp/verify.log 2>&1; echo exit $?; grep GREEN /tmp/verify.log | tail -15', { stdout: '', stderr: '', isError: false }),
      ev('2026-10-14T15:00:13.000Z', 'bash scripts/verify.sh', { stdout: '', stderr: '', isError: false }),
    ], { repoRoot: '/repo' });
    assert.equal(list[0].outcome, 'unparsed');
    assert.equal(list[1].outcome, 'pass');
    produced.push(list[0].summary, list[1].summary);
  });
  test('ev.checkout is copied onto the run', () => {
    const list = extractRuns([ev('2026-10-14T10:00:00.000Z', 'npm test', { stdout: '# pass 1\n# fail 0', stderr: '', isError: false }, { checkout: '/repo' })]);
    assert.equal(list[0].checkout, '/repo');
    assert.equal('checkout' in extractRuns([ev('2026-10-14T10:00:00.000Z', 'npm test', { stdout: '# pass 1\n# fail 0', stderr: '', isError: false })])[0], false);
  });
  test('Run shape matches the contract', () => {
    for (const r of runs) {
      assert.deepEqual(Object.keys(r).sort(), ['command', 'isError', 'outcome', 'runner', 'sessionId', 'summary', 'targets', 'toolUseId', 'ts']);
      assert.ok(['pass', 'fail', 'unparsed'].includes(r.outcome));
    }
  });
  test('accepts events already typed run and ignores empty input', () => {
    assert.equal(extractRuns([{ ...ev('2026-10-14T10:00:00.000Z', 'pytest', { stdout: '1 passed in 0.1s', stderr: '', isError: false }), type: 'run' }]).length, 1);
    assert.deepEqual(extractRuns([]), []);
    assert.deepEqual(extractRuns(null), []);
  });
});

describe('runsForHunk and targeted', () => {
  const hunk = { id: 'src/lib/scraping/email-extract.ts:10', file: '/repo/src/lib/scraping/email-extract.ts', relFile: 'src/lib/scraping/email-extract.ts', attribution: 'MATCHED', lastEdit: '2026-10-14T10:00:05.000Z' };
  const run = (ts, command, outcome = 'pass') => ({ ts, sessionId: 's1', toolUseId: ts, command, runner: classifyRun(command).runner, outcome, summary: null, isError: false, targets: classifyRun(command).targets });
  const runs = [
    run('2026-10-14T10:00:01.000Z', 'npx vitest run'),
    run('2026-10-14T10:00:05.000Z', 'npx vitest run'),
    run('2026-10-14T10:00:06.000Z', 'npx vitest run src/lib/scraping/__tests__/email-extract.test.ts'),
    run('2026-10-14T10:00:07.000Z', 'npx vitest run src/lib/scraping'),
    run('2026-10-14T10:00:08.000Z', 'npx vitest run src/app/api/__tests__/mcp.test.ts', 'fail'),
    run('2026-10-14T10:00:09.000Z', 'npx tsc --noEmit'),
    run('2026-10-14T10:00:10.000Z', 'pytest -k email_extract'),
    run('2026-10-14T10:00:11.000Z', 'pytest -k lof'),
    run('2026-10-14T10:00:12.000Z', 'node /repo/src/lib/scraping/email-extract.ts'),
  ];
  test('only runs strictly after lastEdit, with targeted flags', () => {
    const after = runsForHunk(hunk, runs);
    assert.deepEqual(after.map((r) => r.ts.slice(-7, -5)), ['06', '07', '08', '09', '10', '11', '12']);
    assert.deepEqual(after.map((r) => r.targeted), [true, true, false, true, true, false, true]);
  });
  test('does not mutate the input runs', () => {
    runsForHunk(hunk, runs);
    assert.equal('targeted' in runs[2], false);
  });
  test('no lastEdit means no runs after', () => {
    assert.deepEqual(runsForHunk({ ...hunk, lastEdit: null }, runs), []);
    assert.deepEqual(runsForHunk(null, runs), []);
  });
  test('a run in another checkout than the edit is kept, untargeted, flagged, and never decides', () => {
    const wt = '/repo/.claude/worktrees/feat';
    const h = { ...hunk, checkout: wt };
    const list = [
      { ...run('2026-10-14T10:00:06.000Z', 'npm test'), checkout: '/repo' },
      { ...run('2026-10-14T10:00:07.000Z', 'npm test'), checkout: wt },
      { ...run('2026-10-14T10:00:08.000Z', 'npm test', 'fail'), checkout: '/repo' },
    ];
    const after = runsForHunk(h, list);
    assert.deepEqual(after.map((r) => [r.targeted, r.otherCheckout === true]), [[false, true], [true, false], [false, true]]);
    assert.equal(decidingRun(after), after[1], 'the same-checkout run decides, not the later other-checkout failure');
    assert.equal(hunkStatus(h, after), 'RUN_PASS');
    const onlyOther = runsForHunk(h, [list[0], list[2]]);
    assert.equal(hunkStatus(h, onlyOther), 'RUN_UNPARSED', 'other-checkout runs alone never give pass/fail');
    assert.equal(decidingRun(onlyOther), onlyOther[1]);
    // all unparsed: the last same-checkout run is shown rather than a later one made elsewhere
    const mixed = runsForHunk(h, [
      { ...run('2026-10-14T10:00:06.000Z', 'bash scripts/verify.sh | tail -3', 'unparsed'), checkout: wt },
      { ...run('2026-10-14T10:00:09.000Z', 'node scripts/x.js', 'unparsed'), checkout: '/repo' },
    ]);
    assert.equal(decidingRun(mixed), mixed[0]);
    assert.equal(hunkStatus(h, mixed), 'RUN_UNPARSED');
    // without checkout information nothing changes
    const plain = runsForHunk(hunk, list);
    assert.ok(plain.every((r) => r.otherCheckout === undefined));
    assert.equal(hunkStatus(hunk, plain), 'RUN_FAIL');
  });
  test('isTargeted matches file, stem, parent dir, whole project', () => {
    const h = { file: '/repo/pkg/tests/test_lof.py', relFile: 'pkg/tests/test_lof.py' };
    assert.equal(isTargeted(h, { targets: [] }), true);
    assert.equal(isTargeted(h, { targets: ['pkg/tests/test_lof.py'] }), true);
    assert.equal(isTargeted(h, { targets: ['tests/test_lof.py'] }), true);
    assert.equal(isTargeted(h, { targets: ['pkg/tests'] }), true);
    assert.equal(isTargeted(h, { targets: ['pkg/'] }), true);
    assert.equal(isTargeted(h, { targets: ['lof'] }), true);
    assert.equal(isTargeted(h, { targets: ['/repo/pkg'] }), true);
    assert.equal(isTargeted(h, { targets: ['pkg/other/test_x.py'] }), false);
    assert.equal(isTargeted(h, { targets: ['other'] }), false);
    assert.equal(isTargeted({ file: '/repo/src/lof.py', relFile: 'src/lof.py' }, { targets: ['tests/test_lof.py'] }), true);
  });
});

describe('hunkStatus', () => {
  const base = { attribution: 'MATCHED', lastEdit: '2026-10-14T10:00:00.000Z' };
  test('UNATTRIBUTED wins over runs', () => {
    assert.equal(hunkStatus({ ...base, attribution: 'UNATTRIBUTED' }, [{ outcome: 'pass' }]), 'UNATTRIBUTED');
  });
  test('UNRUN when nothing ran after the last edit', () => {
    assert.equal(hunkStatus(base, []), 'UNRUN');
    assert.equal(hunkStatus(base, null), 'UNRUN');
    assert.equal(hunkStatus({ ...base, attribution: 'FILE_LEVEL' }, []), 'UNRUN');
  });
  test('status follows the LAST parsed run after lastEdit', () => {
    assert.equal(hunkStatus(base, [{ outcome: 'fail' }, { outcome: 'pass' }]), 'RUN_PASS');
    assert.equal(hunkStatus(base, [{ outcome: 'pass' }, { outcome: 'fail' }]), 'RUN_FAIL');
    assert.equal(hunkStatus(base, [{ outcome: 'pass' }, { outcome: 'unparsed' }]), 'RUN_PASS', 'an unparsed run does not hide a parsed one');
    assert.equal(hunkStatus(base, [{ outcome: 'unparsed' }, { outcome: 'unparsed' }]), 'RUN_UNPARSED');
  });
  test('targeted parsed runs win over untargeted ones', () => {
    const runs = [
      { outcome: 'pass', targeted: true },
      { outcome: 'fail', targeted: false }, // a failing run of another file
    ];
    assert.equal(hunkStatus(base, runs), 'RUN_PASS');
    assert.equal(decidingRun(runs), runs[0]);
    assert.equal(hunkStatus(base, [{ outcome: 'pass', targeted: false }, { outcome: 'fail', targeted: false }]), 'RUN_FAIL');
    assert.equal(hunkStatus(base, [{ outcome: 'fail', targeted: true }, { outcome: 'pass', targeted: true }, { outcome: 'unparsed', targeted: true }]), 'RUN_PASS');
    assert.equal(decidingRun([]), null);
    assert.equal(decidingRun(null), null);
  });
});

describe('vocabulary rule', () => {
  test('no summary produced in this file contains the forbidden words', () => {
    assert.ok(produced.length > 40);
    for (const s of produced) assert.doesNotMatch(s, FORBIDDEN, s);
  });
});
