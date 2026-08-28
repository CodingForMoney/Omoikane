import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CredentialCipher } from "../src/crypto.js";

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest();

describe("CredentialCipher", () => {
  it("encrypts and decrypts current Provider credentials", () => {
    const cipher = new CredentialCipher("current-format-test-secret");
    const encrypted = cipher.encrypt("sensitive request");

    expect(encrypted.ciphertext[0]).toBe(2);
    expect(
      cipher.decrypt(encrypted.ciphertext, encrypted.checksum).toString(),
    ).toBe("sensitive request");
  });

  it("keeps decrypt compatibility with version 1 ciphertext", () => {
    const secret = "legacy-format-test-secret";
    const plaintext = Buffer.from("legacy protected state");
    const key = sha256(secret);
    const nonce = randomBytes(12);
    const legacyCipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([
      legacyCipher.update(plaintext),
      legacyCipher.final(),
    ]);
    const ciphertext = Buffer.concat([
      Buffer.from([1]),
      nonce,
      legacyCipher.getAuthTag(),
      body,
    ]);

    expect(
      new CredentialCipher(secret)
        .decrypt(ciphertext, sha256(plaintext).toString("hex"))
        .toString(),
    ).toBe(plaintext.toString());
  });
});
