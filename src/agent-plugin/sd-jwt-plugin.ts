import { type Jwt, SDJwt } from '@sd-jwt/core';
import { SDJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import type { Signer, Verifier, KbVerifier, JwtPayload } from '@sd-jwt/types';
import type { DIDDocument, IAgentPlugin } from '@veramo/core-types';
import schema from '../plugin.schema.json' assert { type: 'json' };
import type { SdJWTImplementation } from './sd-jwt-implementation';
import type {
  ICreateSdJwtVcArgs,
  ICreateSdJwtVcResult,
  ICreateSdJwtVcPresentationArgs,
  ICreateSdJwtVcPresentationResult,
  IRequiredContext,
  ISDJwtPlugin,
  IVerifySdJwtVcArgs,
  IVerifySdJwtVcResult,
  IVerifySdJwtVcPresentationArgs,
  IVerifySdJwtVcPresentationResult,
} from '../types/ISDJwtPlugin.js';
import { mapIdentifierKeysToDocWithJwkSupport } from '@sphereon/ssi-sdk-ext.did-utils';
import { encodeJoseBlob } from '@veramo/utils';
import type { VerificationMethod } from 'did-resolver';

/**
 * SD-JWT plugin for Veramo
 * @public
 */
export class SDJwtPlugin implements IAgentPlugin {
  readonly schema = schema.ISDJwtPlugin;

  constructor(private algorithms: SdJWTImplementation) {}

  // map the methods your plugin is declaring to their implementation
  readonly methods: ISDJwtPlugin = {
    createSdJwtVc: this.createSdJwtVc.bind(this),
    createSdJwtVcPresentation: this.createSdJwtVcPresentation.bind(this),
    verifySdJwtVc: this.verifySdJwtVc.bind(this),
    verifySdJwtVcPresentation: this.verifySdJwtVcPresentation.bind(this),
  };

  /**
   * Create a signed SD-JWT credential.
   * @param args - Arguments necessary for the creation of a SD-JWT credential.
   * @param context - This reserved param is automatically added and handled by the framework, *do not override*
   * @returns A signed SD-JWT credential.
   */
  async createSdJwtVc(
    args: ICreateSdJwtVcArgs,
    context: IRequiredContext,
  ): Promise<ICreateSdJwtVcResult> {
    const issuer = args.credentialPayload.iss;
    if (!issuer) {
      throw new Error('credential.issuer must not be empty');
    }
    if (issuer.split('#').length === 1) {
      throw new Error('credential.issuer must reference a key');
    }
    const { alg, key } = await this.getSignKey(issuer, context);

    //TODO: let the user also insert a method to sign the data
    const signer: Signer = async (data: string) =>
      context.agent.keyManagerSign({ keyRef: key.kid, data });

    const sdjwt = new SDJwtVcInstance({
      signer,
      hasher: this.algorithms.hasher,
      saltGenerator: this.algorithms.saltGenerator,
      signAlg: alg,
      hashAlg: 'SHA-256',
    });

    const credentialJwt = await sdjwt.issue(
      args.credentialPayload,
      args.disclosureFrame,
    );

    const decodedCredential = await sdjwt.decode(credentialJwt);

    const preparedCredential = {
      ...decodedCredential.jwt?.payload,
      signature: decodedCredential.jwt?.signature,
      encoded: credentialJwt,
      disclosures: decodedCredential.disclosures,
    };

    return { credential: preparedCredential };
  }

  /**
   * Get the key to sign the SD-JWT
   * @param issuer - did url like did:exmaple.com#key-1
   * @param context - agent instance
   * @returns the key to sign the SD-JWT
   */
  private async getSignKey(issuer: string, context: IRequiredContext) {
    const identifier = await context.agent.didManagerGet({
      did: issuer.split('#')[0],
    });
    const doc = await mapIdentifierKeysToDocWithJwkSupport(
      identifier,
      'assertionMethod',
      context,
    );
    if (!doc || doc.length === 0) throw new Error('No key found for signing');
    const key = doc.find((key) => {
      let didIssuer = issuer.split('#')[0];

      if (didIssuer.startsWith('did:jwk')) {
        didIssuer += '#0';
      }

      return key.meta.verificationMethod.id === didIssuer;
    });
    if (!key)
      throw new Error(`No key found with the given id: ${issuer || ''}`);
    let alg: string;
    //transform the key type to the alg
    switch (key.type) {
      case 'Ed25519':
        alg = 'EdDSA';
        break;
      case 'Secp256k1':
        alg = 'ES256K';
        break;
      case 'Secp256r1':
        alg = 'ES256';
        break;
      default:
        throw new Error(`unsupported key type ${key.type}`);
    }
    return { alg, key };
  }

  /**
   * Create a signed SD-JWT presentation.
   * @param args - Arguments necessary for the creation of a SD-JWT presentation.
   * @param context - This reserved param is automatically added and handled by the framework, *do not override*
   * @returns A signed SD-JWT presentation.
   */
  async createSdJwtVcPresentation(
    args: ICreateSdJwtVcPresentationArgs,
    context: IRequiredContext,
  ): Promise<ICreateSdJwtVcPresentationResult> {
    const cred = await SDJwt.fromEncode(
      args.presentation,
      this.algorithms.hasher,
    );
    const claims = await cred.getClaims<JwtPayload>(this.algorithms.hasher);
    let holderDID: string;
    // we primarly look for a cnf field, if it's not there we look for a sub field. If this is also not given, we throw an error since we can not sign it.
    if (claims.cnf?.jwk) {
      const key = claims.cnf.jwk;
      holderDID = `did:jwk:${encodeJoseBlob(key)}#0`;
    } else if (claims.sub) {
      holderDID = claims.sub as string;
    } else {
      throw new Error('credential does not include a holder reference');
    }
    const { alg, key } = await this.getSignKey(holderDID, context);

    const signer: Signer = async (data: string) => {
      return context.agent.keyManagerSign({ keyRef: key.kid, data });
    };

    const sdjwt = new SDJwtVcInstance({
      hasher: this.algorithms.hasher,
      saltGenerator: this.algorithms.saltGenerator,
      kbSigner: signer,
      kbSignAlg: alg,
    });

    console.log('-----> presentation (encoded vc ->> ', args.presentation);
    console.log('-----> presentationKeys', args.presentationKeys);

    const credential = await sdjwt.present(
      args.presentation,
      args.presentationKeys,
      { kb: args.kb },
    );
    return { presentation: credential };
  }

  /**
   * Verify a signed SD-JWT credential.
   * @param args - Arguments necessary for the verification of a SD-JWT credential.
   * @param context - This reserved param is automatically added and handled by the framework, *do not override*
   * @returns
   */
  async verifySdJwtVc(
    args: IVerifySdJwtVcArgs,
    context: IRequiredContext,
  ): Promise<IVerifySdJwtVcResult> {
    // biome-ignore lint/style/useConst: <explanation>
    let sdjwt: SDJwtVcInstance;
    const verifier: Verifier = async (data: string, signature: string) =>
      this.verify(sdjwt, context, data, signature);

    sdjwt = new SDJwtVcInstance({ verifier, hasher: this.algorithms.hasher });
    const verifiedPayloads = await sdjwt.verify(args.credential);

    return { verifiedPayloads };
  }

  /**
   * Verify the key binding of a SD-JWT by validating the signature of the key bound to the SD-JWT
   * @param sdjwt - SD-JWT instance
   * @param context - Agent context
   * @param data - data to be verified
   * @param signature - signature to be validated
   * @param payload - payload of the SD-JWT
   * @returns
   */
  private async verifyKb(
    sdjwt: SDJwtVcInstance,
    context: IRequiredContext,
    data: string,
    signature: string,
    payload: JwtPayload,
  ): Promise<boolean> {
    let key: JsonWebKey;
    if (payload.cnf) {
      key = payload.cnf.jwk as JsonWebKey;
    } else if (payload.sub) {
      const didUrl = payload.sub as string;
      const holderDId = await context.agent.resolveDid({ didUrl });
      const method = (
        (holderDId.didDocument as DIDDocument)
          .verificationMethod as VerificationMethod[]
      ).find((method) => method.id === didUrl);
      if (!method) {
        throw new Error('key could not be found in the did document');
      }
      key = method.publicKeyJwk as JsonWebKey;
    } else {
      throw new Error('no holder reference found in the payload');
    }
    return this.algorithms.verifySignature(data, signature, key);
  }

  /**
   * Validates the signature of a SD-JWT
   * @param sdjwt - SD-JWT instance
   * @param context - Agent context
   * @param data - data to be signed
   * @param signature - signature to be validated
   * @returns
   */
  async verify(
    sdjwt: SDJwtVcInstance,
    context: IRequiredContext,
    data: string,
    signature: string,
  ) {
    const decodedVC = await sdjwt.decode(`${data}.${signature}`);
    const issuer: string = (
      (decodedVC.jwt as Jwt).payload as Record<string, unknown>
    ).iss as string;
    if (!issuer.startsWith('did:')) {
      throw new Error('issuer must be a did');
    }
    const didDoc = await context.agent.resolveDid({ didUrl: issuer });
    if (!didDoc) {
      throw new Error('issuer did not resolve to a did document');
    }
    const didDocumentKey = didDoc.didDocument?.verificationMethod?.find(
      (key) => key.id,
    );
    if (!didDocumentKey) {
      throw new Error('issuer did document does not include referenced key');
    }
    //TODO: in case it's another did method, the value of the key can be also encoded as a base64url
    const key = didDocumentKey.publicKeyJwk as JsonWebKey;
    return this.algorithms.verifySignature(data, signature, key);
  }

  /**
   * Verify a signed SD-JWT presentation.
   * @param args - Arguments necessary for the verification of a SD-JWT presentation.
   * @param context - This reserved param is automatically added and handled by the framework, *do not override*
   * @returns
   */
  async verifySdJwtVcPresentation(
    args: IVerifySdJwtVcPresentationArgs,
    context: IRequiredContext,
  ): Promise<IVerifySdJwtVcPresentationResult> {
    // biome-ignore lint/style/useConst: <explanation>
    let sdjwt: SDJwtVcInstance;
    const verifier: Verifier = async (data: string, signature: string) =>
      this.verify(sdjwt, context, data, signature);
    const verifierKb: KbVerifier = async (
      data: string,
      signature: string,
      payload: JwtPayload,
    ) => this.verifyKb(sdjwt, context, data, signature, payload);
    sdjwt = new SDJwtVcInstance({
      verifier,
      hasher: this.algorithms.hasher,
      kbVerifier: verifierKb,
    });
    const verifiedPayloads = await sdjwt.verify(
      args.presentation,
      args.requiredClaimKeys,
      args.kb,
    );

    return { verifiedPayloads };
  }
}
