# =============================================================================
# LeadMap CRM — frontend
# =============================================================================
# Sustituye al despliegue de Vercel: compila con Vite y sirve el resultado con
# nginx, replicando las cabeceras de seguridad y el rewrite de SPA que definia
# vercel.json.
#
# La configuracion (URL de Supabase y clave anon) NO viaja como build-arg: esta
# en .env.production, que Vite lee automaticamente durante `npm run build`. Por
# eso este Dockerfile funciona igual en Easypanel, en local o en cualquier otro
# sitio, sin tener que configurar nada en el panel.
# =============================================================================

# --- Etapa 1: build ----------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Capa de dependencias cacheable: solo se reinstala si cambian los manifiestos
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Compilacion con verificacion.
#
# El fallo que se quiere evitar es silencioso: si .env.production falta o llega
# vacio, Vite compila igual y publica una aplicacion que no puede conectar con
# nada. El navegador solo muestra una pantalla en blanco. Aqui se comprueba que
# la URL existe ANTES de compilar y que ha quedado realmente incrustada en el
# bundle DESPUES, que es la unica prueba de que la configuracion ha surtido
# efecto.
RUN set -e; \
    test -f .env.production || { \
        echo "ERROR: falta .env.production con VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY"; \
        exit 1; \
    }; \
    URL=$(grep -E '^VITE_SUPABASE_URL=' .env.production | cut -d= -f2- | tr -d '\r'); \
    KEY=$(grep -E '^VITE_SUPABASE_ANON_KEY=' .env.production | cut -d= -f2- | tr -d '\r'); \
    test -n "$URL" || { echo "ERROR: VITE_SUPABASE_URL vacio en .env.production"; exit 1; }; \
    test -n "$KEY" || { echo "ERROR: VITE_SUPABASE_ANON_KEY vacio en .env.production"; exit 1; }; \
    echo "Compilando contra $URL"; \
    npm run build; \
    grep -rqF "$URL" dist/assets/ || { \
        echo "ERROR: la URL de Supabase no quedo incrustada en el bundle."; \
        echo "Revisa que .env.production este en la raiz y no lo excluya .dockerignore."; \
        exit 1; \
    }; \
    echo "OK: configuracion incrustada en el bundle"

# --- Etapa 2: servir ---------------------------------------------------------
FROM nginx:1.27-alpine

RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/leadmap.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
