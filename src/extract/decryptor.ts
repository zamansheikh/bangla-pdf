/**
 * The PDF standard security handler, for reading protected documents.
 *
 * Most "protected" PDFs — the kind a government office publishes — carry an
 * owner password to discourage editing and an *empty* user password, so they
 * open without being asked for anything. The bytes are still encrypted, and an
 * extractor that ignores that reads noise. This decrypts them.
 *
 * Every revision in the wild is covered: RC4 (revisions 2 and 3), AES-128
 * (revision 4) and AES-256 (revisions 5 and 6).
 *
 * Ported from `lib/src/extract/decryptor.dart` in the `bangla_pdf` Dart
 * package. The ciphers and hashes come from `@noble/ciphers` and
 * `@noble/hashes` rather than being written out here — decryption is the one
 * place in this package where hand-rolled code would be a bad trade.
 *
 * Decryption only: nothing here is used to protect anything.
 */

import { cbc } from '@noble/ciphers/aes.js';
import { md5 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';

import { get, type PdfDictObj, type PdfObj } from './objects.js';

/** How a particular string or stream is protected. */
type Cipher = 'none' | 'rc4' | 'aesV2' | 'aesV3';

/** The 32-byte string a PDF pads short passwords with, from the spec. */
const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

type Resolve = (o: PdfObj) => PdfObj;

/** Decrypts the strings and streams of one document. */
export class PdfDecryptor {
  private constructor(
    private readonly key: Uint8Array,
    private readonly streamCipher: Cipher,
    private readonly stringCipher: Cipher,
  ) {}

  /**
   * Builds a decryptor for [encrypt], or null when the document cannot be
   * opened with [password] — a real user-password document, or a handler this
   * does not implement.
   */
  static open(
    encrypt: PdfDictObj,
    resolve: Resolve,
    firstFileId: Uint8Array,
    password = '',
  ): PdfDecryptor | null {
    const filter = resolve(get(encrypt, 'Filter'));
    if (filter.kind !== 'name' || filter.value !== 'Standard') return null;

    const intOf = (key: string, fallback: number): number => {
      const value = resolve(get(encrypt, key));
      return value.kind === 'num' ? Math.trunc(value.value) : fallback;
    };
    const bytesOf = (key: string): Uint8Array => {
      const value = resolve(get(encrypt, key));
      return value.kind === 'string' ? value.bytes : new Uint8Array(0);
    };

    const v = intOf('V', 0);
    const r = intOf('R', 0);
    const o = bytesOf('O');
    const u = bytesOf('U');
    const permissions = intOf('P', -1);
    let lengthBits = intOf('Length', 40);

    // V4 and V5 name their ciphers in a crypt-filter dictionary.
    let streamCipher: Cipher = v >= 4 ? 'none' : 'rc4';
    let stringCipher: Cipher = streamCipher;
    if (v >= 4) {
      const cf = resolve(get(encrypt, 'CF'));
      const filterName = (key: string): string => {
        const value = resolve(get(encrypt, key));
        return value.kind === 'name' ? value.value : 'Identity';
      };
      const cipherFor = (cfName: string): Cipher => {
        if (cfName === 'Identity') return 'none';
        if (cf.kind !== 'dict') return 'none';
        const entry = resolve(get(cf, cfName));
        if (entry.kind !== 'dict') return 'none';
        const method = resolve(get(entry, 'CFM'));
        const bits = resolve(get(entry, 'Length'));
        if (bits.kind === 'num' && bits.value > 0) {
          // Some writers give bytes here and some give bits.
          lengthBits = bits.value <= 64 ? bits.value * 8 : Math.trunc(bits.value);
        }
        if (method.kind !== 'name') return 'none';
        switch (method.value) {
          case 'V2':
            return 'rc4';
          case 'AESV2':
            return 'aesV2';
          case 'AESV3':
            return 'aesV3';
          default:
            return 'none';
        }
      };
      streamCipher = cipherFor(filterName('StmF'));
      stringCipher = cipherFor(filterName('StrF'));
    }

    let key: Uint8Array | null;
    if (r >= 5) {
      key = keyForRevision6(password, u, bytesOf('UE'), o, bytesOf('OE'));
      streamCipher = 'aesV3';
      stringCipher = 'aesV3';
    } else {
      const encryptMetadata = resolve(get(encrypt, 'EncryptMetadata'));
      key = keyForRevision2to4(
        password,
        o,
        permissions,
        firstFileId,
        r,
        lengthBits,
        encryptMetadata.kind === 'bool' ? encryptMetadata.value : true,
      );
    }
    if (key === null) return null;
    return new PdfDecryptor(key, streamCipher, stringCipher);
  }

  decryptStream(data: Uint8Array, number: number, generation: number): Uint8Array {
    return this.apply(this.streamCipher, data, number, generation);
  }

  decryptString(data: Uint8Array, number: number, generation: number): Uint8Array {
    return this.apply(this.stringCipher, data, number, generation);
  }

  private apply(
    cipher: Cipher,
    data: Uint8Array,
    number: number,
    generation: number,
  ): Uint8Array {
    switch (cipher) {
      case 'none':
        return data;
      case 'aesV3':
        // AES-256 uses the file key as it is; there is no per-object key.
        return aesCbcDecrypt(this.key, data);
      case 'rc4':
        return rc4(this.objectKey(number, generation, false), data);
      case 'aesV2':
        return aesCbcDecrypt(this.objectKey(number, generation, true), data);
    }
  }

  /**
   * Algorithm 1: mixes the object and generation numbers into the file key, so
   * every object is encrypted differently.
   */
  private objectKey(number: number, generation: number, aes: boolean): Uint8Array {
    const extra = [
      number & 0xff,
      (number >> 8) & 0xff,
      (number >> 16) & 0xff,
      generation & 0xff,
      (generation >> 8) & 0xff,
    ];
    // AES-128 adds a fixed salt, so the same object gets a different key than
    // it would under RC4.
    if (aes) extra.push(0x73, 0x41, 0x6c, 0x54); // "sAlT"

    const digest = md5(concat(this.key, Uint8Array.from(extra)));
    return digest.subarray(0, Math.min(16, this.key.length + 5));
  }
}

/** Algorithm 2: the file key for revisions 2 to 4. */
function keyForRevision2to4(
  password: string,
  ownerEntry: Uint8Array,
  permissions: number,
  fileId: Uint8Array,
  revision: number,
  lengthBits: number,
  encryptMetadata: boolean,
): Uint8Array {
  const bytes = latin1(password);
  const padded = new Uint8Array(32);
  const take = Math.min(32, bytes.length);
  padded.set(bytes.subarray(0, take), 0);
  padded.set(PAD.subarray(0, 32 - take), take);

  const parts: Uint8Array[] = [
    padded,
    ownerEntry,
    Uint8Array.from([
      permissions & 0xff,
      (permissions >> 8) & 0xff,
      (permissions >> 16) & 0xff,
      (permissions >> 24) & 0xff,
    ]),
    fileId,
  ];
  if (revision >= 4 && !encryptMetadata) parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));

  let digest = md5(concat(...parts));
  const length = revision === 2 ? 5 : Math.min(16, Math.max(5, Math.floor(lengthBits / 8)));
  if (revision >= 3) {
    // Deliberately slow: 50 more rounds over the first `length` bytes.
    for (let i = 0; i < 50; i++) digest = md5(digest.subarray(0, length));
  }
  return digest.subarray(0, length);
}

