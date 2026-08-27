import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method !== "POST") return new Response("Method not allowed", {
    status: 405,
    headers: corsHeaders
  });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    // Rate limiting
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    const windowStart = new Date(Date.now() - 60000).toISOString();
    const { count } = await supabase.from("rate_limits").select("*", {
      count: "exact",
      head: true
    }).eq("key", `ai:${ip}`).gte("window_start", windowStart);
    if ((count || 0) >= 30) {
      return new Response(JSON.stringify({
        error: "Rate limit exceeded"
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    await supabase.from("rate_limits").insert({
      key: `ai:${ip}`
    });
    // Get Groq key from encrypted secrets
    const { data: groqKey } = await supabase.rpc("get_secret", {
      secret_key: "GROQ_API_KEY"
    });
    if (!groqKey) return new Response(JSON.stringify({
      error: "AI not configured"
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
    const { messages, lead, company_services, contexto_ia } = await req.json();
    if (lead) {
      const prompt = `Eres un asistente que clasifica leads.\n\n${contexto_ia ? `CONTEXTO: ${contexto_ia}\n\n` : ""}SERVICIOS: ${JSON.stringify(company_services || [])}\n\nDatos del lead: ${JSON.stringify(lead)}\n\nClasifica en el servicio mas apropiado. Responde SOLO con el nombre.`;
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
      if (!res.ok) return new Response(JSON.stringify({
        error: "AI error"
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
      const data = await res.json();
      return new Response(JSON.stringify({
        result: data.choices?.[0]?.message?.content?.trim()
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (messages) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages,
          temperature: 0.3,
          max_tokens: 2000
        })
      });
      if (!res.ok) return new Response(JSON.stringify({
        error: "AI error"
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
      const data = await res.json();
      return new Response(JSON.stringify({
        result: data.choices?.[0]?.message?.content?.trim()
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    return new Response(JSON.stringify({
      error: "Missing data"
    }), {
      status: 400,
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
