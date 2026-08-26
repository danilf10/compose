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
    const { meta_page_id, operations } = await req.json();
    if (!meta_page_id || !Array.isArray(operations)) return json({
      error: "Faltan meta_page_id u operations"
    }, 400);
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const results = [];
    for (const op of operations){
      try {
        if (op.action === "map") {
          if (!op.company_id) {
            results.push({
              form_id: op.form_id,
              action: op.action,
              ok: false,
              error: "Falta company_id"
            });
            continue;
          }
          const { data: existing } = await adminClient.from("meta_lead_forms").select("id").eq("meta_form_id", op.form_id).maybeSingle();
          if (existing) {
            const { error } = await adminClient.from("meta_lead_forms").update({
              company_id: op.company_id,
              meta_page_id,
              form_name: op.form_name || null,
              default_servicio: op.default_servicio || null,
              active: true,
              excluded: false
            }).eq("id", existing.id);
            if (error) {
              results.push({
                form_id: op.form_id,
                action: op.action,
                ok: false,
                error: error.message
              });
              continue;
            }
          } else {
            const { error } = await adminClient.from("meta_lead_forms").insert({
              company_id: op.company_id,
              meta_form_id: op.form_id,
              meta_page_id,
              form_name: op.form_name || null,
              default_servicio: op.default_servicio || null,
              active: true,
              excluded: false
            });
            if (error) {
              results.push({
                form_id: op.form_id,
                action: op.action,
                ok: false,
                error: error.message
              });
              continue;
            }
          }
          results.push({
            form_id: op.form_id,
            action: op.action,
            ok: true
          });
        } else if (op.action === "exclude") {
          const { data: existing } = await adminClient.from("meta_lead_forms").select("id").eq("meta_form_id", op.form_id).maybeSingle();
          if (existing) {
            const { error } = await adminClient.from("meta_lead_forms").update({
              excluded: true,
              active: false,
              form_name: op.form_name || null
            }).eq("id", existing.id);
            if (error) {
              results.push({
                form_id: op.form_id,
                action: op.action,
                ok: false,
                error: error.message
              });
              continue;
            }
          } else {
            const { error } = await adminClient.from("meta_lead_forms").insert({
              meta_form_id: op.form_id,
              meta_page_id,
              form_name: op.form_name || null,
              excluded: true,
              active: false,
              company_id: null
            });
            if (error) {
              results.push({
                form_id: op.form_id,
                action: op.action,
                ok: false,
                error: error.message
              });
              continue;
            }
          }
          results.push({
            form_id: op.form_id,
            action: op.action,
            ok: true
          });
        } else if (op.action === "unmap") {
          const { error } = await adminClient.from("meta_lead_forms").delete().eq("meta_form_id", op.form_id);
          if (error) {
            results.push({
              form_id: op.form_id,
              action: op.action,
              ok: false,
              error: error.message
            });
            continue;
          }
          results.push({
            form_id: op.form_id,
            action: op.action,
            ok: true
          });
        } else {
          results.push({
            form_id: op.form_id,
            action: String(op.action),
            ok: false,
            error: "acción desconocida"
          });
        }
      } catch (err) {
        results.push({
          form_id: op.form_id,
          action: op.action,
          ok: false,
          error: String(err)
        });
      }
    }
    const ok = results.filter((r)=>r.ok).length;
    const failed = results.length - ok;
    return json({
      success: true,
      ok,
      failed,
      results
    });
  } catch (err) {
    return json({
      error: String(err)
    }, 500);
  }
});
