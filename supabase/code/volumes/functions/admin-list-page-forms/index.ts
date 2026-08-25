import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GRAPH_API = "https://graph.facebook.com/v21.0";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method !== "POST") return json({
    error: "Method not allowed"
  }, 405);
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({
      error: "No autorizado"
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return json({
      error: "No autorizado"
    }, 401);
    const { data: profile } = await callerClient.from("profiles").select("role").eq("id", caller.id).single();
    if (profile?.role !== "superadmin") return json({
      error: "Acceso denegado"
    }, 403);
    const { meta_page_id } = await req.json();
    if (!meta_page_id) return json({
      error: "Falta meta_page_id"
    }, 400);
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: pageDecrypted, error: pageErr } = await adminClient.from("meta_pages_decrypted").select("page_access_token, page_name").eq("meta_page_id", meta_page_id).maybeSingle();
    if (pageErr) return json({
      error: pageErr.message
    }, 400);
    if (!pageDecrypted?.page_access_token) return json({
      error: "La página no tiene token o no está conectada"
    }, 404);
    // Fetch paginado de forms desde Graph API
    const forms = [];
    let url = `${GRAPH_API}/${meta_page_id}/leadgen_forms?fields=id,name,status,leads_count,locale,created_time&limit=100&access_token=${pageDecrypted.page_access_token}`;
    let attempts = 0;
    while(url && attempts < 10){
      const res = await fetch(url);
      if (!res.ok) {
        const errText = await res.text();
        return json({
          error: `Graph API error: ${errText}`
        }, 502);
      }
      const data = await res.json();
      if (Array.isArray(data.data)) forms.push(...data.data);
      url = data.paging?.next || null;
      attempts++;
    }
    // Estado de mapeo local
    const { data: mapped } = await adminClient.from("meta_lead_forms").select("id, meta_form_id, company_id, form_name, default_servicio, active, excluded, companies(name)").eq("meta_page_id", meta_page_id);
    const byId = new Map();
    for (const m of mapped || [])byId.set(m.meta_form_id, m);
    const enriched = forms.map((f)=>{
      const local = byId.get(f.id);
      let state = "pending";
      if (local?.excluded) state = "excluded";
      else if (local && local.company_id && local.active) state = "mapped";
      else if (local && !local.active) state = "inactive";
      return {
        form_id: f.id,
        form_name: f.name,
        status: f.status,
        leads_count: f.leads_count,
        locale: f.locale,
        created_time: f.created_time,
        state,
        mapping_id: local?.id || null,
        company_id: local?.company_id || null,
        company_name: local?.companies?.name || null,
        default_servicio: local?.default_servicio || null
      };
    });
    return json({
      success: true,
      page_name: pageDecrypted.page_name,
      forms: enriched
    });
  } catch (err) {
    return json({
      error: String(err)
    }, 500);
  }
});
