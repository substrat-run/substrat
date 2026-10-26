// Web-standard everywhere this runs (Node, Workers); declared here so the connector pulls in no
// platform typings, as the other connectors do. Only the members this package calls are declared.

declare const crypto: {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
  getRandomValues<T extends Uint8Array>(array: T): T;
};

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
