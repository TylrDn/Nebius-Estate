import assert from 'node:assert/strict';
import { constants, createECDH, createHash, createHmac, generateKeyPairSync, privateEncrypt } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
// Exercise installed consumer paths. The lockfile review must also confirm all package resolutions.
const globRequire = createRequire(require.resolve('micromatch'));
const forgeRequire = createRequire(require.resolve('@backstage/backend-defaults'));
const signingRequire = createRequire(require.resolve('browserify-sign'));
const bracesPath = globRequire.resolve('braces');
const forge = forgeRequire('node-forge');
const { ec: EC } = signingRequire('elliptic');

function boundedBraceCheck(body) {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const braces = require(${JSON.stringify(bracesPath)});
    ${body}
  `], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
}

for (const pair of [['{', '}'], ['(', ')']]) {
  test(`braces rejects excessive ${pair[0]} nesting even when maxDepth is raised`, () => {
    boundedBraceCheck(`
      const input = ${JSON.stringify(pair[0])}.repeat(3000) + 'a,b' + ${JSON.stringify(pair[1])}.repeat(3000);
      assert.throws(() => braces.parse(input, { maxDepth: 3000 }), /exceeds max depth/);
    `);
  });
}

for (const method of ['compile', 'expand', 'stringify']) {
  test(`braces ${method} bounds supplied AST depth`, () => {
    boundedBraceCheck(`
      let ast = { type: 'text', value: 'a' };
      for (let i = 0; i < 3000; i++) ast = { type: 'brace', nodes: [ast] };
      ast = { type: 'root', nodes: [ast] };
      assert.throws(() => braces.${method}(ast, { maxDepth: 3000 }), /exceeds max depth/);
    `);
  });
}

test('braces rejects cyclic AST parents without hanging', () => {
  boundedBraceCheck(`
    const first = { type: 'paren', nodes: [{ type: 'text', value: 'a' }] };
    const second = { type: 'paren', parent: first };
    first.parent = second;
    assert.throws(() => braces.expand(first), /parent chain contains a cycle/);
  `);
});

test('braces retains ordinary glob, range and nested-parenthesis behavior', () => {
  const braces = globRequire('braces');
  assert.deepEqual(braces.expand('src/{pages,ui}/*.{ts,tsx}'), ['src/pages/*.ts', 'src/pages/*.tsx', 'src/ui/*.ts', 'src/ui/*.tsx']);
  assert.deepEqual(braces.expand('file-{1..3}'), ['file-1', 'file-2', 'file-3']);
  assert.deepEqual(braces.expand('foo/({a,b})'), ['foo/(a)', 'foo/(b)']);
  assert.equal(braces.stringify(braces.parse('{a,{b,{c}}}'), { escapeInvalid: true }), '{a,{b,{c}}}');
  const boundary = '{'.repeat(100) + 'a,b' + '}'.repeat(100);
  assert.doesNotThrow(() => braces.compile(braces.parse(boundary)));
});

// Generate ephemeral keys; no private key fixture or deployed credential is stored.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 });
const publicKey = forge.pki.publicKeyFromPem(keys.publicKey.export({ type: 'spki', format: 'pem' }));
const digest = createHash('sha256').update('Nebius Estate synthetic signature regression').digest();
function digestInfoSignature({ parameters = true, garbage = false, nullContent = '' } = {}) {
  const a = forge.asn1;
  const element = (type, value, constructed = false) => a.create(a.Class.UNIVERSAL, type, constructed, value);
  const algorithm = [element(a.Type.OID, a.oidToDer(forge.pki.oids.sha256).getBytes())];
  if (parameters) algorithm.push(element(a.Type.NULL, nullContent));
  if (garbage) algorithm.push(element(a.Type.OCTETSTRING, 'unconsumed nested bytes'));
  const info = element(a.Type.SEQUENCE, [element(a.Type.SEQUENCE, algorithm, true), element(a.Type.OCTETSTRING, digest.toString('binary'))], true);
  const der = Buffer.from(a.toDer(info).getBytes(), 'binary');
  const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(256 - der.length - 3, 0xff), Buffer.from([0]), der]);
  return privateEncrypt({ key: keys.privateKey, padding: constants.RSA_NO_PADDING }, encoded).toString('binary');
}

test('forge rejects extra nested DigestAlgorithm children in RSA signatures', () => {
  assert.throws(() => publicKey.verify(digest.toString('binary'), digestInfoSignature({ garbage: true })), /DigestInfo/);
});

test('forge rejects nonempty NULL parameters instead of ignoring nested content', () => {
  assert.throws(() => publicKey.verify(digest.toString('binary'), digestInfoSignature({ nullContent: 'ignored bytes' })), /DigestInfo/);
});

for (const parameters of [true, false]) {
  test(`forge accepts valid SHA-256 DigestInfo with parameters=${parameters}`, () => {
    assert.equal(publicKey.verify(digest.toString('binary'), digestInfoSignature({ parameters })), true);
  });
}

// Independent RFC 6979 HMAC construction plus OpenSSL's EC multiplication. In particular,
// bits2int uses the original 66-byte candidate width, including any leading zero octet.
const order = BigInt('0x1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409');
const padded = number => Buffer.from(number.toString(16).padStart(132, '0'), 'hex');
const hmac = (key, ...parts) => createHmac('sha512', key).update(Buffer.concat(parts)).digest();
function candidateFor(hash) {
  const seed = Buffer.concat([padded(1n), padded(BigInt(`0x${hash.toString('hex')}`))]);
  let key = Buffer.alloc(64);
  let value = Buffer.alloc(64, 1);
  key = hmac(key, value, Buffer.from([0]), seed);
  value = hmac(key, value);
  key = hmac(key, value, Buffer.from([1]), seed);
  value = hmac(key, value);
  const first = hmac(key, value);
  return Buffer.concat([first, hmac(key, first)]).subarray(0, 66);
}
function inverse(number) {
  let a = number;
  let b = order;
  let x = 1n;
  let y = 0n;
  while (b) {
    const quotient = a / b;
    [a, b] = [b, a % b];
    [x, y] = [y, x - quotient * y];
  }
  return (x % order + order) % order;
}

test('elliptic P-521 preserves leading zero nonce bytes and matches an independent RFC 6979 result', () => {
  let hash;
  let raw;
  for (let i = 0; i < 4096; i++) {
    hash = createHash('sha512').update(`Nebius Estate P-521 regression ${i}`).digest();
    raw = candidateFor(hash);
    if (raw[0] === 0) break;
  }
  assert.equal(raw[0], 0, 'bounded deterministic corpus must exercise a leading zero nonce');
  const nonce = BigInt(`0x${raw.toString('hex')}`) >> 7n;
  assert.ok(nonce > 1n && nonce < order - 1n);
  const point = createECDH('secp521r1');
  point.setPrivateKey(padded(nonce));
  const x = point.getPublicKey(undefined, 'uncompressed').subarray(1, 67);
  const r = BigInt(`0x${x.toString('hex')}`) % order;
  const s = inverse(nonce) * (BigInt(`0x${hash.toString('hex')}`) + r) % order;
  const curve = new EC('p521');
  const key = curve.keyFromPrivate('1');
  const actual = key.sign(hash);
  assert.equal(actual.r.toString(16), r.toString(16));
  assert.equal(actual.s.toString(16), s.toString(16));
  assert.equal(key.verify(hash, actual), true);
});

test('elliptic retains caller-supplied nonce and ordinary P-256 signing behavior', () => {
  const curve = new EC('p256');
  const key = curve.keyFromPrivate('1');
  const hash = createHash('sha256').update('synthetic signing compatibility').digest();
  const BN = signingRequire('bn.js');
  const custom = key.sign(hash, { k: () => new BN(1358) });
  assert.equal(key.verify(hash, custom), true);
  // OpenSSL derives the expected point independently of elliptic's nonce handling.
  const suppliedNonce = Buffer.alloc(32);
  suppliedNonce.writeUInt16BE(1358, 30);
  const point = createECDH('prime256v1');
  point.setPrivateKey(suppliedNonce);
  const p256Order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const expectedR = BigInt(`0x${point.getPublicKey(undefined, 'uncompressed').subarray(1, 33).toString('hex')}`) % p256Order;
  assert.equal(custom.r.toString(16), expectedR.toString(16));
  const first = key.sign(hash);
  assert.equal(first.toDER('hex'), key.sign(hash).toDER('hex'));
  assert.equal(key.verify(hash, first), true);
});
