// =============================================================================
// Router principal de Edge Functions — AnaliCRM self-hosted
// =============================================================================
// Sustituye a volumes/functions/main/index.ts del template de Easypanel
// (easypanel-io/compose, rama 18-05-2026, supabase/code).
//
// POR QUE SE SUSTITUYE
//
// El router original aplica UNA politica global de JWT a todas las funciones,
// leyendo la variable VERIFY_JWT. En Supabase Cloud, en cambio, cada funcion
// tiene su propio `verify_jwt`. Con una politica unica el sistema se rompe en
// las dos direcciones:
//
//   VERIFY_JWT=true   -> Meta no puede entregar leads (llama sin JWT) y la
//                        clasificacion IA del frontend deja de funcionar
//                        (src/lib/groq.js llama a ai-classify sin cabeceras)
//   VERIFY_JWT=false  -> las funciones admin-* quedan accesibles a cualquiera
//                        que conozca la URL
//
// Este router replica el comportamiento del cloud: JWT obligatorio salvo en las
// funciones declaradas publicas. Conserva la verificacion hibrida del original
// (HS256 con JWT_SECRET para claves legacy, ES256/RS256 via JWKS para las
// nuevas), asi que sigue valiendo si algun dia rotas al sistema de claves nuevo.
//
// La variable VERIFY_JWT del compose deja de usarse: manda PUBLIC_FUNCTIONS.
// =============================================================================

import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'

declare const EdgeRuntime: {
  userWorkers: {
    create(opts: Record<string, unknown>): Promise<{ fetch(req: Request): Promise<Response> }>
  }
}

// --- Funciones publicas (sin JWT) --------------------------------------------
// Configurable con PUBLIC_FUNCTIONS="a,b,c" en las variables del servicio.
// Los valores por defecto salen de como las llama el sistema hoy:
//   meta-leads-webhook -> lo invoca Meta: GET de verificacion + POST de leads
//   web-leads-webhook  -> lo invocan las webs de los clientes con ?key=<token>
//   ai-classify        -> lo llama el frontend sin cabecera Authorization
const DEFAULT_PUBLIC = ['meta-leads-webhook', 'web-leads-webhook', 'ai-classify']

const fromEnv = (Deno.env.get('PUBLIC_FUNCTIONS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const PUBLIC_FUNCTIONS = new Set(fromEnv.length > 0 ? fromEnv : DEFAULT_PUBLIC)

// --- Claves de verificacion ---------------------------------------------------
const JWT_SECRET =
  Deno.env.get('SUPABASE_INTERNAL_JWT_SECRET') ?? Deno.env.get('JWT_SECRET') ?? ''

const HS_KEY = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null

// JWKS para tokens asimetricos (ES256/RS256). Se resuelve de forma perezosa:
// si el proyecto solo usa claves legacy HS256, nunca se llega a pedir.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null
function getJWKS() {
  if (!jwks && SUPABASE_URL) {
    jwks = jose.createRemoteJWKSet(
      new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    )
  }
  return jwks
}

console.log(
  `[main] router AnaliCRM | publicas: ${[...PUBLIC_FUNCTIONS].join(', ')} | ` +
    `HS256: ${HS_KEY ? 'ok' : 'SIN JWT_SECRET'} | JWKS: ${SUPABASE_URL ? 'ok' : 'sin SUPABASE_URL'}`,
)

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return req.headers.get('apikey')
}

// Verificacion hibrida: el algoritmo del token decide el metodo.
// Mezclarlos da el error "Key for the ES256 algorithm must be of type CryptoKey".
async function isValidJWT(token: string): Promise<boolean> {
  try {
    const { alg } = jose.decodeProtectedHeader(token)

    if (alg === 'HS256') {
      if (!HS_KEY) return false
      await jose.jwtVerify(token, HS_KEY)
      return true
    }

    const keySet = getJWKS()
    if (!keySet) return false
    await jose.jwtVerify(token, keySet)
    return true
  } catch (_e) {
    return false
  }
}

const handler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const functionName = url.pathname.split('/').filter(Boolean)[0]

  if (!functionName) {
    return json({ msg: 'falta el nombre de la funcion en la ruta' }, 400)
  }

  // El preflight CORS nunca lleva credenciales: se delega en la funcion, que es
  // la que responde con sus propias cabeceras Access-Control-*.
  const isPreflight = req.method === 'OPTIONS'
  const isPublic = PUBLIC_FUNCTIONS.has(functionName)

  if (!isPreflight && !isPublic) {
    const token = extractToken(req)
    if (!token || !(await isValidJWT(token))) {
      console.log(`[main] 401 en ${functionName} (token ausente o invalido)`)
      return json({ msg: 'Invalid JWT' }, 401)
    }
  }

  const envVarsObj = Deno.env.toObject()
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]])

  try {
    // Mismos limites que el router original del template
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: `/home/deno/functions/${functionName}`,
      memoryLimitMb: Number(Deno.env.get('EDGE_MEMORY_LIMIT_MB') ?? 150),
      workerTimeoutMs: Number(Deno.env.get('EDGE_TIMEOUT_MS') ?? 60_000),
      noModuleCache: false,
      importMapPath: null,
      envVars,
    })
    return await worker.fetch(req)
  } catch (e) {
    console.error(`[main] error ejecutando ${functionName}:`, e)
    return json(
      { msg: `no se pudo ejecutar la funcion '${functionName}'`, detail: String(e) },
      500,
    )
  }
}

Deno.serve(handler)
