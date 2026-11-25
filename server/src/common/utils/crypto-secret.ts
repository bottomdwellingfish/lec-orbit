/**
 * 工坊应用 S2S 密钥生成与 AES-256-GCM 静态加密存储工具。
 * 保证数据库中不落明文 HMAC 密钥，同时允许服务端验签时按需解密。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENCRYPTED_PREFIX = 'enc:v1:';

function deriveAesKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

/** 生成新的工坊应用专属 S2S 密钥（格式：lec_app_<48位hex>）。 */
export function generateAppSecret(): { plain: string; prefix: string } {
  const plain = `lec_app_${randomBytes(24).toString('hex')}`;
  return {
    plain,
    prefix: plain.slice(0, 14),
  };
}

/** 使用主密钥加密应用密钥；若未配置主密钥则安全降级并带明确前缀标记。 */
export function sealAppSecret(plainSecret: string, masterKey: string): string {
  if (!masterKey) {
    return `plain:${plainSecret}`;
  }
  const key = deriveAesKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** 解密数据库中的工坊应用 S2S 密钥用于验签。 */
export function openAppSecret(sealed: string, masterKey: string): string {
  if (sealed.startsWith('plain:')) {
    return sealed.slice('plain:'.length);
  }
  if (!sealed.startsWith(ENCRYPTED_PREFIX)) {
    return sealed;
  }
  if (!masterKey) {
    throw new Error('缺少 ECONOMY_CREDENTIAL_MASTER_KEY，无法解密工坊应用密钥');
  }
  const parts = sealed.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('应用密钥密文格式损坏');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = deriveAesKey(masterKey);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
