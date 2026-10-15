/** The kind module the uploader substitutes for this specifier (#2289). Any class may be exported. */
declare module '__SUBSTRAT_STORE_KIND__' {
  const kind: Record<string, unknown>;
  export = kind;
}