/**
 * Algorithm 2.A: the file key for revisions 5 and 6, AES-256.
 *
 * The user password is tried first, then the owner password, which is how a
 * document with an owner password and an empty user password opens.
 */
function keyForRevision6(
  password: string,
  u: Uint8Array,
  ue: Uint8Array,
  o: Uint8Array,
  oe: Uint8Array,
): Uint8Array | null {
  if (u.length < 48) return null;
  const bytes = latin1(password);

  const tryUser = (): Uint8Array | null => {
    const check = hash2B(bytes, u.subarray(32, 40), new Uint8Array(0));
    if (!same(check, u.subarray(0, 32))) return null;
    if (ue.length < 32) return null;
    const intermediate = hash2B(bytes, u.subarray(40, 48), new Uint8Array(0));
    return aesCbcNoPadDecryptZeroIv(intermediate, ue.subarray(0, 32));
  };

  const tryOwner = (): Uint8Array | null => {
    if (o.length < 48 || oe.length < 32) return null;
    const first48 = u.subarray(0, 48);
    const check = hash2B(bytes, o.subarray(32, 40), first48);
    if (!same(check, o.subarray(0, 32))) return null;
    const intermediate = hash2B(bytes, o.subarray(40, 48), first48);
    return aesCbcNoPadDecryptZeroIv(intermediate, oe.subarray(0, 32));
  };

  return tryUser() ?? tryOwner();
}

