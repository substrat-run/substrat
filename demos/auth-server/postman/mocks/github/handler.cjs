// GitHub's documented token, profile and email-list shapes. Synthetic identities only.
// The OAuth code selects a fixture; unknown paths fail rather than inventing an endpoint.
module.exports = async function handler(req, res) {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const path = new URL(req.url, 'http://mock.test').pathname;
  if (path === '/login/oauth/access_token' && req.method === 'POST') {
    // Postman's interceptor has already read the stream and exposes req.body.
    let body = req.body;
    if (body === undefined) {
      body = '';
      for await (const chunk of req) body += chunk;
    }
    const code = body && typeof body === 'object' && !Buffer.isBuffer(body) ? body.code
      : req.headers['content-type']?.includes('application/json') ? JSON.parse(String(body)).code
      : new URLSearchParams(String(body)).get('code');
    if (!['forbidden', 'unauthorized', 'empty', 'success', 'profile-exception', 'invalid-code'].includes(code)) {
      return send(400, { error: 'unknown_fixture_code' });
    }
    if (code === 'invalid-code') return send(200, { error: 'bad_verification_code' });
    return send(200, { access_token: `fixture-${code}-secret`, token_type: 'bearer', scope: 'read:user,user:email' });
  }
  if (path === '/user') {
    if ((req.headers.authorization || '').includes('profile-exception')) return send(200, null);
    return send(200, { id: 12345, login: 'demo-user', name: 'Demo User', email: null });
  }
  if (path === '/user/emails') {
    const token = req.headers.authorization || '';
    if (token.includes('forbidden')) return send(403, { message: 'sensitive-upstream-body' });
    if (token.includes('unauthorized')) return send(401, { message: 'sensitive-upstream-body' });
    if (token.includes('empty')) return send(200, [], { 'x-oauth-scopes': 'read:user' });
    return send(200, [{ email: 'private@example.test', primary: true, verified: true, visibility: 'private' }]);
  }
  return send(501, { message: 'Endpoint not modeled' });
};
