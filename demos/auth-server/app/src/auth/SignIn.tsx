import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  bankidCancel,
  bankidCollect,
  bankidQr,
  bankidStart,
  requestPasswordReset,
  signIn,
  signInSocial,
  type BankIdStart,
  type ClientTheme,
  type PublicProvider,
} from '../api';
import { Centered, Card, Field } from '../primitives';

export function SignIn({
  onDone, signupEnabled, oauthQuery, onSignUp, providers, socialError, theme,
}: {
  onDone: () => void;
  signupEnabled: boolean;
  oauthQuery: string | null;
  onSignUp: () => void;
  providers: PublicProvider[];
  socialError: string | null;
  theme: ClientTheme;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(socialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [bankidOpen, setBankidOpen] = useState(false);
  // A signed authorize query ⇒ a relying party sent this person here, not an operator opening
  // the console. Same form either way, but promising the dashboard would be a lie about where
  // they end up.
  const forOidc = oauthQuery !== null;
  // BankID is in the same providers list but is not a redirect: the browser stays here while
  // the person approves in the app, so its button opens a screen instead of leaving.
  if (bankidOpen) {
    return <BankIdSignIn oauthQuery={oauthQuery} theme={theme} onDone={onDone} onBack={() => setBankidOpen(false)} />;
  }
  return (
    <Centered>
      <Card title={theme.title ?? 'Substrat Auth'} logo={theme.logoUrl}>
        <p className="muted">
          {forOidc ? 'Sign in to continue to the application that sent you here.' : 'Sign in to the admin dashboard.'}
        </p>
        {providers.length > 0 && (
          <div className="providers">
            {providers.map((provider) => (
              <button
                key={provider.id}
                className="btn"
                onClick={async () => {
                  setErr(null);
                  if (provider.id === 'bankid') return setBankidOpen(true);
                  try {
                    // Nothing follows: the response is a redirect to the provider and the
                    // browser client follows it. The pending authorize request goes along.
                    await signInSocial(provider.id, oauthQuery);
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Continue with {provider.label}
              </button>
            ))}
            <div className="or"><span>or</span></div>
          </div>
        )}
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Password" value={password} onChange={setPassword} type="password" />
        {err && <p className="error">{err}</p>}
        {notice && <p className="notice">{notice}</p>}
        <button
          className="btn primary"
          onClick={async () => {
            setErr(null);
            try {
              // `resumed` ⇒ an authorize request took over and the browser is already on its
              // way back to the relying party; re-rendering here would flash the dashboard.
              const { resumed } = await signIn(email, password, oauthQuery);
              if (!resumed) onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Sign in
        </button>
        <button
          className="btn link"
          onClick={async () => {
            setErr(null);
            setNotice(null);
            if (!email) return setErr('Enter your email first, then request a reset.');
            try {
              await requestPasswordReset(email);
              setNotice('If that email has an account, a reset link is on its way.');
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Forgot password?
        </button>
        {signupEnabled && (
          <button className="btn link" onClick={onSignUp}>
            Create an account
          </button>
        )}
      </Card>
    </Centered>
  );
}

/**
 * What each BankID `hintCode` means, in the words of the person waiting. An unknown code
 * falls back to the scan instruction while pending and a plain failure once failed —
 * BankID adds codes over time, and an unmapped one must degrade to something true.
 */
const BANKID_HINTS: Record<string, string> = {
  outstandingTransaction: 'Open the BankID app and scan the QR code.',
  noClient: 'Open the BankID app and scan the QR code.',
  started: 'Looking for your BankID…',
  userSign: 'Confirm with your security code in the BankID app.',
  userCancel: 'The sign-in was cancelled in the BankID app.',
  expiredTransaction: 'The BankID sign-in timed out. Start again.',
  certificateErr: 'This BankID is blocked or invalid. Contact your bank.',
  startFailed: 'The BankID app could not be reached. Start again.',
};

/**
 * The BankID flow, in one screen: an order is started on mount, the animated QR re-draws
 * every second (each frame fetched from the issuer — the code is computed there), and
 * `collect` polls every two seconds until the order completes, fails, or the person leaves.
 * Same-device sign-in is the `autoStartUrl` link; the polling picks the session up either way.
 *
 * Completing IS signing in — the collect response set the session cookie — and a pending
 * authorize request resumes exactly as the password path resumes: the issuer answers the
 * completing poll with the redirect envelope, and this navigates to the relying party.
 * Leaving the screen with the order still open cancels it at BankID rather than letting it
 * sit approvable for three more minutes.
 */
function BankIdSignIn({
  oauthQuery, theme, onDone, onBack,
}: { oauthQuery: string | null; theme: ClientTheme; onDone: () => void; onBack: () => void }) {
  const [order, setOrder] = useState<BankIdStart | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [hint, setHint] = useState('Open the BankID app and scan the QR code.');
  const [err, setErr] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** Set once the flow settled (session made, or redirect leaving) — the unmount cleanup
   *  must not cancel an order that just succeeded. */
  const settled = useRef(false);
  const liveOrder = useRef<string | null>(null);

  const begin = useCallback(async () => {
    setErr(null);
    setFailed(false);
    setHint('Open the BankID app and scan the QR code.');
    try {
      const started = await bankidStart();
      liveOrder.current = started.orderRef;
      setOrder(started);
      setQrImage(await QRCode.toDataURL(started.qr, { margin: 1, width: 208 }));
    } catch (e) {
      setFailed(true);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void begin();
    return () => {
      if (!settled.current && liveOrder.current) void bankidCancel(liveOrder.current);
    };
  }, [begin]);

  // A fresh QR frame every second — the animated code, per BankID's guidelines.
  useEffect(() => {
    if (!order || failed) return;
    const timer = setInterval(async () => {
      try {
        setQrImage(await QRCode.toDataURL(await bankidQr(order.orderRef), { margin: 1, width: 208 }));
      } catch {
        // The order is gone (completed or expired) — the collect poll is the one that says so.
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [order, failed]);

  // Poll collect every two seconds — the API's own guidance, and specifically not faster.
  useEffect(() => {
    if (!order || failed) return;
    const timer = setInterval(async () => {
      try {
        const result = await bankidCollect(order.orderRef, oauthQuery);
        if ('redirect' in result && result.redirect && result.url) {
          // An authorize request resumed — the browser belongs to the relying party now.
          settled.current = true;
          window.location.href = result.url;
          return;
        }
        const poll = result as { status: string; hintCode: string | null };
        if (poll.status === 'complete') {
          settled.current = true;
          onDone();
        } else if (poll.status === 'failed') {
          setFailed(true);
          setHint(BANKID_HINTS[poll.hintCode ?? ''] ?? 'The sign-in failed. Start again.');
        } else if (poll.hintCode) {
          setHint(BANKID_HINTS[poll.hintCode] ?? 'Open the BankID app and scan the QR code.');
        }
      } catch (e) {
        // A refusal with words (no account linked, banned) — show it and stop polling.
        setFailed(true);
        setErr(e instanceof Error ? e.message : String(e));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [order, failed, oauthQuery, onDone]);

  return (
    <Centered>
      <Card title="Sign in with BankID" logo={theme.logoUrl}>
        {!failed && qrImage && (
          <div className="bankid-qr">
            <img src={qrImage} alt="BankID QR code" width={208} height={208} />
          </div>
        )}
        {!failed && <p className="muted">{hint}</p>}
        {failed && !err && <p className="error">{hint}</p>}
        {err && <p className="error">{err}</p>}
        {!failed && order && (
          <a className="btn" href={order.autoStartUrl}>
            Open BankID on this device
          </a>
        )}
        {failed && (
          <button className="btn primary" onClick={() => void begin()}>
            Try again
          </button>
        )}
        <button
          className="btn link"
          onClick={() => {
            if (!settled.current && liveOrder.current) void bankidCancel(liveOrder.current);
            liveOrder.current = null;
            onBack();
          }}
        >
          Back
        </button>
      </Card>
    </Centered>
  );
}
