/**
 * 测试夹具：在当前进程内扮演 signerd（真 Ed25519 + 真 keyring + 真回执）。
 *
 * 用途：
 *   - `test/db/*` 里 `seed('decision.signed', ...)` 需要一条“确实经过 signerd”的签名载荷，
 *     否则写网关验签必拒（C8）——那是**正当红**，修夹具而不是放宽网关；
 *   - `test/sign/*` 的端到端用例在无 socket 时用它构造受信密钥/回执基线。
 *
 * 私钥只在本进程内存里（KeyObject），盘上只写 `public_keys.json` 与 `receipts.jsonl`（0600）。
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import { keyIdForPublicKey, publicKeyBase64 } from '../../src/sign/keys.js';
import {
  RECEIPT_VERSION,
  canonicalDecisionMessage,
  computeReceiptId,
  propositionHash,
  receiptHash,
  signCanonical,
  type SignChannel,
  type SignerdReceipt,
} from '../../src/sign/receipt.js';

/**
 * 固定测试钥匙（**只用于测试**）：keyring 快照要逐字节稳定，随机 keypair 会让
 * per-kind-fold.json 每次跑都不一样。私钥明文放在测试文件里是刻意的——
 * 它不是任何真实用户的密钥，绝不可用于产品。
 */
const TEST_PRIVATE_KEY_PKCS8_B64 =
  'MC4CAQAwBQYDK2VwBCIEILsW571dp6s+X3zw5Xi5yEDqMR1dS3ZWkTIMMTfeYL7e';

function testKeyPair(): { readonly privateKey: KeyObject; readonly publicKey: KeyObject } {
  const privateKey = createPrivateKey({
    key: Buffer.from(TEST_PRIVATE_KEY_PKCS8_B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export const TEST_SIGNERD_SIGNER = 'alice';
export const TEST_SIGNERD_CHANNEL: SignChannel = 'cli';

export interface SignInput {
  readonly decision_id: string;
  readonly payload_hash: string;
  readonly proposition?: string;
  readonly proposition_hash?: string;
  readonly frontier: string;
  readonly nonce: string;
  readonly signer?: string;
  readonly channel?: SignChannel;
  readonly at?: string;
}

export interface SignedPayload {
  readonly payload_hash: string;
  readonly proposition_hash: string;
  readonly frontier: string;
  readonly nonce: string;
  readonly signature: string;
  readonly key_id: string;
  readonly signer: string;
  readonly channel: SignChannel;
  readonly signerd: {
    readonly receipt_id: string;
    readonly at: string;
    readonly unlock_wait_ms: number;
    readonly sign_ms: number;
  };
}

export interface FixtureSignerd {
  readonly home: string;
  readonly key_id: string;
  readonly public_key: string;
  sign(input: SignInput): SignedPayload;
  /** 追加一条回执（sign 已调用，供需要自行落盘的测试使用）。 */
  receiptFor(input: SignInput): SignerdReceipt;
  /** 恢复调用前的 HOME（信任根由 HOME 决定，D-054：产品不读 signerd 专用 env）。 */
  restore(): void;
}

export const FIXTURE_AT = '2026-11-14T00:00:00.000Z';

let singleton: FixtureSignerd | undefined;

/**
 * 建临时 home（`$HOME/.local/state/sdo/signerd`，逐级 0700；keyring/receipts 0600）。
 *
 * D-054：产品不读 `SDO_SIGNERD_HOME`；测试用标准 `HOME` 把缺省信任根指到临时目录，
 * 少数需要显式 home 的调用（signerd/client/verify）另走参数注入。
 */
export function installTestSignerd(): FixtureSignerd {
  if (singleton !== undefined) return singleton;
  const root = mkdtempSync(join(tmpdir(), 'sdo-signerd-fixture-'));
  chmodSync(root, 0o700);
  const stateDir = join(root, '.local', 'state', 'sdo');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(join(root, '.local'), 0o700);
  chmodSync(join(root, '.local', 'state'), 0o700);
  chmodSync(stateDir, 0o700);
  const home = join(stateDir, 'signerd');
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  const { privateKey, publicKey } = testKeyPair();
  const key = { private_key: privateKey, public_key: publicKeyBase64(publicKey), key_id: keyIdForPublicKey(publicKey) };
  const previousHome = process.env['HOME'];
  const previousTtl = process.env['SDO_SIGNERD_WINDOW_TTL_MINUTES'];
  process.env['HOME'] = root;
  delete process.env['SDO_SIGNERD_WINDOW_TTL_MINUTES'];

  const keyringPath = join(home, 'public_keys.json');
  writeFileSync(keyringPath, `${JSON.stringify({ keys: { [key.key_id]: key.public_key } }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(keyringPath, 0o600);
  const receiptsPath = join(home, 'receipts.jsonl');
  writeFileSync(receiptsPath, '', { mode: 0o600 });
  chmodSync(receiptsPath, 0o600);

  let lastReceiptHash: string | null = null;

  const receiptFor = (input: SignInput): SignerdReceipt => {
    const proposition = input.proposition ?? `fixture proposition ${input.decision_id}`;
    const message = canonicalDecisionMessage({
      decision_id: input.decision_id,
      payload_hash: input.payload_hash,
      proposition_hash: input.proposition_hash ?? propositionHash(proposition),
      frontier: input.frontier,
      nonce: input.nonce,
    });
    const signature = signCanonical(key.private_key, message);
    const at = input.at ?? FIXTURE_AT;
    return {
      version: RECEIPT_VERSION,
      receipt_id: computeReceiptId({
        decision_id: input.decision_id,
        payload_hash: input.payload_hash,
        signature,
        at,
        nonce: input.nonce,
      }),
      decision_id: input.decision_id,
      payload_hash: input.payload_hash,
      proposition_hash: input.proposition_hash ?? propositionHash(proposition),
      frontier: input.frontier,
      nonce: input.nonce,
      signature,
      key_id: key.key_id,
      signer: input.signer ?? TEST_SIGNERD_SIGNER,
      channel: input.channel ?? TEST_SIGNERD_CHANNEL,
      at,
      unlock_wait_ms: 1,
      sign_ms: 1,
      prev_receipt_hash: lastReceiptHash,
    };
  };

  const sign = (input: SignInput): SignedPayload => {
    const receipt = receiptFor(input);
    writeFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, { flag: 'a', mode: 0o600 });
    lastReceiptHash = receiptHash(receipt);
    return {
      payload_hash: receipt.payload_hash,
      proposition_hash: receipt.proposition_hash,
      frontier: receipt.frontier,
      nonce: receipt.nonce,
      signature: receipt.signature,
      key_id: receipt.key_id,
      signer: receipt.signer,
      channel: receipt.channel,
      signerd: {
        receipt_id: receipt.receipt_id,
        at: receipt.at,
        unlock_wait_ms: receipt.unlock_wait_ms,
        sign_ms: receipt.sign_ms,
      },
    };
  };

  singleton = {
    home,
    key_id: key.key_id,
    public_key: key.public_key,
    sign,
    receiptFor,
    restore: () => {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      if (previousTtl === undefined) delete process.env['SDO_SIGNERD_WINDOW_TTL_MINUTES'];
      else process.env['SDO_SIGNERD_WINDOW_TTL_MINUTES'] = previousTtl;
      singleton = undefined;
    },
  };
  return singleton;
}
