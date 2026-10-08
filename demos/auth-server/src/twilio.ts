/** Twilio Verify transport shared by Node and workerd; no Node SDK is needed. */
export interface PhoneVerifier {
  send(phone: string): Promise<void>;
  check(phone: string, code: string): Promise<boolean>;
}

export function twilioFrom(
  cfg: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): PhoneVerifier | undefined {
  const account = cfg.TWILIO_ACCOUNT_SID?.trim();
  const token = cfg.TWILIO_AUTH_TOKEN?.trim();
  const service = cfg.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (!account || !token || !service) {
    if (account || token || service) console.warn('SMS verification disabled: incomplete Twilio configuration; configure all three settings');
    return undefined;
  }
  if (!/^AC[0-9a-f]{32}$/i.test(account) || !/^VA[0-9a-f]{32}$/i.test(service)) {
    throw new Error('Invalid Twilio account or Verify service SID');
  }
  const request = async (path: string, fields: Record<string, string>) => {
    const response = await fetcher(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${account}:${token}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
      // workerd supports manual/follow, not error. A redirect is a non-ok response
      // below, so credentials are never forwarded to a different endpoint.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // Twilio removes expired/consumed verifications; neither proves possession.
    if (path === 'VerificationCheck' && response.status === 404) return { status: 'expired' };
    if (!response.ok) throw new Error('Phone verification is unavailable. Please try again later.');
    return await response.json() as { status?: string };
  };
  return {
    async send(phone) {
      const result = await request('Verifications', { To: phone, Channel: 'sms' });
      if (result.status !== 'pending') throw new Error('Phone verification could not be started.');
    },
    async check(phone, code) {
      return (await request('VerificationCheck', { To: phone, Code: code })).status === 'approved';
    },
  };
}

/** A broken optional SMS configuration must not disable other sign-in methods. */
export function optionalTwilioFrom(cfg: Record<string, string | undefined>): PhoneVerifier | undefined {
  try {
    return twilioFrom(cfg);
  } catch {
    console.error('SMS verification disabled: invalid Twilio account or Verify service SID');
    return undefined;
  }
}
