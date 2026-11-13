import Database from 'better-sqlite3-multiple-ciphers';

export type SdoDatabase = Database.Database;

/**
 * 打开一个加密的 SDO 库（SQLCipher 格式）。
 *
 * 选型依据：plan/cards/M0-0.md 的 C4（原生 better-sqlite3-multiple-ciphers@13.0.3；
 * tarball 自带各平台 prebuilds，安装期不需要 node-gyp/prebuild-install）。
 * 设计依据：docs/02 §8 要求 SQLCipher 式加密，且 §8.3 要求降级必须 fail-closed
 * ——所以这里**没有明文分支**：空口令直接拒绝，key 之后立即读一次 sqlite_master，
 * 让“错误口令 / 明文库”在 open 当场失败，而不是拖到第一条业务语句。
 *
 * `cipher='sqlcipher'` + `legacy=4` 是显式钉死格式：SQLite3MultipleCiphers 缺省
 * 用 sqleet，不钉死就会在无人察觉时漂成 sqlcipher CLI 打不开的库。
 */
export function openEncryptedDatabase(file: string, passphrase: string): SdoDatabase {
  if (passphrase.length === 0) {
    throw new RangeError('openEncryptedDatabase: passphrase must not be empty (fail-closed, no plaintext fallback)');
  }

  const db = new Database(file);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.key(Buffer.from(passphrase, 'utf8'));
    db.pragma('foreign_keys = ON');
    // fail-closed：错误口令或明文 SQLite 文件在这里就抛 SQLITE_NOTADB，
    // 不会留下“能打开、之后某条语句才炸”的半开状态。
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (error) {
    try {
      db.close();
    } catch {
      // close 失败（句柄已坏等）不能盖掉 open 的原始原因（如 SQLITE_NOTADB）。
    }
    throw error;
  }
  return db;
}
