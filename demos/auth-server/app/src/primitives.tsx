/*
 * The little building blocks both surfaces share.
 *
 * They are deliberately NOT `@substrat-run/ui` components: `Centered`, `Card` and `Field`
 * are what the sign-in, sign-up, consent and reset screens are made of, and those screens
 * are themed per relying party through `tokens.css`. Drawing them with the Substrat
 * primitives would put Substrat's identity in front of a person signing into a customer's
 * app, which is exactly the boundary #1278 draws. The branded set is used in `console/`.
 */

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>;
}

export function Card({ title, logo, children }: { title: string; logo?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      {/* alt="" — the logo repeats the title visually; announcing it twice helps nobody. */}
      {logo && <img className="brand-logo" src={logo} alt="" />}
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export function Field({
  label, value, onChange, type = 'text', hint, disabled, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
      />
      {hint && <em className="hint">{hint}</em>}
    </label>
  );
}
