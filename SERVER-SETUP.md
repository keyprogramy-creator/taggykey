# Authoritative multiplayer server

`woah.html` now connects to the WebSocket server instead of connecting browsers directly to one another.

## Run it

1. Install Node.js 18 or newer.
2. Open PowerShell in this folder.
3. Install dependencies with `npm install`.
4. Set a private HMAC secret: `$env:AUTH_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`.
5. Run `npm start`.
6. Open `http://localhost:8080` in each browser window.

The server owns player IDs and accepted positions. Clients submit movement proposals; the server rejects invalid coordinates, excessive movement, invalid names/rooms, oversized messages, and excessive message rates before broadcasting snapshots. Each player receives a server-issued HMAC-SHA256 session token, and movement messages without a valid token are rejected. The HMAC key never enters browser code.

For internet play, deploy `server.js` behind HTTPS and use `wss://`. Never put `AUTH_SECRET` in browser code or commit it to source control. The browser receives only a signed session token; the signing key remains server-side.

The easiest deployment is Render: create a new Blueprint from this repository and select `render.yaml`. It runs `npm install`, starts `npm start`, and generates `AUTH_SECRET` privately. The same Render service serves the page and accepts WebSocket connections, so no URL replacement is needed. Render's free plan may sleep when unused, which can make the first connection take a little longer.

Vercel can still host the static page separately by setting `window.GAME_SERVER_URL` to the Render `wss://` URL, but the one-service Render setup is simpler for this project.
