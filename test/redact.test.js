import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksHighEntropy, redact, redactHomePaths } from '../src/redact.js';

const HOME = '/home/alice';
const r = (s) => redact(s, { home: HOME });

// Every string is synthetic. [label, input, sensitive substring that must disappear]
const SECRETS = [
  ['openai-style key', 'OPENAI_API_KEY=sk-Zx9Qp3Lm7Vn2Rt8Ws4Kd6Hf1Jg5Bc0YaT2Uv', 'Zx9Qp3Lm7Vn2Rt8Ws4Kd6Hf1Jg5Bc0YaT2Uv'],
  ['anthropic key', 'export ANTHROPIC_API_KEY=sk-ant-api03-Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Zx9Cv8Bn7Mm6-AbCdEfGhIjKl', 'Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Zx9Cv8Bn7Mm6'],
  ['project key', 'key: sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'],
  ['github pat classic', 'GH_TOKEN=ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0UvWxYz', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0UvWxYz'],
  ['github oauth', 'gho_Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa', 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa'],
  ['github fine-grained pat', 'github_pat_11ABCDEFG0abcdefghijkl_Mn3Op4Qr5St6Uv7Wx8Yz9Ab0Cd1Ef2Gh3Ij4Kl5Mn6Op7Qr8St9Uv0Wx1Yz2', 'Mn3Op4Qr5St6Uv7Wx8Yz9Ab0Cd1Ef2Gh3Ij4Kl5Mn6Op7Qr8St9Uv0Wx1Yz2'],
  ['aws access key id', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['aws temporary key id', 'AWS_ACCESS_KEY_ID=ASIAQWERTYUIOPASDFGH', 'ASIAQWERTYUIOPASDFGH'],
  ['slack bot token', 'SLACK_BOT_TOKEN=xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', 'AbCdEfGhIjKlMnOpQrStUvWx'],
  ['slack user token', 'xoxp-987654321098-8765432109876-7654321098765-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'],
  ['bearer header', 'curl -H "Authorization: Bearer abcDEF123.ghiJKL456-mnoPQR" https://api.example.com', 'abcDEF123.ghiJKL456-mnoPQR'],
  ['basic auth header', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
  ['rsa private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAwJ1x\nY2F0ZmlzaA==\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAwJ1x'],
  ['openssh private key block', 'cat > key <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----\nEOF', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'],
  ['ec private key, no end marker', 'echo "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIBx7secretbytesHERE1234567890', 'MHQCAQEEIBx7secretbytesHERE1234567890'],
  ['jwt', 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
  ['jwt, two parts', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbm9ueW1vdXMifQ', 'eyJzdWIiOiJhbm9ueW1vdXMifQ'],
  ['40-hex secret', 'GITHUB_WEBHOOK_SECRET=a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'],
  ['64-hex secret', 'HMAC_KEY=2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae'],
  ['32-hex secret', 'api_secret: 9e107d9d372bb6826bd81d3542a419d6', '9e107d9d372bb6826bd81d3542a419d6'],
  ['32-char base64 token', 'SESSION_SECRET=Zx9Qp3Lm7Vn2Rt8Ws4Kd6Hf1Jg5Bc0Ya', 'Zx9Qp3Lm7Vn2Rt8Ws4Kd6Hf1Jg5Bc0Ya'],
  ['padded base64 token', 'secret: k7+Jq2Zp9Xw3Rt5Vb8Nm1Lc4Hd6Fg0Ys2QaPe3Tz==', 'k7+Jq2Zp9Xw3Rt5Vb8Nm1Lc4Hd6Fg0Ys2QaPe3Tz=='],
  ['url-safe base64 token', 'refresh_token=Q9m-Zt2_Lp7Kx4Vw8Nb1Rc6Hs3Gd5Fy0Ju2Me4Oa', 'Q9m-Zt2_Lp7Kx4Vw8Nb1Rc6Hs3Gd5Fy0Ju2Me4Oa'],
  ['gitlab token', 'glpat-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op'],
  ['google api key', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
  ['email', 'Signed-off-by: Some One <some.one@example.com>', 'some.one@example.com'],
  ['email with plus tag and subdomain', 'contact first.last+tag@mail.sub.example.co.uk today', 'first.last+tag@mail.sub.example.co.uk'],
  ['private ipv4', 'ssh deploy@192.168.1.42', '192.168.1.42'],
  ['public ipv4 in url', 'curl http://203.0.113.9:8080/health', '203.0.113.9'],
  ['home path of the current user', 'cat /home/alice/.ssh/id_ed25519.pub', '/home/alice'],
  ['home path of another user', 'scp app.tar.gz root@203.0.113.7:/home/deploy/app/', '/home/deploy'],
  ['macOS home path', 'open /Users/bob/Library/Keychains', '/Users/bob'],
  ['windows home path', 'type C:\\Users\\carol\\.npmrc', 'C:\\Users\\carol'],
  ['windows home path, forward slashes', 'cat C:/Users/carol/.npmrc', 'C:/Users/carol'],
];

test(`redact masks ${SECRETS.length} secret-like strings`, () => {
  assert.ok(SECRETS.length >= 30);
  for (const [label, input, sensitive] of SECRETS) {
    const out = r(input);
    assert.ok(!out.includes(sensitive), `${label}: ${JSON.stringify(out)}`);
    assert.ok(out.includes('[REDACTED') || out.includes('~'), `${label}: no placeholder in ${JSON.stringify(out)}`);
  }
});

test('redact keeps the non-secret part of the line', () => {
  assert.equal(r('export ANTHROPIC_API_KEY=sk-ant-api03-Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Zx9Cv8Bn7Mm6'), 'export ANTHROPIC_API_KEY=[REDACTED:key]');
  assert.equal(r('curl -H "Authorization: Bearer abcDEF123.ghiJKL456-mnoPQR" https://api.example.com'), 'curl -H "Authorization: Bearer [REDACTED:token]" https://api.example.com');
  assert.equal(r('cat /home/alice/.ssh/id_ed25519.pub'), 'cat ~/.ssh/id_ed25519.pub');
  assert.equal(r('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAwJ1x\n-----END RSA PRIVATE KEY-----\ndone'), '[REDACTED:private-key]\ndone');
  assert.equal(r('Signed-off-by: Some One <some.one@example.com>'), 'Signed-off-by: Some One <[REDACTED:email]>');
});

const ORDINARY = [
  "import { readFileSync } from 'node:fs';",
  'const total = items.reduce((acc, item) => acc + item.price * item.qty, 0);',
  'function handleUserAuthenticationRequestFromClient(request, response) {',
  'export const DEFAULT_CONFIGURATION_TIMEOUT_MILLISECONDS = 30000;',
  'const cacheKey = `${userId}:${projectId}:${revision}`;',
  'git commit -m "fix: handle empty hunks" # abc1234',
  'Merge commit 3f2a9c1 into main',
  'short sha 9e107d9d372bb6826bd81d3542a419d (31 hex chars)',
  'version 2.1.299 of the CLI, node v22.17.1, npm 10.9.2',
  'bumped from 2.1.267 to 2.1.299.0 (four-part build id)',
  'model: claude-haiku-4-5-20251001 and claude-opus-5-5',
  'sessionId 3a3b0e4b-e462-40a0-8a0b-837a10b8f827',
  'messageId msg_011Cg1xveZgcBwp2UsSKjKmB requestId req_011Cg1xveHa6Yr5dbfRtGiCU',
  'toolUseId toolu_011jmgAiBh5tALoT1o8sYYxT',
  'npm run test -- --grep "redact"',
  'node --test test/redact.test.js',
  'python -m pytest tests/test_detector.py::test_threshold -q',
  'cd /tmp/site-gen && make build TARGET=release',
  'const re = /^[A-Za-z0-9._%+-]+@/; // email prefix pattern',
  'listen on 0.0.0.0:8080 behind nginx',
  'curl http://127.0.0.1:3000/health',
  'cd /repo/src/components/UserProfile2026/Settings && ls',
  'const SEMVER = "1.2.3"; const RANGE = ">=10.0.0 <11.0.0";',
  'https://github.com/JulienAu/hunkproof/pull/1',
  'some-long-package-name-v2-release-candidate-build-artifacts',
  'ThisIsAVeryLongPascalCaseClassNameForTheRepositoryLayer2',
  'sed -e "s#feat_block1245ref_L31xt_s42_raw#feat_block1245ref_L31xt_s42_cooked#" swap.py',
  'export const MAX_RETRY_ATTEMPTS_BEFORE_GIVING_UP_ON_UPLOAD = 5;',
];

test('redact leaves ordinary code, short hashes, ids and version strings intact', () => {
  for (const line of ORDINARY) {
    assert.equal(r(line), line, line);
  }
});

test('redact rewrites paths under home and keeps the rest of the command', () => {
  assert.equal(
    r('cd /home/alice/projects/MyApp2026/src/Components && npm test'),
    'cd ~/projects/MyApp2026/src/Components && npm test',
  );
  assert.equal(r('/home/alice'), '~');
  assert.equal(r('/home/alice-backup/x'), '~/x');
  assert.equal(redact('/home/alice/x', { home: '/home/alice/' }), '~/x');
});

test('redact rewrites the encoded transcript-directory form of the home dir', () => {
  assert.equal(
    r('grep -c x ~/.claude/projects/-home-alice/abc.jsonl ~/.claude/projects/-home-alice-my-app/def.jsonl'),
    'grep -c x ~/.claude/projects/~/abc.jsonl ~/.claude/projects/~-my-app/def.jsonl',
  );
  assert.equal(r('/home/alice/.claude/projects/-home-alice/x'), '~/.claude/projects/~/x');
  // not inside another word
  assert.equal(r('x-home-alicey'), 'x-home-alicey');
});

test('redactHomePaths rewrites only home directories: own, encoded, other users, Windows', () => {
  const p = (s) => redactHomePaths(s, { home: HOME });
  assert.equal(p('/home/alice/repo/src/a.js'), '~/repo/src/a.js');
  assert.equal(p('-home-alice-repo'), '~-repo');
  assert.equal(p('/home/bob/x and /Users/carol/y'), '~/x and ~/y');
  assert.equal(p('C:\\Users\\dave\\proj\\a.js'), '~\\proj\\a.js');
  assert.equal(p('D:/Users/dave/proj/a.js'), '~/proj/a.js');
  assert.equal(p('C:\\home\\erin\\x'), '~\\x');
  // everything that is not a home directory stays: secrets, shas, emails, URLs with /home/ in them
  const keep = [
    'sk-ant-api03-Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Zx9Cv8Bn7Mm6',
    'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
    'some.one@example.com',
    'https://example.com/home/page and https://example.com/Users/list',
    '/var/home/x /opt/Users/y',
    'cd /tmp/site-gen && make build',
  ];
  for (const s of keep) assert.equal(p(s), s, s);
  assert.equal(p(p('/home/alice/x C:\\Users\\dave\\y')), '~/x ~\\y', 'idempotent');
  assert.equal(redactHomePaths(null), '');
  assert.equal(redactHomePaths('/home/alice/x', { home: '/' }), '~/x', 'a root home falls back to the generic rule');
});

test('redact is idempotent and tolerates empty input', () => {
  const once = SECRETS.map(([, input]) => r(input)).join('\n');
  assert.equal(r(once), once);
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(''), '');
});

test('looksHighEntropy separates credentials from long identifiers', () => {
  assert.equal(looksHighEntropy('Zx9Qp3Lm7Vn2Rt8Ws4Kd6Hf1Jg5Bc0Ya'), true);
  assert.equal(looksHighEntropy('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'), true);
  assert.equal(looksHighEntropy('handleUserAuthenticationRequestFromClient'), false);
  assert.equal(looksHighEntropy('3a3b0e4b-e462-40a0-8a0b-837a10b8f827'), false);
  assert.equal(looksHighEntropy('DEFAULT_CONFIGURATION_TIMEOUT_MILLISECONDS'), false);
  assert.equal(looksHighEntropy('tooShort123'), false);
});

test('redact output never contains the forbidden vocabulary', () => {
  const out = SECRETS.map(([, input]) => r(input)).join('\n');
  assert.doesNotMatch(out, /\b(tested|verified|covered)\b/i);
});
