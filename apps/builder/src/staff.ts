import { emailRefusalMessage, identifyEmail, type EmailIdentityEnv, type EmailRefusal, type SessionUser } from '@substrat-run/oidc-rp';

export interface StaffEnv extends EmailIdentityEnv {
	/** The control plane's auth DB — read-only roster lookups, never writes. */
	AUTH_DB: D1Database;
}

/**
 * Whether a session is platform staff — the same table, and the same fail-closed
 * semantics, as the control plane's roster. The roster keys on the address, so only an
 * address the issuer verified is looked up (#1359); anything else is simply not staff,
 * and the team path in the gate still applies. `refused` says why an address was never
 * looked up, so the gate can tell the person what to do about it.
 */
export async function staffAccessOf(
	env: StaffEnv,
	user: SessionUser,
): Promise<{ staff: boolean; refused?: EmailRefusal }> {
	const identity = identifyEmail(env, user);
	if (!identity.email) return { staff: false, refused: identity.refused };
	const row = await env.AUTH_DB.prepare(
		'SELECT actor FROM staff_actor WHERE email = ? AND revoked_at IS NULL',
	)
		.bind(identity.email.toLowerCase())
		.first<{ actor: string }>();
	return { staff: row !== null };
}

/** The 403 sentence for someone with no studio access. An address the roster never got
 * to look up says so: for a session minted before the claim was carried, signing in
 * again is the whole fix. Still names the email, never the app. */
export function deniedDetail(user: SessionUser, refused: EmailRefusal | undefined): string {
	const who = user.email ?? 'this account';
	return refused === 'unasserted' || refused === 'unverified'
		? `The builder studio could not check ${who}: ${emailRefusalMessage(refused)}.`
		: `The builder studio is not enabled for ${who}'s team yet.`;
}
