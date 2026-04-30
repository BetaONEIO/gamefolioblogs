#!/usr/bin/env node
// One-time helper to mint a Google OAuth refresh token for the TikTok sync.
//
// Usage:
//   1) In Google Cloud Console (the same project as the SA), create an OAuth
//      client of type "Desktop app". Note the client ID and client secret.
//      Add an "Authorized redirect URI": http://127.0.0.1:53231/callback
//   2) On the OAuth consent screen, ensure the Google account you want the
//      bot to act as is listed under Test users (if the app is in Testing).
//   3) Run:
//        OAUTH_CLIENT_ID=... OAUTH_CLIENT_SECRET=... node scripts/get-oauth-token.js
//   4) Open the printed URL, sign in with the target Google account, consent,
//      and your refresh token will be printed in this terminal.
//   5) Save it as the OAUTH_REFRESH_TOKEN repo secret.

const http = require('node:http');
const { URL } = require('node:url');
const { google } = require('googleapis');

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const PORT = 53231;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET in env first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
});

console.log('Open this URL in your browser, sign in, and approve:\n');
console.log(authUrl, '\n');
console.log(`Waiting for redirect on ${REDIRECT_URI} …`);

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (u.pathname !== '/callback') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) {
      res.statusCode = 400;
      res.end('Missing code');
      return;
    }
    const { tokens } = await oauth2.getToken(code);
    res.end('Done. You can close this tab and return to the terminal.');
    console.log('\n=== refresh_token ===\n');
    console.log(tokens.refresh_token);
    console.log('\nCopy that into your repo secret OAUTH_REFRESH_TOKEN.');
    server.close();
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end('Error — check terminal');
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1');
