// Avisa por correo de una sugerencia o un error que ha mandado un cliente.
//
// La sugerencia ya esta guardada en la tabla cuando se llama aqui: esta funcion
// solo manda el aviso. Se hace en este orden a proposito, porque un correo que
// no sale se puede reintentar mirando la tabla, pero una sugerencia que solo
// existio dentro de un correo perdido no se recupera.
//
// Los datos del SMTP viven cifrados en app_secrets, no en el codigo ni en el
// entorno: cambiarlos no obliga a redesplegar.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey"
};
// Por encima de esto no se adjunta el fichero al correo: se manda el enlace.
// Muchos servidores rechazan correos de mas de 10 MB y se perderia el aviso
// entero por una captura grande.
const MAX_ADJUNTO_CORREO = 5 * 1024 * 1024;
const DIAS_ENLACE = 30;

function respuesta(cuerpo, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
async function getSecret(supabase, key) {
  const { data } = await supabase.rpc("get_secret", {
    secret_key: key
  });
  return data || "";
}
function escapar(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method !== "POST") return respuesta({
    error: "Method not allowed"
  }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  // Quien llama tiene que ser un usuario con sesion. Sin esto cualquiera con la
  // clave publica podria disparar correos a nuestro buzon.
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return respuesta({
    error: "No autorizado"
  }, 401);
  let sugerencia_id;
  try {
    ({ sugerencia_id } = await req.json());
  } catch  {
    return respuesta({
      error: "Cuerpo invalido"
    }, 400);
  }
  if (!sugerencia_id) return respuesta({
    error: "Falta sugerencia_id"
  }, 400);
  // Se lee de la tabla, no del cuerpo de la peticion: asi lo que se envia por
  // correo es exactamente lo que quedo guardado, y nadie puede colar en el
  // correo un texto distinto del que se registro.
  const { data: s, error: errSug } = await supabase.from("sugerencias").select("*, companies(name)").eq("id", sugerencia_id).single();
  if (errSug || !s) return respuesta({
    error: "Sugerencia no encontrada"
  }, 404);
  if (s.created_by !== user.id) return respuesta({
    error: "No autorizado"
  }, 403);
  if (s.email_enviado) return respuesta({
    ok: true,
    ya_enviado: true
  });
  const host = await getSecret(supabase, "SMTP_HOST");
  const puerto = parseInt(await getSecret(supabase, "SMTP_PORT") || "465", 10);
  const usuario = await getSecret(supabase, "SMTP_USER");
  const clave = await getSecret(supabase, "SMTP_PASS");
  const desde = await getSecret(supabase, "SMTP_FROM") || usuario;
  const para = await getSecret(supabase, "SUGERENCIAS_TO");
  if (!host || !usuario || !clave || !para) {
    const falta = [
      !host && "SMTP_HOST",
      !usuario && "SMTP_USER",
      !clave && "SMTP_PASS",
      !para && "SUGERENCIAS_TO"
    ].filter(Boolean).join(", ");
    await supabase.from("sugerencias").update({
      email_error: `Sin configurar: ${falta}`
    }).eq("id", sugerencia_id);
    // 200 a proposito: la sugerencia se ha guardado, que es lo que le importa
    // al cliente. Lo que falta es configuracion nuestra, no un error suyo.
    return respuesta({
      ok: true,
      email: false,
      motivo: `Faltan datos del correo: ${falta}`
    });
  }
  // ── el adjunto ────────────────────────────────────────────────────────────
  const adjuntos = [];
  let enlace = null;
  if (s.adjunto_path) {
    try {
      const { data: firmado } = await supabase.storage.from("sugerencias").createSignedUrl(s.adjunto_path, DIAS_ENLACE * 24 * 3600);
      enlace = firmado?.signedUrl || null;
      const { data: fichero } = await supabase.storage.from("sugerencias").download(s.adjunto_path);
      if (fichero && fichero.size <= MAX_ADJUNTO_CORREO) {
        adjuntos.push({
          filename: s.adjunto_nombre || s.adjunto_path.split("/").pop(),
          content: new Uint8Array(await fichero.arrayBuffer()),
          encoding: "binary",
          contentType: fichero.type || "application/octet-stream"
        });
      }
    } catch (e) {
      console.error("adjunto:", e?.message);
    }
  }
  // ── el correo ─────────────────────────────────────────────────────────────
  const esError = s.tipo === "error";
  const empresa = s.companies?.name || "empresa desconocida";
  const asunto = `[AnaliCRM] ${esError ? "Error" : "Sugerencia"} · ${empresa}`;
  const fecha = new Date(s.created_at).toLocaleString("es-ES", {
    timeZone: "Europe/Madrid"
  });
  const texto = [
    `${esError ? "ERROR" : "SUGERENCIA"}`,
    ``,
    `Empresa:  ${empresa}`,
    `Quien:    ${s.autor_nombre || "-"} <${s.autor_email || "-"}>`,
    `Fecha:    ${fecha}`,
    ``,
    s.mensaje,
    ``,
    s.adjunto_nombre ? `Adjunto: ${s.adjunto_nombre}` : `Sin adjunto`,
    enlace ? `Enlace (${DIAS_ENLACE} dias): ${enlace}` : ``,
    ``,
    `id: ${s.id}`
  ].filter((l)=>l !== null).join("\n");
  const color = esError ? "#dc2626" : "#f97316";
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#18181b">
  <div style="border-left:4px solid ${color};padding:4px 0 4px 14px;margin-bottom:20px">
    <div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${color};font-weight:700">${esError ? "Error" : "Sugerencia"}</div>
    <div style="font-size:21px;font-weight:700;margin-top:2px">${escapar(empresa)}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
    <tr><td style="padding:6px 0;color:#71717a;width:90px">Quién</td><td style="padding:6px 0">${escapar(s.autor_nombre || "-")} &lt;${escapar(s.autor_email || "-")}&gt;</td></tr>
    <tr><td style="padding:6px 0;color:#71717a">Fecha</td><td style="padding:6px 0">${escapar(fecha)}</td></tr>
  </table>
  <div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:12px;padding:16px;font-size:15px;line-height:1.65;white-space:pre-wrap">${escapar(s.mensaje)}</div>
  ${enlace ? `<p style="font-size:13px;margin-top:18px">Adjunto: <a href="${escapar(enlace)}" style="color:${color};font-weight:600">${escapar(s.adjunto_nombre || "ver fichero")}</a> <span style="color:#a1a1aa">(el enlace caduca en ${DIAS_ENLACE} días)</span></p>` : ""}
  <p style="font-size:11px;color:#a1a1aa;margin-top:26px;border-top:1px solid #e4e4e7;padding-top:12px">AnaliCRM · id ${escapar(s.id)}</p>
</div>`;
  try {
    const cliente = new SMTPClient({
      connection: {
        hostname: host,
        port: puerto,
        // 465 va cifrado desde el principio; 587 empieza en claro y sube a TLS.
        tls: puerto === 465,
        auth: {
          username: usuario,
          password: clave
        }
      }
    });
    await cliente.send({
      from: desde,
      to: para,
      replyTo: s.autor_email || undefined,
      subject: asunto,
      content: texto,
      html,
      attachments: adjuntos
    });
    await cliente.close();
  } catch (e) {
    const motivo = String(e?.message || e).slice(0, 300);
    console.error("smtp:", motivo);
    await supabase.from("sugerencias").update({
      email_error: motivo
    }).eq("id", sugerencia_id);
    return respuesta({
      ok: true,
      email: false,
      motivo
    });
  }
  await supabase.from("sugerencias").update({
    email_enviado: true,
    email_error: null
  }).eq("id", sugerencia_id);
  return respuesta({
    ok: true,
    email: true
  });
});
