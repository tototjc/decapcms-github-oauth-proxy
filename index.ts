import { Hono, type Env as HonoEnv } from 'hono'
import { env } from 'hono/adapter'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { setSignedCookie, getSignedCookie, deleteCookie } from 'hono/cookie'
import { GitHub, GitLab, generateState, OAuth2RequestError } from 'arctic'

const DEFAULT_SITE_ID_LIST = ['localhost', '127.0.0.1'] as const

const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.com' as const

const ENDPOINT_MAP = {
  auth: '/auth',
  callback: '/callback',
} as const

interface AppEnv extends HonoEnv {
  Bindings: Env
  Variables: {
    site_id: string
    provider: 'github' | 'gitlab'
    oauthClient: GitHub | GitLab
    trustOrigin?: string
  }
}

const getStateCookieName = (provider: string) => `${provider}-state` as const

const renderBody = (
  provider: string,
  status: 'success' | 'error',
  payload: { token?: string; message?: string | null },
  trustOrigin?: string
) => {
  const signal = ['authorizing', provider].join(':')
  const data = ['authorization', provider, status, JSON.stringify(payload)].join(':')
  return `
<script>
window.addEventListener('message', ({ data, origin, source }) => ${trustOrigin ? `origin === '${trustOrigin}' &&` : ''} source === window.opener && data === '${signal}' && source.postMessage('${data}', origin), { once: true })
window.opener.postMessage('${signal}', '${trustOrigin ?? '*'}')
</script>
`.trim()
}

const siteIdVerifyMiddleware = createMiddleware<AppEnv>(async (ctx, next) => {
  const site_id = ctx.req.query('site_id')
  const allowSiteIdList = [
    ...env(ctx).ALLOW_SITE_ID_LIST.split(',').map(i => i.trim()).filter(Boolean),
    ...DEFAULT_SITE_ID_LIST,
  ]
  if (!site_id || !allowSiteIdList.includes(site_id)) {
    throw new HTTPException(400, { message: 'Invalid site_id' })
  }
  ctx.set('site_id', site_id)
  const referer = URL.parse(ctx.req.header('Referer') ?? '')
  if (referer && site_id === referer.hostname) {
    ctx.set('trustOrigin', referer.origin)
  }
  await next()
})

const oauthMiddleware = createMiddleware<AppEnv>(async (ctx, next) => {
  const { provider, site_id } = ctx.req.query()
  const getCallbackUrl = (params?: Record<string, string>) => {
    const url = new URL(ENDPOINT_MAP.callback, ctx.req.url)
    url.search = new URLSearchParams(params).toString()
    return url.href
  }
  if (provider == 'github') {
    ctx.set(
      'oauthClient',
      new GitHub(
        env(ctx).GITHUB_OAUTH_ID,
        env(ctx).GITHUB_OAUTH_SECRET,
        getCallbackUrl({ provider, site_id })
      )
    )
  } else if (provider == 'gitlab') {
    ctx.set(
      'oauthClient',
      new GitLab(
        env(ctx).GITLAB_BASE_URL ?? DEFAULT_GITLAB_BASE_URL,
        env(ctx).GITLAB_OAUTH_ID,
        env(ctx).GITLAB_OAUTH_SECRET,
        getCallbackUrl({ provider, site_id })
      )
    )
  } else {
    throw new HTTPException(400, { message: 'Invalid provider' })
  }
  ctx.set('provider', provider)
  await next()
})

const app = new Hono<AppEnv>()

app.onError((err, ctx) => {
  if (err instanceof OAuth2RequestError) {
    const { provider, trustOrigin } = ctx.var
    return ctx.html(
      renderBody(
        provider,
        'error',
        { message: err.description },
        trustOrigin
      ),
      400
    )
  }
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  return ctx.body('Internal Server Error', 500)
})

app.get(ENDPOINT_MAP.auth, siteIdVerifyMiddleware, oauthMiddleware, async ctx => {
  const { provider, oauthClient } = ctx.var
  const cookieName = getStateCookieName(provider)
  const state = generateState()
  await setSignedCookie(ctx, cookieName, state, env(ctx).SECRET, {
    maxAge: 3 * 60,
    httpOnly: true,
    path: ENDPOINT_MAP.callback,
    secure: true,
    sameSite: 'Lax',
    priority: 'High',
    prefix: 'secure',
  })
  const scope = ctx.req.query('scope')?.split(' ') ?? []
  return ctx.redirect(oauthClient.createAuthorizationURL(state, scope))
})

app.get(ENDPOINT_MAP.callback, siteIdVerifyMiddleware, oauthMiddleware, async ctx => {
  const { provider, oauthClient, trustOrigin } = ctx.var
  const cookieName = getStateCookieName(provider)
  const storedState = await getSignedCookie(
    ctx,
    env(ctx).SECRET,
    cookieName,
    'secure'
  )
  deleteCookie(ctx, cookieName, { path: ENDPOINT_MAP.callback, secure: true })
  const state = ctx.req.query('state')
  if (!state || !storedState || state !== storedState) {
    throw new HTTPException(400, { message: 'Invalid state' })
  }
  const code = ctx.req.query('code')
  if (!code) {
    throw new HTTPException(400, { message: 'Invalid code' })
  }
  const tokens = await oauthClient.validateAuthorizationCode(code)
  return ctx.html(
    renderBody(
      provider,
      'success',
      { token: tokens.accessToken() },
      trustOrigin
    ),
    200
  )
})

app.all('*', ctx => ctx.body('Ciallo～(∠·ω< )⌒★', 418))

export default app satisfies ExportedHandler<Env>
