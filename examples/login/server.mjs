// A small app for trying Libretto end to end. No dependencies.
//
//   ALICE_PASSWORD=secret node examples/login/server.mjs                 # healthy app
//   BREAK_APP=1 ALICE_PASSWORD=secret node examples/login/server.mjs     # regression: greeting is wrong
//   APP_VARIANT=signin ALICE_PASSWORD=secret node examples/login/server.mjs  # legitimate change: button says "Sign in"
//
// Routes: GET /login (also /) shows the form. POST /login sets a session cookie and
// redirects to /home, or re-renders the form with an alert. GET /home needs the cookie.
// GET /logout clears it and redirects to /login.
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 3000)
const password = process.env.ALICE_PASSWORD
if (!password) {
  console.error('Set ALICE_PASSWORD.')
  process.exit(2)
}
const broken = process.env.BREAK_APP === '1'
const buttonLabel = process.env.APP_VARIANT === 'signin' ? 'Sign in' : 'Log in'

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

const loginForm = (error) =>
  page(
    buttonLabel,
    `<h1>${buttonLabel}</h1>
    ${error ? `<p role="alert">${error}</p>` : ''}
    <form method="post" action="/login">
      <label>Username <input name="username" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">${buttonLabel}</button>
    </form>`,
  )

const home = () =>
  page('Home', `<h1>${broken ? 'Hello, user' : 'Welcome, alice'}</h1><p>You are logged in.</p><a href="/logout">Log out</a>`)

const hasSession = (req) => /(^|;\s*)session=alice(;|$)/.test(req.headers.cookie ?? '')

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, html, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(html)
  }
  const redirect = (to, headers = {}) => {
    res.writeHead(302, { location: to, ...headers })
    res.end()
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) return send(200, loginForm(null))
  if (req.method === 'GET' && url.pathname === '/home') return hasSession(req) ? send(200, home()) : redirect('/login')
  if (req.method === 'GET' && url.pathname === '/logout') return redirect('/login', { 'set-cookie': 'session=; Max-Age=0; Path=/' })
  if (req.method === 'POST' && url.pathname === '/login') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const form = new URLSearchParams(body)
      const ok = form.get('username') === 'alice' && form.get('password') === password
      if (!ok) return send(401, loginForm('Invalid credentials'))
      redirect('/home', { 'set-cookie': 'session=alice; Path=/; HttpOnly' })
    })
    return
  }
  send(404, page('Not found', '<h1>Not found</h1>'))
}).listen(port, '127.0.0.1', () =>
  console.log(`example app on http://127.0.0.1:${port}/ ${broken ? '(BROKEN)' : ''}${buttonLabel !== 'Log in' ? ` (button: ${buttonLabel})` : ''}`),
)
