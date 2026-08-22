import { useEffect, useState } from 'react';
import { api, type Price } from '../api';

// Display-only decimal helpers (string in, string out — no floats, matching
// the platform rule that money is decimal strings end to end).
const DECIMAL = /^\d+(\.\d+)?$/;

function mulDecimal(a: string, b: string): string {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = af.length + bf.length;
  const digits = (BigInt(ai + af) * BigInt(bi + bf)).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function compareDecimal(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const an = BigInt(ai + af.padEnd(scale, '0'));
  const bn = BigInt(bi + bf.padEnd(scale, '0'));
  return an === bn ? 0 : an > bn ? 1 : -1;
}

/**
 * Price-list management (spec/views.md §1.5, v0 simple): editable table plus
 * the "test article price" simulator — pick article + qty, see the priced
 * result and which rule produced it (same rules as priced completion:
 * min-qty applied, internal articles dropped).
 */
export function PricesView() {
  const [prices, setPrices] = useState<Price[] | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  // Upsert form: clicking a row loads it; "Ny artikel" clears it.
  const [article, setArticle] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState('');
  const [priceAmount, setPriceAmount] = useState('');
  const [minQty, setMinQty] = useState('');
  const [internal, setInternal] = useState(false);
  // Simulator.
  const [simArticle, setSimArticle] = useState('');
  const [simQty, setSimQty] = useState('1');

  const load = () => {
    api.priceList().then((page) => setPrices(page.entries)).catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const edit = (p: Price) => {
    setArticle(p.article);
    setDescription(p.description);
    setUnit(p.unit);
    setPriceAmount(p.price_amount);
    setMinQty(p.min_qty ?? '');
    setInternal(p.internal === 1);
    setSaved('');
  };

  const clear = () => {
    setArticle('');
    setDescription('');
    setUnit('');
    setPriceAmount('');
    setMinQty('');
    setInternal(false);
    setSaved('');
  };

  const valid =
    article && description && unit && DECIMAL.test(priceAmount) && (!minQty || DECIMAL.test(minQty));

  const save = async () => {
    setError('');
    try {
      await api.upsertPrice({
        article,
        description,
        unit,
        priceAmount,
        ...(minQty ? { minQty } : {}),
        internal,
      });
      setSaved(article);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !prices) return <div className="alert error">{error}</div>;
  if (!prices) return <p className="muted">Laddar…</p>;

  const sim = prices.find((p) => p.article === simArticle);
  let simResult: { rule: string; detail: string } | null = null;
  if (sim && DECIMAL.test(simQty)) {
    if (sim.internal === 1) {
      simResult = {
        rule: 'Intern artikel — faktureras ej',
        detail: 'Raden tas bort vid prissatt slutförande.',
      };
    } else {
      const minApplied = sim.min_qty !== null && compareDecimal(simQty, sim.min_qty) < 0;
      const billedQty = minApplied ? sim.min_qty! : simQty;
      const total = mulDecimal(billedQty, sim.price_amount);
      simResult = {
        rule: minApplied
          ? `Minsta debitering ${sim.min_qty} ${sim.unit} tillämpad`
          : 'Rapporterat antal debiteras',
        detail: `${billedQty} ${sim.unit} × ${sim.price_amount} ${sim.currency} = ${total} ${sim.currency}`,
      };
    }
  }

  return (
    <>
      <h1>Prislista</h1>
      <p className="sub">
        Prissättningen är vertikalens — minsta debitering och interna artiklar tillämpas i
        prissatta slutförandet, aldrig i motorn.
      </p>
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>
            Artikel — {prices.some((p) => p.article === article) ? 'redigera' : 'ny'}
          </h2>
          <button className="btn" onClick={clear}>
            Ny artikel
          </button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            style={{ width: 160 }}
            placeholder="Artikel"
            value={article}
            onChange={(e) => setArticle(e.target.value)}
          />
          <input
            className="grow"
            placeholder="Beskrivning"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            style={{ width: 60 }}
            placeholder="Enhet"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
          <input
            style={{ width: 90 }}
            placeholder="Pris"
            value={priceAmount}
            onChange={(e) => setPriceAmount(e.target.value)}
          />
          <input
            style={{ width: 90 }}
            placeholder="Min-antal"
            value={minQty}
            onChange={(e) => setMinQty(e.target.value)}
          />
          <label className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
            />
            intern
          </label>
          <button className="btn primary" disabled={!valid} onClick={save}>
            Spara
          </button>
        </div>
        {saved && <div className="alert info" style={{ marginTop: 12 }}>Sparad: {saved}</div>}
      </div>

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>Artikel</th>
              <th>Beskrivning</th>
              <th>Enhet</th>
              <th className="right">Pris</th>
              <th className="right">Min-antal</th>
              <th>Intern</th>
            </tr>
          </thead>
          <tbody>
            {prices.map((p) => (
              <tr key={p.article} className="click" onClick={() => edit(p)}>
                <td>{p.article}</td>
                <td>{p.description}</td>
                <td className="muted">{p.unit}</td>
                <td className="num">
                  {p.price_amount} {p.currency}
                </td>
                <td className="num">{p.min_qty ?? '—'}</td>
                <td>{p.internal === 1 ? <span className="pill planned">intern</span> : ''}</td>
              </tr>
            ))}
            {prices.length === 0 && (
              <tr>
                <td className="muted" colSpan={6}>
                  Inga artiklar ännu.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Testa artikelpris</h2>
        <div className="row">
          <select value={simArticle} onChange={(e) => setSimArticle(e.target.value)}>
            <option value="">Välj artikel…</option>
            {prices.map((p) => (
              <option key={p.article} value={p.article}>
                {p.article} — {p.description}
              </option>
            ))}
          </select>
          <input style={{ width: 70 }} value={simQty} onChange={(e) => setSimQty(e.target.value)} />
          {simResult && (
            <span>
              <strong>{simResult.rule}.</strong>{' '}
              <span className="muted">{simResult.detail}</span>
            </span>
          )}
          {sim && !DECIMAL.test(simQty) && <span className="muted">Ange ett antal, t.ex. 1.5</span>}
        </div>
      </div>
    </>
  );
}
