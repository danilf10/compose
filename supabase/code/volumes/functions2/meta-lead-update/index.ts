import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const GRAPH_API = "https://graph.facebook.com/v21.0";
const LOG = "[meta-lead-update]";
const STATUS_MAP = {
  contactado: {
    status: "CONNECTED"
  },
  no_lo_coge: {
    status: "CONNECTED",
    sub_status: "NO_ANSWER"
  },
  en_proceso: {
    status: "QUALIFIED"
  },
  cerrado: {
    status: "CONVERTED",
    sub_status: "CLOSED_WON"
  },
  perdido: {
    status: "DISQUALIFIED",
    sub_status: "CLOSED_LOST"
  },
  moroso: {
    status: "DISQUALIFIED",
    sub_status: "LOW_QUALITY"
  }
};
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const json = (body, status)=>new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders
    });
  }
  try {
    const { lead_id, estado } = await req.json();
    console.log(`${LOG} request:`, {
      lead_id,
      estado
    });
    if (!lead_id || !estado) {
      return json({
        error: "lead_id y estado son obligatorios"
      }, 400);
    }
    const metaStatus = STATUS_MAP[estado];
    if (!metaStatus) {
      console.log(`${LOG} estado no mapeado, skip:`, estado);
      return json({
        skipped: true,
        reason: `Estado '${estado}' no se envia a Meta`
      }, 200);
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    // 1. Resolver meta_lead_id y form_id desde el sidecar
    const { data: meta, error: metaErr } = await supabase.from("lead_meta_facebook").select("meta_lead_id, form_id").eq("lead_id", lead_id).single();
    if (metaErr || !meta?.meta_lead_id) {
      console.log(`${LOG} no es lead de Facebook:`, {
        lead_id,
        metaErr
      });
      return json({
        skipped: true,
        reason: "No es un lead de Facebook"
      }, 200);
    }
    console.log(`${LOG} lead_meta_facebook resuelto:`, {
      meta_lead_id: meta.meta_lead_id,
      form_id: meta.form_id
    });
    // 2. Resolver meta_page_id desde meta_lead_forms (tabla, no vista)
    const { data: form, error: formErr } = await supabase.from("meta_lead_forms").select("meta_page_id").eq("meta_form_id", meta.form_id).single();
    if (formErr || !form?.meta_page_id) {
      console.error(`${LOG} no se pudo resolver meta_page_id:`, {
        form_id: meta.form_id,
        formErr
      });
      return json({
        error: "No se pudo resolver meta_page_id para el formulario"
      }, 400);
    }
    console.log(`${LOG} meta_page_id resuelto:`, {
      meta_page_id: form.meta_page_id
    });
    // 3. Intentar token de la pagina (camino preferido)
    let accessToken = null;
    let tokenSource = "";
    const { data: pageRow } = await supabase.from("meta_pages_decrypted").select("page_access_token").eq("meta_page_id", form.meta_page_id).maybeSingle();
    console.log(`${LOG} token de pagina:`, {
      encontrado: !!pageRow?.page_access_token
    });
    if (pageRow?.page_access_token) {
      accessToken = pageRow.page_access_token;
      tokenSource = "page";
    } else {
      // 4. Fallback: token del formulario
      const { data: formRow } = await supabase.from("meta_lead_forms_decrypted").select("page_access_token").eq("meta_form_id", meta.form_id).maybeSingle();
      console.log(`${LOG} token de formulario (fallback):`, {
        encontrado: !!formRow?.page_access_token
      });
      if (formRow?.page_access_token) {
        accessToken = formRow.page_access_token;
        tokenSource = "form";
      }
    }
    if (!accessToken) {
      console.error(`${LOG} sin token disponible:`, {
        meta_page_id: form.meta_page_id,
        form_id: meta.form_id
      });
      return json({
        error: "Ni la pagina ni el formulario tienen token disponible"
      }, 400);
    }
    // 5. POST a Graph API
    const body = {
      status: metaStatus.status,
      access_token: accessToken
    };
    if (metaStatus.sub_status) body.sub_status = metaStatus.sub_status;
    const url = `${GRAPH_API}/${meta.meta_lead_id}`;
    console.log(`${LOG} POST Graph API:`, {
      url,
      status: metaStatus.status,
      sub_status: metaStatus.sub_status ?? null,
      token_source: tokenSource
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(body).toString()
    });
    const result = await res.json();
    console.log(`${LOG} respuesta Graph API:`, {
      http_status: res.status,
      response: result
    });
    if (!res.ok) {
      console.error(`${LOG} Meta API error:`, {
        meta_lead_id: meta.meta_lead_id,
        response: result
      });
      return json({
        error: result.error?.message || "Error de Meta",
        details: result.error ?? null
      }, 400);
    }
    return json({
      success: true,
      meta_status: metaStatus.status,
      token_source: tokenSource
    }, 200);
  } catch (err) {
    console.error(`${LOG} excepcion:`, err);
    return json({
      error: String(err)
    }, 500);
  }
});
