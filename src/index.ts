import { Hono, type Env as HonoEnv } from 'hono'
import { env } from 'hono/adapter'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { GitHub, ArcticFetchError, OAuth2RequestError } from 'arctic'

import { generateToken, verifyToken } from './csrf-token'

const DEFAULT_SITE_ID_LIST = ['localhost', '127.0.0.1']

interface AppEnv extends HonoEnv {
  Bindings: Env
  Variables: {
    github: GitHub
  }
}

const githubAuthMiddleware = createMiddleware<AppEnv>(async (ctx, next) => {
  ctx.set(
    'github',
    new GitHub(
      env(ctx).GITHUB_OAUTH_ID,
      env(ctx).GITHUB_OAUTH_SECRET,
      new URL('/callback', ctx.req.url).href
    )
  )
  await next()
  const err = ctx.error
  if (err instanceof OAuth2RequestError) {
    throw new HTTPException(400, { message: 'Invalid code', cause: err })
  }
  if (err instanceof ArcticFetchError) {
    throw new HTTPException(500, { message: 'Network error', cause: err })
  }
})

const app = new Hono<AppEnv>()

app.onError((err, ctx) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  } else {
    return ctx.body('Internal Server Error', 500)
  }
})

app.get('/auth', githubAuthMiddleware, async ctx => {
  const allowSiteIdList = [
    ...env(ctx).ALLOW_SITE_ID_LIST.trim().split(','),
    ...DEFAULT_SITE_ID_LIST,
  ]
  const { site_id, provider, scope } = ctx.req.query()
  const refererHost = URL.parse(ctx.req.header('Referer') ?? '')?.hostname
  if (!refererHost || !allowSiteIdList.includes(refererHost)) {
    throw new HTTPException(400, { message: 'Invalid referer' })
  }
  if (!site_id || !allowSiteIdList.includes(site_id)) {
    throw new HTTPException(400, { message: 'Invalid site_id' })
  }
  if (provider !== 'github') {
    throw new HTTPException(400, { message: 'Invalid provider' })
  }
  const state = await generateToken(env(ctx).SECRET)
  setCookie(ctx, 'auth-state', state, {
    prefix: 'secure',
    secure: true,
    sameSite: 'Lax',
    path: '/callback',
    maxAge: 3 * 60,
  })
  return ctx.redirect(
    ctx.var.github.createAuthorizationURL(state, scope ? scope.split(' ') : [])
  )
})

app.get('/callback', githubAuthMiddleware, async ctx => {
  const { state, code } = ctx.req.query()
  if (!code) {
    throw new HTTPException(400, { message: 'Invalid code' })
  }
  const storedState = getCookie(ctx, 'auth-state', 'secure')
  if (
    !state ||
    !storedState ||
    state !== storedState ||
    !(await verifyToken(env(ctx).SECRET, state))
  ) {
    throw new HTTPException(400, { message: 'Invalid state' })
  }
  const tokens = await ctx.var.github.validateAuthorizationCode(code)
  deleteCookie(ctx, 'auth-state', { secure: true, path: '/callback' })
  return ctx.html(`
    <script>
      window.addEventListener('message', () => window.opener.postMessage('authorization:github:success:${JSON.stringify(
        { token: tokens.accessToken() }
      )}', '*'), { once: true })
      window.opener.postMessage('authorizing:github', '*')
    </script>
  `)
})

app.all('*', ctx => ctx.body('Ciallo～(∠·ω< )⌒★', 418))

export default app satisfies ExportedHandler<Env>
