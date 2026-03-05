const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com'
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT'
const SCOPES = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube'

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  })
  return { status: res.status, body: await res.json() }
}

async function pollForToken(deviceCode, interval) {
  const body = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: deviceCode,
    grant_type: 'http://oauth.net/grant_type/device/1.0'
  }

  return new Promise((resolve, reject) => {
    const poll = async () => {
      process.stdout.write('\x1b[35m>>> Waiting for authorization...\x1b[0m\r')
      try {
        const { status, body: res } = await post('https://www.youtube.com/o/oauth2/token', body)
        if (res.error) {
          if (res.error === 'authorization_pending') return setTimeout(poll, interval * 1000)
          if (res.error === 'slow_down')             return setTimeout(poll, (interval + 5) * 1000)
          if (res.error === 'expired_token')         return reject(new Error('Authorization code expired.'))
          if (res.error === 'access_denied')         return reject(new Error('Access denied.'))
          return reject(new Error(`Polling error: ${res.error_description}`))
        }
        resolve(res.refresh_token)
      } catch {
        setTimeout(poll, interval * 1000)
      }
    }
    poll()
  })
}

async function main() {
  const { status, body } = await post('https://www.youtube.com/o/oauth2/device/code', {
    client_id: CLIENT_ID,
    scope: SCOPES
  })

  if (status !== 200 || body.error) {
    console.error(`\x1b[31mFailed to get device code: ${body.error_description || 'Unknown error'}\x1b[0m`)
    process.exit(1)
  }
  console.log(`\x1b[36mCode: \x1b[0m \x1b[1m\x1b[37m${body.user_code}\x1b[0m`)

  const token = await pollForToken(body.device_code, body.interval)

  console.log(`\n\x1b[1m\x1b[37m${token}\x1b[0m\n`)
  console.log('\x1b[33m==================================================================\x1b[0m')

}

main().catch(e => {
  console.error(`\x1b[31m${e.message}\x1b[0m`)
  process.exit(1)
})