/**
 * Algorithm 2.B: the deliberately expensive hash revisions 5 and 6 use.
 *
 * Revision 5 stopped at a single SHA-256; revision 6 added the loop below to
 * make guessing passwords costly. Running the loop for a revision 5 document is
 * harmless, because it exits as soon as the round condition is met.
 */
function hash2B(password: Uint8Array, salt: Uint8Array, userData: Uint8Array): Uint8Array {
  let k = sha256(concat(password, salt, userData));

  for (let round = 0; ; round++) {
    const block = concat(password, k, userData);
    const k1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length);

    const e = aesCbcNoPadEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1);
    if (e.length === 0) return k;

    let sum = 0;
    for (let i = 0; i < 16 && i < e.length; i++) sum += e[i]!;
    k = sum % 3 === 0 ? sha256(e) : sum % 3 === 1 ? sha384(e) : sha512(e);

    if (round >= 63 && e.length > 0 && e[e.length - 1]! <= round - 31) break;
    if (round > 256) break; // never seen in practice; bounds a bad file
  }
  return k.subarray(0, 32);
}

// --- ciphers ----------------------------------------------------------------

/** RC4, which is its own inverse. Four lines, and no library ships it any more. */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length === 0) return data.slice();
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    const t = s[i]!;
    s[i] = s[j]!;
    s[j] = t;
  }

  const out = new Uint8Array(data.length);
  let x = 0;
  let y = 0;
  for (let n = 0; n < data.length; n++) {
    x = (x + 1) & 0xff;
    y = (y + s[x]!) & 0xff;
    const t = s[x]!;
    s[x] = s[y]!;
    s[y] = t;
    out[n] = data[n]! ^ s[(s[x]! + s[y]!) & 0xff]!;
  }
  return out;
}

/**
 * Decrypts [data] with AES-CBC, taking the IV from the first block.
 *
 * This is how a PDF stores an encrypted string or stream. Returns nothing when
 * the input is too short or not a whole number of blocks.
 */
function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32 || data.length % 16 !== 0) return new Uint8Array(0);
  try {
    return cbc(key, data.subarray(0, 16)).decrypt(data.subarray(16));
  } catch {
    // A wrong key usually shows up as a bad PKCS#7 pad. Fall back to the
    // unpadded plaintext rather than losing the whole stream.
    try {
      const raw = cbc(key, data.subarray(0, 16), { disablePadding: true }).decrypt(
        data.subarray(16),
      );
      const pad = raw[raw.length - 1] ?? 0;
      return pad >= 1 && pad <= 16 && pad <= raw.length ? raw.subarray(0, raw.length - pad) : raw;
    } catch {
      return new Uint8Array(0);
    }
  }
}

/** AES-CBC with a zero IV and no padding: how revisions 5 and 6 wrap the file key. */
function aesCbcNoPadDecryptZeroIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  return cbc(key, new Uint8Array(16), { disablePadding: true }).decrypt(data);
}

/** AES-CBC encryption with no padding. Revision 6 derives its key by encrypting. */
function aesCbcNoPadEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16 !== 0) return new Uint8Array(0);
  return cbc(key, iv, { disablePadding: true }).encrypt(data);
}

// --- helpers ----------------------------------------------------------------

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
