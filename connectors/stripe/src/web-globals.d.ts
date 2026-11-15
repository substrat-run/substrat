// Web-standard everywhere this runs (Node, Workers); declared here so the connector pulls in
// no platform typings, exactly as the other connectors do. Only the members this package calls
// are declared.

interface CryptoKey {
  readonly type: string;
}

declare const crypto: {
  subtle: {
    importKey(format: 'raw', data: Uint8Array, algorithm: object, extractable: boolean, usages: string[]): Promise<CryptoKey>;
    sign(algorithm: string | object, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
  getRandomValues<T extends Uint8Array>(array: T): T;
};

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
// The default `sleep` only. Every caller inside the platform injects its own, and a test always does.
declare const setTimeout: (handler: () => void, timeout: number) => unknown;
