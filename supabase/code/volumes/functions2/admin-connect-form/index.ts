import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
    const { company_id, meta_form_id, meta_page_id, form_name, default_servicio } = await req.json();
    if (!company_id || !meta_form_id || !meta_page_id) {
      return json({
        error: "Faltan campos (company_id, meta_form_id, meta_page_id)"
      }, 400);
    }
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: existing } = await adminClient.from("meta_lead_forms").select("id, company_id").eq("meta_form_id", meta_form_id).maybeSingle();
    if (existing) {
      return json({
        error: `El form ${meta_form_id} ya está mapeado a otra empresa. Bórralo primero si quieres reasignarlo.`
      }, 409);
    }
    const { error: insErr, data: inserted } = await adminClient.from("meta_lead_forms").insert({
      company_id,
      meta_form_id,
      meta_page_id,
      form_name: form_name || null,
      default_servicio: default_servicio || null,
      active: true
    }).select("id").single();
    if (insErr) return json({
      error: insErr.message
    }, 400);
    return json({
      success: true,
      id: inserted.id
    });
  } catch (err) {
    return json({
      error: String(err)
    }, 500);
  }
});
