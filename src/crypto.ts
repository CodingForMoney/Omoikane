import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest();

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = sha256(secret);
  }

  fingerprint(value: string | Uint8Array): string {
    return this.mac("omoikane-credential-fingerprint-v1", value).toString(
      "hex",
    );
  }

  private mac(domain: string, value: Uint8Array | string): Buffer {
    return createHmac("sha256", this.key)
      .update(domain)
      .update(Buffer.from([0]))
      .update(value)
      .digest();
  }

  encrypt(value: string | Uint8Array): {
    ciphertext: Buffer;
    checksum: string;
  } {
    const plaintext =
      typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([Buffer.from([2]), nonce, tag, body]),
      checksum: this.mac("omoikane-state-v2", plaintext).toString("hex"),
    };
  }

  decrypt(ciphertext: Uint8Array, expectedChecksum: string): Buffer {
    const value = Buffer.from(ciphertext);
    const version = value[0];
    if (![1, 2].includes(Number(version)) || value.length < 30)
      throw new Error("unsupported encrypted state format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.subarray(1, 13),
    );
    decipher.setAuthTag(value.subarray(13, 29));
    const plaintext = Buffer.concat([
      decipher.update(value.subarray(29)),
      decipher.final(),
    ]);
    const actual =
      version === 1
        ? sha256(plaintext)
        : this.mac("omoikane-state-v2", plaintext);
    const expected = Buffer.from(expectedChecksum, "hex");
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("encrypted state checksum mismatch");
    }
    return plaintext;
  }
}

export function checksum(value: string | Uint8Array): string {
  return sha256(value).toString("hex");
}
