// Web-standard everywhere this runs (Node, Workers); declared here so the connector pulls in
// no platform typings, exactly as the other connectors do with their `declare const`s. Only
// the members this package calls are declared.

interface CryptoKey {
  readonly type: string;
}
interface CryptoKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

declare const crypto: {
  subtle: {
    generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<CryptoKeyPair | CryptoKey>;
    exportKey(format: 'spki' | 'pkcs8', key: CryptoKey): Promise<ArrayBuffer>;
    importKey(format: 'pkcs8', data: Uint8Array, algorithm: object, extractable: boolean, usages: string[]): Promise<CryptoKey>;
    sign(algorithm: string | object, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
  getRandomValues<T extends Uint8Array>(array: T): T;
  randomUUID(): string;
};

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const AbortSignal: { timeout(ms: number): unknown };
declare function btoa(data: string): string;
declare function atob(data: string): string;

declare class URL {
  constructor(url: string, base?: string);
  readonly hostname: string;
  readonly pathname: string;
}

declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  set(name: string, value: string): void;
  toString(): string;
}
