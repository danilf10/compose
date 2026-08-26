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
    const { form_id, company_id, form_name, default_servicio, save_mapping } = await req.json();
    if (!form_id || !company_id) return json({
      error: "Faltan campos (form_id, company_id)"
    }, 400);
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // 1) Cargar huérfanos pendientes
    const { data: orphans, error: orpErr } = await adminClient.from("meta_orphan_leads").select("*").eq("form_id", form_id).is("resolved_at", null);
    if (orpErr) return json({
      error: orpErr.message
    }, 400);
    if (!orphans || orphans.length === 0) return json({
      error: "No hay huérfanos pendientes para este form"
    }, 404);
    const pageId = orphans[0].page_id;
    const resolvedFormName = form_name || orphans[0].form_name || null;
    // 2) Crear/actualizar mapeo en meta_lead_forms (salvo si save_mapping === false)
    if (save_mapping !== false) {
      const { data: existingMap } = await adminClient.from("meta_lead_forms").select("id, company_id").eq("meta_form_id", form_id).maybeSingle();
      if (existingMap) {
        if (existingMap.company_id !== company_id) {
          return json({
            error: `El form ${form_id} ya está mapeado a otra empresa. Bórralo antes.`
          }, 409);
        }
      } else {
        const { error: mapErr } = await adminClient.from("meta_lead_forms").insert({
          company_id,
          meta_form_id: form_id,
          meta_page_id: pageId,
          form_name: resolvedFormName,
          default_servicio: default_servicio || null,
          active: true
        });
        if (mapErr) return json({
          error: `No pude crear mapping: ${mapErr.message}`
        }, 400);
      }
    }
    // 3) Cargar empresa para aplicar default_assignee y resolver servicio
    const { data: company } = await adminClient.from("companies").select("settings").eq("id", company_id).single();
    const companyServices = company?.settings?.services || [];
    const defaultAssignee = company?.settings?.default_assignee || null;
    const appliedServicio = default_servicio || null;
    // 4) Para cada huérfano: crear lead + sidecar + marcar resolved
    const results = [];
    let migrated = 0;
    for (const o of orphans){
      const { data: insertedLead, error: leadErr } = await adminClient.from("leads").insert({
        company_id,
        nombre: o.nombre || "Sin nombre",
        email: o.email,
        telefono: o.telefono,
        origen: "facebook",
        servicio: appliedServicio,
        servicios: appliedServicio ? [
          appliedServicio
        ] : [],
        estado: "nuevo",
        datos_raw: o.datos_raw || {},
        assigned_to: defaultAssignee
      }).select("id").single();
      if (leadErr) {
        results.push({
          orphan_id: o.id,
          error: leadErr.message
        });
        continue;
      }
      await adminClient.from("lead_meta_facebook").insert({
        lead_id: insertedLead.id,
        company_id,
        meta_lead_id: o.meta_lead_id,
        form_id: o.form_id,
        form_name: o.form_name,
        page_id: o.page_id,
        page_name: o.page_name,
        platform: "fb",
        meta_created_time: o.meta_created_time,
        raw_payload: o.raw_payload || {}
      });
      await adminClient.from("meta_orphan_leads").update({
        resolved_at: new Date().toISOString(),
        resolved_company_id: company_id,
        resolved_lead_id: insertedLead.id
      }).eq("id", o.id);
      results.push({
        orphan_id: o.id,
        lead_id: insertedLead.id
      });
      migrated++;
    }
    // Para evitar que companyServices quede sin usar cuando default_servicio no existe, lo registramos
    if (appliedServicio && !companyServices.includes(appliedServicio) && company?.settings) {
      await adminClient.from("companies").update({
        settings: {
          ...company.settings,
          services: [
            ...companyServices,
            appliedServicio
          ]
        }
      }).eq("id", company_id);
    }
    return json({
      success: true,
      migrated,
      total: orphans.length,
      results
    });
  } catch (err) {
    return json({
      error: String(err)
    }, 500);
  }
});
