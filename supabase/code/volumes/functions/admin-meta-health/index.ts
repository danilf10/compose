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
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({
      error: "No autorizado"
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return new Response(JSON.stringify({
      error: "No autorizado"
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
    const { data: profile } = await callerClient.from("profiles").select("role").eq("id", caller.id).single();
    if (profile?.role !== "superadmin") return new Response(JSON.stringify({
      error: "Acceso denegado"
    }), {
      status: 403,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: pages } = await adminClient.from("meta_pages_decrypted").select("*");
    if (!pages) return new Response(JSON.stringify({
      pages: []
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
    const results = await Promise.all(pages.map(async (page)=>{
      const result = {
        page_id: page.meta_page_id,
        page_name: page.page_name,
        company_id: page.company_id,
        active: page.active,
        data_access_expires_at: page.data_access_expires_at
      };
      // Check subscription
      try {
        const subRes = await fetch(`${GRAPH_API}/${page.meta_page_id}/subscribed_apps?access_token=${page.page_access_token}`);
        if (subRes.ok) {
          const subData = await subRes.json();
          const apps = subData.data || [];
          const sub = apps.find((a)=>a.subscribed_fields?.includes("leadgen"));
          result.subscribed = !!sub;
          result.subscribed_app_name = sub?.name || null;
        } else {
          result.subscribed = false;
          result.token_error = (await subRes.json()).error?.message || "Token invalido";
        }
      } catch (err) {
        result.subscribed = false;
        result.token_error = String(err);
      }
      // Token info via debug
      try {
        const dbgRes = await fetch(`${GRAPH_API}/debug_token?input_token=${page.page_access_token}&access_token=${page.page_access_token}`);
        if (dbgRes.ok) {
          const dbgData = await dbgRes.json();
          result.token_valid = dbgData.data?.is_valid;
          result.token_expires_at = dbgData.data?.expires_at ? new Date(dbgData.data.expires_at * 1000).toISOString() : null;
          if (dbgData.data?.data_access_expires_at) {
            result.data_access_expires_at_live = new Date(dbgData.data.data_access_expires_at * 1000).toISOString();
          }
        }
      } catch  {}
      // Last lead
      const { data: lastLead } = await adminClient.from("lead_meta_facebook").select("created_at, lead_id").eq("page_id", page.meta_page_id).order("created_at", {
        ascending: false
      }).limit(1).single();
      result.last_lead_at = lastLead?.created_at || null;
      // Errors last 24h
      const since = new Date(Date.now() - 86400000).toISOString();
      const { count: errors24h } = await adminClient.from("webhook_logs").select("*", {
        count: "exact",
        head: true
      }).eq("meta_page_id", page.meta_page_id).neq("status", "success").gte("created_at", since);
      result.errors_24h = errors24h || 0;
      // Total leads ever
      const { count: totalLeads } = await adminClient.from("lead_meta_facebook").select("*", {
        count: "exact",
        head: true
      }).eq("page_id", page.meta_page_id);
      result.total_leads = totalLeads || 0;
      return result;
    }));
    return new Response(JSON.stringify({
      pages: results
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: String(err)
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
