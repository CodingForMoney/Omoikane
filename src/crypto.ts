import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest();

export class StateCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = sha256(secret);
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
      ciphertext: Buffer.concat([Buffer.from([1]), nonce, tag, body]),
      checksum: sha256(plaintext).toString("hex"),
    };
  }

  decrypt(ciphertext: Uint8Array, expectedChecksum: string): Buffer {
    const value = Buffer.from(ciphertext);
    if (value[0] !== 1 || value.length < 30)
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
    const actual = sha256(plaintext);
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
