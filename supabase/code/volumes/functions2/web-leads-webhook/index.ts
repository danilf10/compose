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
  const servicio = findField(data, SERVICE_FIELDS);
  const defaultAssignee = company.settings?.default_assignee || null;
  const datosRaw = {};
  for (const [k, v] of Object.entries(data))datosRaw[k] = v;
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
