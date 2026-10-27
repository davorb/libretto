// A two-page app for trying Libretto end to end. No dependencies.
//
//   ALICE_PASSWORD=secret node examples/login/server.mjs            # healthy app
//   BREAK_APP=1 ALICE_PASSWORD=secret node examples/login/server.mjs # welcome text is wrong
//
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 3000)
const password = process.env.ALICE_PASSWORD
if (!password) {
  console.error('Set ALICE_PASSWORD.')
  process.exit(2)
}
const broken = process.env.BREAK_APP === '1'

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

const loginForm = (error) =>
  page(
    'Log in',
    `<h1>Log in</h1>
    ${error ? `<p role="alert">${error}</p>` : ''}
    <form method="post" action="/login">
      <label>Username <input name="username" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Log in</button>
    </form>`,
  )

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, html) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) return send(200, loginForm(null))
  if (req.method === 'POST' && url.pathname === '/login') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const form = new URLSearchParams(body)
      const ok = form.get('username') === 'alice' && form.get('password') === password
      if (!ok) return send(401, loginForm('Invalid credentials'))
      const greeting = broken ? 'Hello, user' : 'Welcome, alice'
      send(200, page('Home', `<h1>${greeting}</h1><p>You are logged in.</p><a href="/login">Log out</a>`))
    })
    return
  }
  send(404, page('Not found', '<h1>Not found</h1>'))
}).listen(port, '127.0.0.1', () => console.log(`example app on http://127.0.0.1:${port}/ ${broken ? '(BROKEN)' : ''}`))
