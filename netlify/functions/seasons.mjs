// Season status — which application doors are open right now, read live from
// the workspace's casting cycles so the site never promises an open window
// that isn't (reference/PUBLIC_SITE_CONTEXT.md §7).
//
// Uses the Supabase anon key: RLS on ws_cast_cycles only exposes rows with
// status = 'open' to anon, so this can never leak anything else. Env values
// are the same PUBLIC pair the workspace ships in its bundle (VITE_*).
const TTL_MS = 5 * 60 * 1000
let memo = { at: 0, body: null }

function clean(v) {
  if (typeof v !== 'string') return v
  let s = v.trim()
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
    'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
  }
  // A failure is never cached: whoever is fixing the configuration should see
  // the effect of the fix on the next request, not five minutes later.
  const failHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  // `reason` exists so a misconfiguration is diagnosable by opening
  // /api/seasons in a browser. It names the failure, never the credentials.
  const fail = (reason, status) =>
    new Response(JSON.stringify({ ok: false, reason, ...(status ? { status } : {}) }), {
      headers: failHeaders,
    })

  const url = clean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)
  const key = clean(process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)
  if (!url || !key) return fail('not-configured')

  if (memo.body && Date.now() - memo.at < TTL_MS) {
    return new Response(memo.body, { headers })
  }

  try {
    const res = await fetch(
      `${url.replace(/\/$/, '')}/rest/v1/ws_cast_cycles?select=division,season,year,closes_at&status=eq.open`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } }
    )
    // 401/403 = the key is wrong or the anon read policy is missing;
    // 404 = the table isn't there. Either way the status is the useful clue.
    if (!res.ok) return fail('rejected', res.status)
    const rows = await res.json()
    const pick = (division) => {
      const r = Array.isArray(rows) ? rows.find((x) => x.division === division) : null
      return r ? { season: r.season, year: r.year, closesAt: r.closes_at || null } : null
    }
    const body = JSON.stringify({ ok: true, community: pick('community'), talent: pick('talent') })
    memo = { at: Date.now(), body }
    return new Response(body, { headers })
  } catch {
    // Unknown is not the same as closed — say nothing rather than guess.
    // (Usually a wrong project URL: the host doesn't resolve.)
    return fail('unreachable')
  }
}
