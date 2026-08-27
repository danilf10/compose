import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const GRAPH_API = "https://graph.facebook.com/v21.0";
const NAME_FIELDS = [
  "full_name",
  "nombre_y_apellidos",
  "nombre",
  "name"
];
const EMAIL_FIELDS = [
  "email",
  "correo_electrónico",
  "correo_electronico",
  "correo"
];
const PHONE_FIELDS = [
  "phone_number",
  "número_de_teléfono",
  "numero_de_telefono",
  "telefono",
  "teléfono",
  "phone"
];
const SKIP_FIELDS = [
  ...NAME_FIELDS,
  ...EMAIL_FIELDS,
  ...PHONE_FIELDS
];
function getSupabase() {
  return createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
}
async function getSecret(supabase, key) {
  const { data } = await supabase.rpc("get_secret", {
    secret_key: key
  });
  return data || "";
}
async function logEvent(supabase, log) {
  try {
    await supabase.from("webhook_logs").insert({
      source: "meta",
      ...log
    });
  } catch  {}
}
async function verifySignature(body, signature, appSecret) {
  if (!appSecret || !signature) return !appSecret;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), {
    name: "HMAC",
    hash: "SHA-256"
  }, false, [
    "sign"
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig)).map((b)=>b.toString(16).padStart(2, "0")).join("");
  return signature === `sha256=${hex}`;
}
function extractField(fieldData, candidates) {
  for (const name of candidates){
    const f = fieldData.find((fd)=>fd.name.toLowerCase().replace(/[¿?]/g, "").trim() === name);
    if (f && f.values?.[0]) return f.values[0];
  }
  return null;
}
async function classifyService(datosRaw, services, contextoIa, groqKey) {
  const customFields = {};
  for (const [k, v] of Object.entries(datosRaw)){
    const kLower = k.toLowerCase().replace(/[¿?]/g, "").trim();
    if (!SKIP_FIELDS.some((sf)=>kLower.includes(sf) || sf.includes(kLower)) && v) customFields[k] = v;
  }
  if (Object.keys(customFields).length === 0) return {
    servicio: null,
    isNew: false
  };
  for (const val of Object.values(customFields)){
    const match = services.find((s)=>s.toLowerCase().trim() === val.toLowerCase().trim());
    if (match) return {
      servicio: match,
      isNew: false
    };
  }
  for (const val of Object.values(customFields)){
    const valLower = val.toLowerCase();
    const match = services.find((s)=>s.toLowerCase().includes(valLower) || valLower.includes(s.toLowerCase()));
    if (match) return {
      servicio: match,
      isNew: false
    };
  }
  if (groqKey) {
    try {
      const prompt = `Eres un asistente que clasifica leads.\n\n${contextoIa ? `CONTEXTO:\n${contextoIa}\n\n` : ""}SERVICIOS: ${services.length > 0 ? JSON.stringify(services) : "(ninguno)"}\n\nDATOS:\n${Object.entries(customFields).map(([k, v])=>`- ${k}: ${v}`).join("\n")}\n\nResponde SOLO con el nombre del servicio.`;
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
          // gpt-oss-120b razona antes de responder, y ese razonamiento consume
          // tokens de la misma cuenta. Con 50 se agotaban razonando: la
          // respuesta llegaba vacia con finish_reason "length" y el lead se
          // quedaba sin clasificar, sin ningun error visible. Con esfuerzo bajo
          // resuelve en unos 60 tokens; 512 deja margen de sobra.
          reasoning_effort: "low",
          max_tokens: 512
        })
      });
      if (res.ok) {
        const data = await res.json();
        const answer = data.choices?.[0]?.message?.content?.trim();
        if (answer) {
          const existingMatch = services.find((s)=>s.toLowerCase() === answer.toLowerCase());
          return existingMatch ? {
            servicio: existingMatch,
            isNew: false
          } : {
            servicio: answer,
            isNew: true
          };
        }
      }
    } catch  {}
  }
  const vals = Object.values(customFields);
  if (vals.length === 1) return {
    servicio: vals[0],
    isNew: !services.some((s)=>s.toLowerCase() === vals[0].toLowerCase())
  };
  return {
    servicio: null,
    isNew: false
  };
}
async function fetchFormRow(supabase, formId) {
  const { data } = await supabase.from("meta_lead_forms_decrypted").select("company_id, page_access_token, form_name, default_servicio, active, excluded").eq("meta_form_id", formId).maybeSingle();
  return data;
}
async function fetchPageConfig(supabase, pageId) {
  const { data } = await supabase.from("meta_pages_decrypted").select("company_id, page_access_token, page_name").eq("meta_page_id", pageId).eq("active", true).maybeSingle();
  return data;
}
async function storeOrphan(supabase, leadgenId, formId, pageId, token, payload, ip, startTime) {
  let leadData = null;
  try {
    const fields = "id,created_time,field_data,form_id";
    const res = await fetch(`${GRAPH_API}/${leadgenId}?fields=${fields}&access_token=${token}`);
    if (res.ok) leadData = await res.json();
  } catch  {}
  const fieldData = leadData?.field_data || [];
  const nombre = extractField(fieldData, NAME_FIELDS);
  const email = extractField(fieldData, EMAIL_FIELDS);
  const telefono = extractField(fieldData, PHONE_FIELDS);
  const datosRaw = {};
  for (const fd of fieldData)datosRaw[fd.name] = fd.values?.[0] || "";
  let formName = "";
  try {
    const fr = await fetch(`${GRAPH_API}/${formId}?fields=name&access_token=${token}`);
    if (fr.ok) formName = (await fr.json()).name || "";
  } catch  {}
  let pageName = "";
  try {
    const pr = await fetch(`${GRAPH_API}/${pageId}?fields=name&access_token=${token}`);
    if (pr.ok) pageName = (await pr.json()).name || "";
  } catch  {}
  const { error } = await supabase.from("meta_orphan_leads").upsert({
    meta_lead_id: leadgenId,
    form_id: formId,
    form_name: formName || null,
    page_id: pageId,
    page_name: pageName || null,
    nombre: nombre || null,
    email: email || null,
    telefono: telefono || null,
    datos_raw: datosRaw,
    raw_payload: leadData || payload,
    meta_created_time: leadData?.created_time || null
  }, {
    onConflict: "meta_lead_id",
    ignoreDuplicates: true
  });
  await logEvent(supabase, {
    event_type: "leadgen",
    status: error ? "orphan_error" : "orphan_stored",
    status_code: error ? 500 : 200,
    error_message: error?.message || `Form ${formId} sin mapeo y page ${pageId} no conectada - guardado en bandeja de huérfanos`,
    payload,
    meta_page_id: pageId,
    meta_form_id: formId,
    meta_lead_id: leadgenId,
    ip,
    duration_ms: Date.now() - startTime
  });
}
async function processLead(leadgenId, formId, pageId, supabase, groqKey, ip, payload) {
  const startTime = Date.now();
  const formRow = await fetchFormRow(supabase, formId);
  const pageConfig = await fetchPageConfig(supabase, pageId);
  // 1) EXCLUIDO siempre gana: descartar silenciosamente, sin huerfano
  if (formRow?.excluded) {
    await logEvent(supabase, {
      event_type: "leadgen",
      status: "excluded",
      status_code: 200,
      error_message: `Form ${formId} está excluido - lead descartado por configuración`,
      payload,
      meta_page_id: pageId,
      meta_form_id: formId,
      meta_lead_id: leadgenId,
      ip,
      duration_ms: Date.now() - startTime
    });
    return;
  }
  const token = formRow?.page_access_token || pageConfig?.page_access_token;
  if (!token) {
    await logEvent(supabase, {
      event_type: "leadgen",
      status: "no_config",
      error_message: `Page ${pageId} no conectada y sin form mapeado con token`,
      payload,
      meta_page_id: pageId,
      meta_form_id: formId,
      meta_lead_id: leadgenId,
      ip,
      duration_ms: Date.now() - startTime
    });
    return;
  }
  // 2) Decidir empresa: form > page
  let company_id = null;
  let form_name = null;
  let default_servicio = null;
  let routedBy = "page";
  if (formRow && formRow.active && formRow.company_id) {
    company_id = formRow.company_id;
    form_name = formRow.form_name;
    default_servicio = formRow.default_servicio;
    routedBy = "form";
  } else if (pageConfig?.company_id) {
    company_id = pageConfig.company_id;
    routedBy = "page";
  }
  // 3) Sin empresa resoluble -> bandeja de huerfanos
  if (!company_id) {
    await storeOrphan(supabase, leadgenId, formId, pageId, token, payload, ip, startTime);
    return;
  }
  const fields = "id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform";
  const res = await fetch(`${GRAPH_API}/${leadgenId}?fields=${fields}&access_token=${token}`);
  if (!res.ok) {
    const errText = await res.text();
    await logEvent(supabase, {
      event_type: "leadgen",
      status: "graph_api_error",
      status_code: res.status,
      error_message: errText,
      company_id,
      payload,
      meta_page_id: pageId,
      meta_form_id: formId,
      meta_lead_id: leadgenId,
      ip,
      duration_ms: Date.now() - startTime
    });
    return;
  }
  const leadData = await res.json();
  const fieldData = leadData.field_data || [];
  const nombre = extractField(fieldData, NAME_FIELDS) || "Sin nombre";
  const email = extractField(fieldData, EMAIL_FIELDS);
  const telefono = extractField(fieldData, PHONE_FIELDS);
  const datosRaw = {};
  for (const fd of fieldData){
    datosRaw[fd.name] = fd.values?.[0] || "";
  }
  const { data: company } = await supabase.from("companies").select("settings").eq("id", company_id).single();
  const services = company?.settings?.services || [];
  const contextoIa = company?.settings?.contexto_ia || null;
  const defaultAssignee = company?.settings?.default_assignee || null;
  let servicio = default_servicio || null;
  if (!servicio) {
    const classification = await classifyService(datosRaw, services, contextoIa, groqKey);
    servicio = classification.servicio;
    if (classification.isNew && servicio && company?.settings) {
      await supabase.from("companies").update({
        settings: {
          ...company.settings,
          services: [
            ...services,
            servicio
          ]
        }
      }).eq("id", company_id);
    }
  }
  let pageName = "";
  try {
    const pr = await fetch(`${GRAPH_API}/${pageId}?fields=name&access_token=${token}`);
    if (pr.ok) pageName = (await pr.json()).name || "";
  } catch  {}
  let actualFormName = form_name || "";
  if (!actualFormName) {
    try {
      const fr = await fetch(`${GRAPH_API}/${formId}?fields=name&access_token=${token}`);
      if (fr.ok) actualFormName = (await fr.json()).name || "";
    } catch  {}
  }
  const { data: insertedLead, error: leadErr } = await supabase.from("leads").insert({
    company_id,
    nombre,
    email,
    telefono,
    origen: "facebook",
    servicio,
    servicios: servicio ? [
      servicio
    ] : [],
    estado: "nuevo",
    datos_raw: datosRaw,
    assigned_to: defaultAssignee
  }).select("id").single();
  if (leadErr) {
    await logEvent(supabase, {
      event_type: "leadgen",
      status: "db_error",
      company_id,
      error_message: leadErr.message,
      payload,
      meta_page_id: pageId,
      meta_form_id: formId,
      meta_lead_id: leadgenId,
      ip,
      duration_ms: Date.now() - startTime
    });
    return;
  }
  await supabase.from("lead_meta_facebook").insert({
    lead_id: insertedLead.id,
    company_id,
    meta_lead_id: leadData.id || leadgenId,
    campaign_id: leadData.campaign_id || null,
    campaign_name: leadData.campaign_name || null,
    ad_id: leadData.ad_id || null,
    ad_name: leadData.ad_name || null,
    adset_id: leadData.adset_id || null,
    adset_name: leadData.adset_name || null,
    form_id: formId,
    form_name: actualFormName,
    page_id: pageId,
    page_name: pageName,
    platform: leadData.platform || "fb",
    meta_created_time: leadData.created_time || null,
    raw_payload: leadData
  });
  await logEvent(supabase, {
    event_type: "leadgen",
    status: "success",
    status_code: 200,
    company_id,
    lead_id: insertedLead.id,
    payload,
    result: {
      nombre,
      email,
      telefono,
      servicio,
      assigned_to: defaultAssignee,
      routed_by: routedBy
    },
    meta_page_id: pageId,
    meta_form_id: formId,
    meta_lead_id: leadgenId,
    ip,
    duration_ms: Date.now() - startTime
  });
}
Deno.serve(async (req)=>{
  const supabase = getSupabase();
  const url = new URL(req.url);
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const verifyToken = await getSecret(supabase, "META_VERIFY_TOKEN");
    if (mode === "subscribe" && token === verifyToken) {
      await logEvent(supabase, {
        event_type: "verification",
        status: "success",
        status_code: 200,
        ip
      });
      return new Response(challenge, {
        status: 200
      });
    }
    await logEvent(supabase, {
      event_type: "verification",
      status: "forbidden",
      status_code: 403,
      ip,
      error_message: "Invalid verify token"
    });
    return new Response("Forbidden", {
      status: 403
    });
  }
  if (req.method === "POST") {
    const body = await req.text();
    const signature = req.headers.get("x-hub-signature-256") || "";
    const appSecret = await getSecret(supabase, "META_APP_SECRET");
    if (appSecret && !await verifySignature(body, signature, appSecret)) {
      await logEvent(supabase, {
        event_type: "webhook",
        status: "invalid_signature",
        status_code: 401,
        ip,
        error_message: "Invalid signature"
      });
      return new Response("Invalid signature", {
        status: 401
      });
    }
    const payload = JSON.parse(body);
    if (payload.object !== "page") {
      await logEvent(supabase, {
        event_type: "webhook",
        status: "ignored",
        status_code: 200,
        payload,
        ip,
        error_message: `Object: ${payload.object}`
      });
      return new Response("OK", {
        status: 200
      });
    }
    const groqKey = await getSecret(supabase, "GROQ_API_KEY");
    for (const entry of payload.entry || []){
      for (const change of entry.changes || []){
        if (change.field === "leadgen") {
          const { leadgen_id, form_id, page_id } = change.value;
          try {
            await processLead(leadgen_id, form_id, page_id, supabase, groqKey, ip, payload);
          } catch (err) {
            await logEvent(supabase, {
              event_type: "leadgen",
              status: "exception",
              error_message: String(err),
              payload,
              meta_page_id: page_id,
              meta_form_id: form_id,
              meta_lead_id: leadgen_id,
              ip
            });
          }
        }
      }
    }
    return new Response("OK", {
      status: 200
    });
  }
  return new Response("Method not allowed", {
    status: 405
  });
});
