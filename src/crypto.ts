// Keys, EIP-712 signatures, HPKE envelopes. Signing keys (secp256k1) and encryption keys (X25519) are separate roles.
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import { verifyTypedData, keccak256, toHex, bytesToHex, hexToBytes, type Hex, type Address } from "viem";
import { randomBytes } from "node:crypto";
import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { EIP712_TYPES, type ProtocolProfile, type Request, type AcceptedReceipt, type DecisionRecord, type Ack } from "./types.js";
import { domainOf } from "./encode.js";

export const salt32 = (): Hex => bytesToHex(randomBytes(32));

export function newSigner(pk?: Hex): PrivateKeyAccount { return privateKeyToAccount(pk ?? generatePrivateKey()); }

export type Primary = keyof typeof EIP712_TYPES;
/** Runtime primaryType → the struct it must be given. Keeps call sites honest without widening to `any`. */
export interface MessageFor { Request: Request; AcceptedReceipt: AcceptedReceipt; DecisionRecord: DecisionRecord; Ack: Ack; }

// viem's generic typed-data inference fights the runtime-selected primaryType; the shape is pinned by
// EIP712_TYPES and exercised by the day-1 tests, so the call itself is widened deliberately.
type TypedArgs = Parameters<typeof verifyTypedData>[0];

export async function signTyped<T extends Primary>(acct: PrivateKeyAccount, p: ProtocolProfile, primaryType: T, message: MessageFor[T]): Promise<Hex> {
  return acct.signTypedData({ domain: domainOf(p), types: EIP712_TYPES, primaryType, message } as unknown as Parameters<PrivateKeyAccount["signTypedData"]>[0]);
}
export async function verifyTyped<T extends Primary>(p: ProtocolProfile, primaryType: T, message: MessageFor[T], signature: Hex, address: Address): Promise<boolean> {
  try { return await verifyTypedData({ domain: domainOf(p), types: EIP712_TYPES, primaryType, message, signature, address } as unknown as TypedArgs); }
  catch { return false; }
}

// ---- HPKE (RFC 9180): DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM ----
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

export interface HpkeKeyPair { publicKey: Hex; privateKey: CryptoKey; }
export async function newHpkeKeyPair(): Promise<HpkeKeyPair> {
  const kp = await suite.kem.generateKeyPair();
  const raw = await suite.kem.serializePublicKey(kp.publicKey);
  return { publicKey: bytesToHex(new Uint8Array(raw)), privateKey: kp.privateKey };
}
export const hpkeKeyHash = (pub: Hex): Hex => keccak256(pub);

export interface Sealed { enc: Hex; ct: Hex; aad: Hex; }
export async function seal(recipientPub: Hex, plaintext: Uint8Array, aad: Hex): Promise<Sealed> {
  const pub = await suite.kem.deserializePublicKey(hexToBytes(recipientPub));
  const s = await suite.createSenderContext({ recipientPublicKey: pub });
  const ct = await s.seal(plaintext, hexToBytes(aad));
  return { enc: bytesToHex(new Uint8Array(s.enc)), ct: bytesToHex(new Uint8Array(ct)), aad };
}
export async function open(priv: CryptoKey, sealed: Sealed): Promise<Uint8Array> {
  const r = await suite.createRecipientContext({ recipientKey: priv, enc: hexToBytes(sealed.enc) });
  return new Uint8Array(await r.open(hexToBytes(sealed.ct), hexToBytes(sealed.aad)));
}
export const utf8 = { enc: (s: string) => new TextEncoder().encode(s), dec: (b: Uint8Array) => new TextDecoder().decode(b) };
export { toHex };
