import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type"
};
const NAME_FIELDS = [
  "name",
  "nombre",
  "full_name",
  "your-name",
  "nombre-completo",
  "your_name",
  "field_name",
  "nombre_completo"
];
const EMAIL_FIELDS = [
  "email",
  "correo",
  "your-email",
  "mail",
  "correo_electronico",
  "your_email",
  "field_email",
  "e-mail"
];
const PHONE_FIELDS = [
  "phone",
  "telefono",
  "tel",
  "your-phone",
  "phone_number",
  "your_phone",
  "field_phone",
  "movil",
  "celular"
];
const MESSAGE_FIELDS = [
  "message",
  "mensaje",
  "your-message",
  "comments",
  "comentarios",
  "your_message",
  "field_message",
  "notas"
];
const SERVICE_FIELDS = [
  "service",
  "servicio",
  "subject",
  "asunto",
  "your-subject",
  "tipo",
  "interes"
];
// Los campos de contacto no dicen nada sobre que servicio quiere el lead. El
// mensaje si, y mucho, asi que ese se queda.
const CAMPOS_CONTACTO = [
  ...NAME_FIELDS,
  ...EMAIL_FIELDS,
  ...PHONE_FIELDS
];
async function getSecret(supabase, key) {
  const { data } = await supabase.rpc("get_secret", {
    secret_key: key
  });
  return data || "";
}
// Mismo criterio que en el webhook de Facebook, para que un lead de la web y
// uno de Facebook con los mismos datos acaben con el mismo servicio:
// coincidencia exacta, luego parcial, y solo entonces se pregunta a la IA.
// Cuantos servicios puede llegar a crear la IA sola. No es un limite de
// negocio: es una red por si algo se descontrola y empieza a inventar uno por
// lead. A partir de ahi clasifica con los que hay, pero no anade mas.
const MAX_SERVICIOS_AUTO = 25;
// Para comparar "Reforma integral" con "reformas integrales " y ver que son lo
// mismo antes de crear un duplicado.
function normalizar(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function mismoServicio(a, b) {
  const na = normalizar(a), nb = normalizar(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // plurales y pequenas variantes: "reforma integral" / "reformas integrales"
  const raiz = (x)=>x.split(" ").map((p)=>p.replace(/(es|s)$/, "")).join(" ");
  return raiz(na) === raiz(nb);
}
// Un nombre de servicio es una etiqueta corta, no una frase. Sirve para
// descartar respuestas como "El cliente quiere que le cambien la bañera".
function nombreRazonable(s) {
  const limpio = String(s || "").trim();
  if (limpio.length < 3 || limpio.length > 40) return false;
  const palabras = limpio.split(/\s+/);
  if (palabras.length > 4) return false;
  if (/[.:;!?\n]/.test(limpio)) return false;
  return /[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/.test(limpio);
}
function extraerJson(texto) {
  if (!texto) return null;
  const i = texto.indexOf("{"), j = texto.lastIndexOf("}");
  if (i === -1 || j === -1 || j < i) return null;
  try {
    return JSON.parse(texto.slice(i, j + 1));
  } catch  {
    return null;
  }
}
// Devuelve { servicio, isNew }. servicio es siempre uno de los de la empresa, o
// uno nuevo que ha pasado el filtro, o null. Nunca una frase suelta: si el lead
// no deja claro que quiere, se queda sin clasificar y lo decide una persona.
async function classifyService(datosRaw, services, contextoIa, groqKey, permitirCrear = true) {
  const customFields = {};
  for (const [k, v] of Object.entries(datosRaw)){
    const kLower = String(k).toLowerCase().replace(/[¿?]/g, "").trim();
    const esContacto = CAMPOS_CONTACTO.some((sf)=>kLower === sf || kLower.includes(sf) || sf.includes(kLower));
    if (!esContacto && v && typeof v === "string") customFields[k] = v;
  }
  if (Object.keys(customFields).length === 0) return {
    servicio: null,
    isNew: false
  };
  // Antes de gastar una llamada: si el propio formulario ya trae el nombre de
  // un servicio que existe, no hay nada que pensar.
  for (const val of Object.values(customFields)){
    const match = services.find((s)=>mismoServicio(s, val));
    if (match) return {
      servicio: match,
      isNew: false
    };
  }
  for (const val of Object.values(customFields)){
    const valLower = normalizar(val);
    const match = services.find((s)=>{
      const ns = normalizar(s);
      return ns && valLower && (ns.includes(valLower) || valLower.includes(ns));
    });
    if (match) return {
      servicio: match,
      isNew: false
    };
  }
  if (!groqKey) return {
    servicio: null,
    isNew: false
  };
  // Tres cosas tienen que darse para crear: que la empresa lo permita en su
  // configuracion, que no se haya llegado al tope, y que la IA lo tenga claro.
  const puedeCrear = permitirCrear && services.length < MAX_SERVICIOS_AUTO;
  try {
    const reglas = [
      "- Si encaja en uno de los SERVICIOS, responde ese nombre EXACTO y nuevo=false.",
      puedeCrear ? "- Si ninguno encaja pero el lead dice con claridad que necesita, propon un nombre nuevo, corto (1 a 3 palabras), generico y en singular, y nuevo=true." : "- No propongas servicios nuevos: usa solo los de la lista.",
      '- Si no esta claro que quiere, responde servicio "" y seguridad "baja". Es preferible dejarlo sin clasificar a acertar por casualidad.',
      '- seguridad es "alta" solo si el propio lead dice lo que necesita, no si lo deduces por contexto.'
    ].join("\n");
    const prompt = `Eres un asistente que clasifica leads.

${contextoIa ? `CONTEXTO:\n${contextoIa}\n\n` : ""}SERVICIOS: ${services.length > 0 ? JSON.stringify(services) : "(ninguno todavia)"}

DATOS DEL LEAD:
${Object.entries(customFields).map(([k, v])=>`- ${k}: ${v}`).join("\n")}

REGLAS:
${reglas}

Responde SOLO con JSON, sin nada mas:
{"servicio": "<nombre o vacio>", "nuevo": true|false, "seguridad": "alta"|"media"|"baja"}`;
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1,
        // gpt-oss-120b razona antes de responder y ese razonamiento gasta
        // tokens de la misma cuenta. Con 50 se los gastaba pensando y devolvia
        // el contenido vacio: el lead se quedaba sin clasificar y sin error.
        reasoning_effort: "low",
        max_tokens: 512,
        response_format: {
          type: "json_object"
        }
      })
    });
    if (!res.ok) return {
      servicio: null,
      isNew: false
    };
    const data = await res.json();
    const parsed = extraerJson(data.choices?.[0]?.message?.content?.trim());
    const propuesto = parsed?.servicio?.trim();
    if (!propuesto) return {
      servicio: null,
      isNew: false
    };
    // Aunque diga que es nuevo, si ya existe algo equivalente se usa lo que hay.
    const existente = services.find((s)=>mismoServicio(s, propuesto));
    if (existente) return {
      servicio: existente,
      isNew: false
    };
    // A partir de aqui seria crear uno. Solo si se puede, si la IA lo tiene
    // claro y si el nombre parece una etiqueta y no una frase.
    if (!puedeCrear || parsed?.seguridad !== "alta" || !nombreRazonable(propuesto)) {
      return {
        servicio: null,
        isNew: false
      };
    }
    // Con inicial en mayuscula: esta lista se ve en la configuracion de la
    // empresa junto a los servicios que ha escrito una persona.
    return {
      servicio: propuesto.charAt(0).toUpperCase() + propuesto.slice(1),
      isNew: true
    };
  } catch  {
    return {
      servicio: null,
      isNew: false
    };
  }
}
function findField(data, candidates) {
  for (const key of candidates)if (data[key]) return data[key];
  const lowerData = {};
  for (const [k, v] of Object.entries(data))lowerData[k.toLowerCase().replace(/[\s-]/g, '_')] = v;
  for (const key of candidates)if (lowerData[key]) return lowerData[key];
  return null;
}
async function logEvent(supabase, log) {
  try {
    await supabase.from("webhook_logs").insert({
      source: "web",
      ...log
    });
  } catch  {}
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method !== "POST") return new Response("Method not allowed", {
    status: 405,
    headers: corsHeaders
  });
  const startTime = Date.now();
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const fullUrl = req.url;
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!key) {
    await logEvent(supabase, {
      status: "missing_key",
      status_code: 400,
      ip,
      request_url: fullUrl,
      duration_ms: Date.now() - startTime
    });
    return new Response(JSON.stringify({
      error: "Missing key parameter"
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const { data: company, error: companyErr } = await supabase.from("companies").select("id, name, settings").eq("webhook_key", key).single();
  if (companyErr || !company) {
    await logEvent(supabase, {
      status: "invalid_key",
      status_code: 404,
      ip,
      error_message: `Invalid webhook key: ${key}`,
      request_url: fullUrl,
      duration_ms: Date.now() - startTime
    });
    return new Response(JSON.stringify({
      error: "Invalid webhook key"
    }), {
      status: 404,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  let data = {};
  const contentType = req.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) data = await req.json();
    else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      for (const [k, v] of formData.entries())if (typeof v === "string") data[k] = v;
    } else {
      data = await req.json();
    }
  } catch  {
    await logEvent(supabase, {
      company_id: company.id,
      status: "invalid_body",
      status_code: 400,
      ip,
      error_message: "Could not parse body",
      request_url: fullUrl,
      duration_ms: Date.now() - startTime
    });
    return new Response(JSON.stringify({
      error: "Invalid body"
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const nombre = findField(data, NAME_FIELDS) || "Lead web";
  const email = findField(data, EMAIL_FIELDS);
  const telefono = findField(data, PHONE_FIELDS);
  const mensaje = findField(data, MESSAGE_FIELDS);
  let servicio = findField(data, SERVICE_FIELDS);
  const defaultAssignee = company.settings?.default_assignee || null;
  const datosRaw = {};
  for (const [k, v] of Object.entries(data))datosRaw[k] = v;
  // Si el formulario no trae servicio, se deduce de lo que haya escrito el
  // lead. Antes se quedaba sin clasificar y habia que hacerlo a mano uno a uno,
  // que es justo lo que evita el webhook de Facebook desde el principio.
  if (!servicio) {
    const groqKey = await getSecret(supabase, "GROQ_API_KEY");
    const services = company.settings?.services || [];
    const clasificacion = await classifyService(datosRaw, services, company.settings?.contexto_ia || null, groqKey, company.settings?.ia_crear_servicios !== false);
    servicio = clasificacion.servicio;
    // Solo se crea si la IA lo tiene claro; el filtro esta en classifyService.
    if (clasificacion.isNew && servicio && company.settings) {
      await supabase.from("companies").update({
        settings: {
          ...company.settings,
          services: [
            ...services,
            servicio
          ]
        }
      }).eq("id", company.id);
    }
  }
  const { data: insertedLead, error: insertErr } = await supabase.from("leads").insert({
    company_id: company.id,
    nombre,
    email: email || null,
    telefono: telefono || null,
    origen: "web",
    servicio: servicio || null,
    servicios: servicio ? [
      servicio
    ] : [],
    estado: "nuevo",
    mensaje: mensaje || null,
    datos_raw: datosRaw,
    assigned_to: defaultAssignee
  }).select("id").single();
  if (insertErr) {
    await logEvent(supabase, {
      company_id: company.id,
      status: "db_error",
      status_code: 500,
      ip,
      error_message: insertErr.message,
      payload: data,
      request_url: fullUrl,
      duration_ms: Date.now() - startTime
    });
    return new Response(JSON.stringify({
      error: "Error saving lead"
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  await logEvent(supabase, {
    company_id: company.id,
    status: "success",
    status_code: 200,
    ip,
    lead_id: insertedLead.id,
    payload: data,
    result: {
      nombre,
      email,
      telefono,
      servicio,
      assigned_to: defaultAssignee
    },
    request_url: fullUrl,
    duration_ms: Date.now() - startTime
  });
  return new Response(JSON.stringify({
    success: true
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
});
