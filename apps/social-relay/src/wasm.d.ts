/** A `.wasm` import, which wrangler's bundler hands over already compiled. */
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
