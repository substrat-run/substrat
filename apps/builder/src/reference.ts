/**
 * The reference vertical every host hands the generator (`GeneratorInput.reference`):
 * the `create-substrat` template, relative to the platform checkout. It is the
 * one complete vertical that is compiled against the workspace on every PR
 * (#878), so copying from it cannot teach an API that no longer exists — the
 * failure skill prose has, and the reason it is code and not a skill.
 */
export const REFERENCE_DIR = 'packages/create-substrat/template';
