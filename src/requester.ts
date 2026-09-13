// Requester client: builds and signs the request, decrypts decisions, signs ACKs.
import { keccak256, type Hex, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ProtocolProfile, Request, RequestEnvelope, DecisionRecord, Ack } from "./types.js";
import { requestCommitment, decisionDigest } from "./encode.js";
import { signTyped, verifyTyped, newHpkeKeyPair, seal, open, salt32, utf8, type HpkeKeyPair, type Sealed } from "./crypto.js";
import { bigintReplacer, bigintReviver } from "./institution.js";

export class Requester {
  private constructor(readonly signer: PrivateKeyAccount, readonly hpke: HpkeKeyPair) {}
  static async create(signer: PrivateKeyAccount) { return new Requester(signer, await newHpkeKeyPair()); }

  async buildRequest(p: ProtocolProfile, body: Omit<RequestEnvelope, "salt">, institutionHpkePub: Hex, currentBlock: bigint, ttlBlocks = 1000n) {
    const envelope: RequestEnvelope = { ...body, salt: salt32() };
    const request: Request = {
      schemaVersion: 1, serviceId: p.serviceId, requestId: salt32(), nonce: salt32(), requesterKey: this.signer.address,
      responseEncryptionKeyHash: keccak256(this.hpke.publicKey), requestCommitment: requestCommitment(envelope), expiresAtBlock: currentBlock + ttlBlocks,
    };
    const signature = await signTyped(this.signer, p, "Request", request);
    const sealedEnvelope = await seal(institutionHpkePub, utf8.enc(JSON.stringify(envelope)), request.requestId);
    return { request, signature, envelope, sealedEnvelope };
  }

  /** Decrypt a decision envelope and check the institution's signature before trusting it. */
  async receive(p: ProtocolProfile, sealed: Sealed, institution: Hex): Promise<{ record: DecisionRecord; signature: Hex }> {
    const { record, signature } = JSON.parse(utf8.dec(await open(this.hpke.privateKey, sealed)), bigintReviver);
    if (!(await verifyTyped(p, "DecisionRecord", record, signature, institution as Address))) throw new Error("decision signature invalid");
    return { record, signature };
  }

  async ack(p: ProtocolProfile, record: DecisionRecord) {
    const ack: Ack = { requestId: record.requestId, decisionDigest: decisionDigest(p, record), ackNonce: salt32() };
    return { ack, signature: await signTyped(this.signer, p, "Ack", ack) };
  }
}
