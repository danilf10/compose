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
async function findPageToken(userToken, pageId) {
  let url = `${GRAPH_API}/me/accounts?fields=id,access_token&limit=100&access_token=${userToken}`;
  let attempts = 0;
  while(url && attempts < 10){
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const found = (data.data || []).find((p)=>p.id === pageId);
    if (found?.access_token) return found.access_token;
    url = data.paging?.next;
    attempts++;
  }
  return null;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method !== "POST") return new Response("Method not allowed", {
    status: 405,
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
    const { company_id, meta_page_id, page_name, page_access_token } = await req.json();
    if (!company_id || !meta_page_id || !page_access_token) {
      return new Response(JSON.stringify({
        error: "Faltan campos"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Try to get page token via paginated me/accounts
    let finalPageToken = page_access_token;
    const extracted = await findPageToken(page_access_token, meta_page_id);
    if (extracted) finalPageToken = extracted;
    // Get data_access_expires_at
    let dataAccessExpiresAt = null;
    try {
      const debugRes = await fetch(`${GRAPH_API}/debug_token?input_token=${finalPageToken}&access_token=${finalPageToken}`);
      if (debugRes.ok) {
        const debugData = await debugRes.json();
        const expiresUnix = debugData.data?.data_access_expires_at;
        if (expiresUnix) dataAccessExpiresAt = new Date(expiresUnix * 1000).toISOString();
      }
    } catch  {}
    const { error: dbErr } = await adminClient.rpc("insert_meta_page_encrypted", {
      p_company_id: company_id,
      p_meta_page_id: meta_page_id,
      p_page_name: page_name || null,
      p_token: finalPageToken
    });
    if (dbErr) return new Response(JSON.stringify({
      error: dbErr.message
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
    if (dataAccessExpiresAt) {
      await adminClient.from("meta_pages").update({
        data_access_expires_at: dataAccessExpiresAt
      }).eq("meta_page_id", meta_page_id);
    }
    let subscribed = false;
    let subscribeError = null;
    try {
      const subRes = await fetch(`${GRAPH_API}/${meta_page_id}/subscribed_apps`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          subscribed_fields: "leadgen",
          access_token: finalPageToken
        })
      });
      const subData = await subRes.json();
      if (subData.success) subscribed = true;
      else subscribeError = subData.error?.message || "Error desconocido";
    } catch (err) {
      subscribeError = String(err);
    }
    return new Response(JSON.stringify({
      success: true,
      subscribed,
      subscribeError,
      dataAccessExpiresAt
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
