// Cliente del método directo por API de TeleCrédito (sin clics en la UI).
// Se conecta al navegador ya logueado (CDP), captura el token real que usa
// el SPA y dispara las peticiones desde el contexto de la página
// (page.evaluate + fetch con credentials:"include"), reusando esos headers.
//
// El JWT dura ~5 min y no se puede refrescar headless, así que lo
// re-capturamos (route-change del SPA) cuando una petición devuelve 401.

const { chromium } = require("playwright-core");

const CDP_URL = "http://127.0.0.1:9222";
const BASE = "https://apisux.ntlc.tlcbcp.com";
const SEARCH_URL = `${BASE}/ux-ntlc-consent-management-v1/channel/ntlc/v1/channel-orders/search`;
const REPORT_URL = (id, type) =>
    `${BASE}/ux-ntlc-transfer-operation-v2/channel/ntlc/v2/transfer-operations/reports/${id}?reportType=CONSULT&transferType=${type}`;

const PRODUCTOS_TRANSFERENCIA = new Set(["TXTHIRDPARTIES", "TXDEFERRED", "TXOWNER"]);

async function conectar() {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find(p => p.url().includes("tlcbcp.com")) || ctx.pages()[0];
    return { browser, page };
}

// Captura los headers (authorization + x-auth-token + app-code + caller-name)
// de la petición real de búsqueda que dispara el propio SPA. Forzamos esa
// petición cambiando de ruta (saldos -> bandeja): el hash-routing solo
// re-dispara el search cuando la ruta cambia de verdad.
async function capturarHeaders(page, timeoutMs = 25000) {
    let headers = null;
    const onReq = (req) => {
        if (req.method() === "POST" && /channel-orders\/search/.test(req.url()))
            headers = req.headers();
    };
    page.on("request", onReq);

    try {
        await page.goto("https://www.tlcbcp.com/#/h/saldos-movimientos/v2").catch(() => {});
        await page.waitForTimeout(1500);
        await page.goto("https://www.tlcbcp.com/#/h/bandeja-consulta").catch(() => {});

        const t0 = Date.now();
        while (!headers && Date.now() - t0 < timeoutMs)
            await new Promise(r => setTimeout(r, 300));
    } finally {
        page.off("request", onReq);
    }

    if (!headers)
        throw new Error("No se pudo capturar el token. ¿Estás logueado en el navegador del banco?");

    return headers;
}

function jwtExpSegundos(headers) {
    try {
        const jwt = (headers["authorization"] || "").split(".")[1];
        const payload = JSON.parse(Buffer.from(jwt, "base64").toString());
        return payload.exp - Math.floor(Date.now() / 1000);
    } catch {
        return null;
    }
}

// Sesión que mantiene los headers y los re-captura cuando hace falta.
async function crearSesion(onEstado = () => {}) {
    const { browser, page } = await conectar();
    let headers = await capturarHeaders(page);

    async function refrescar() {
        onEstado("Refrescando token...");
        headers = await capturarHeaders(page);
    }

    // Ejecuta un fetch dentro de la página. Si da 401, refresca token y reintenta 1 vez.
    async function fetchJson(url, { method = "GET", body = null } = {}) {
        for (let intento = 0; intento < 2; intento++) {
            const res = await page.evaluate(async ({ url, method, body, headers }) => {
                const h = { ...headers };
                delete h["content-length"];
                delete h["host"];
                if (method === "GET") delete h["content-type"];
                const opt = { method, headers: h, credentials: "include" };
                if (body != null) opt.body = JSON.stringify(body);
                const r = await fetch(url, opt);
                const text = await r.text();
                let json; try { json = JSON.parse(text); } catch { json = null; }
                return { status: r.status, json, raw: json ? null : text.slice(0, 300) };
            }, { url, method, body, headers });

            if (res.status === 401 && intento === 0) {
                await refrescar();
                continue;
            }
            return res;
        }
    }

    // Renderiza un HTML a PDF (base64) en una pestaña nueva del mismo contexto,
    // sin tocar la página del banco. Se usa para las constancias de los tipos
    // cuyo PDF se arma en cliente (ver constancia.js).
    async function renderizarPdf(html) {
        const p = await page.context().newPage();
        try {
            await p.setContent(html, { waitUntil: "load" });
            await p.emulateMedia({ media: "screen" });
            const buf = await p.pdf({ format: "A4", printBackground: true,
                margin: { top: "0", bottom: "0", left: "0", right: "0" } });
            return buf.toString("base64");
        } finally {
            await p.close().catch(() => {});
        }
    }

    return {
        page,
        headers: () => headers,
        expSegundos: () => jwtExpSegundos(headers),
        fetchJson,
        refrescar,
        renderizarPdf,
        cerrar: () => browser.close().catch(() => {})
    };
}

// El backend rechaza rangos de más de 32 días (error OB9000). Usamos chunks
// de 31 días (con margen) y fusionamos. Causa real del viejo "los rangos
// grandes fallan": el servidor corta el rango, no solo la paginación de la UI.
const MAX_DIAS_RANGO = 31;

function parseDDMMYYYY(s) {
    const [d, m, a] = s.split("-").map(Number);
    return new Date(a, m - 1, d);
}

function formatDDMMYYYY(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function diasEntre(a, b) {
    return Math.round((b - a) / 86400000);
}

// Parte [desde, hasta] en sub-rangos contiguos de hasta MAX_DIAS_RANGO días.
function dividirRango(fechaDesde, fechaHasta) {
    const desde = parseDDMMYYYY(fechaDesde);
    const hasta = parseDDMMYYYY(fechaHasta);
    const chunks = [];

    let inicio = desde;
    while (inicio <= hasta) {
        const fin = new Date(inicio);
        fin.setDate(fin.getDate() + MAX_DIAS_RANGO - 1);
        if (fin > hasta) fin.setTime(hasta.getTime());
        chunks.push([formatDDMMYYYY(inicio), formatDDMMYYYY(fin)]);
        inicio = new Date(fin);
        inicio.setDate(inicio.getDate() + 1);
    }

    return chunks;
}

// Busca un solo rango (que ya cabe en el límite del backend), paginando la API.
async function buscarChunk(sesion, fechaDesde, fechaHasta, onEstado) {
    const pageSize = 50;

    const pedir = (pageNumber) => sesion.fetchJson(SEARCH_URL, {
        method: "POST",
        body: {
            operationStatus: [], products: [],
            metaData: { pageSize, pageNumber },
            advancedSearch: { dateFrom: fechaDesde, dateTo: fechaHasta, dateFilter: "CREATED", status: "PROCESSED" }
        }
    });

    const primera = await pedir(0);
    if (primera.status !== 200 || !primera.json || !primera.json.metadata)
        throw new Error(`La búsqueda falló (status ${primera.status}). ${primera.raw || JSON.stringify(primera.json)}`);

    const totalPages = primera.json.metadata.totalPages || 1;
    let ops = primera.json.operations || [];

    for (let p = 1; p < totalPages; p++) {
        onEstado(`  página ${p + 1}/${totalPages}...`);
        const r = await pedir(p);
        if (r.status === 200 && r.json && r.json.operations)
            ops = ops.concat(r.json.operations);
    }

    return ops;
}

// Trae TODAS las operaciones del rango. Divide automáticamente en chunks de
// <=31 días (límite del backend) y fusiona deduplicando por requestId.
async function buscarTodas(sesion, fechaDesde, fechaHasta, onEstado = () => {}) {
    const chunks = dividirRango(fechaDesde, fechaHasta);

    if (chunks.length > 1)
        onEstado(`Rango de ${diasEntre(parseDDMMYYYY(fechaDesde), parseDDMMYYYY(fechaHasta)) + 1} días > límite del banco (32): se divide en ${chunks.length} tramos.`);

    const porId = new Map();

    for (const [d1, d2] of chunks) {
        if (chunks.length > 1) onEstado(`Tramo ${d1} a ${d2}...`);
        const ops = await buscarChunk(sesion, d1, d2, onEstado);
        for (const op of ops) porId.set(op.requestId, op);
    }

    return [...porId.values()];
}

// Descarga el PDF (base64) de una operación de transferencia.
async function descargarPdfTransferencia(sesion, requestId, product) {
    const res = await sesion.fetchJson(REPORT_URL(requestId, product));
    if (res.status !== 200 || !res.json || typeof res.json.data !== "string")
        throw new Error(`No se pudo bajar el PDF (status ${res.status}). ${res.raw || JSON.stringify(res.json)}`);
    return res.json.data; // base64
}

const MP_BASE = `${BASE}/ux-ntlc-massive-payment-overview-v1/channel/ntlc/v1/massive-payment-overview`;

// Descarga el PDF (base64) de una operación de haberes (MP_SALARIES).
// Flujo de 3 pasos: initiate -> download-authorization -> GET de la URL
// firmada (Azure Blob, SAS válida ~10 min) que devuelve el archivo.
// exportationType "P" = PDF de la operación, "D" = voucher .xls de detalle.
async function descargarArchivoHaberes(sesion, requestId, exportationType = "P") {
    const ini = await sesion.fetchJson(`${MP_BASE}/payroll-orders/initiate`, {
        method: "POST",
        body: { exportationType, startDate: null, endDate: null, requestId }
    });
    if (ini.status !== 200 || !ini.json || !ini.json.fileName)
        throw new Error(`Haberes initiate falló (status ${ini.status}). ${ini.raw || JSON.stringify(ini.json)}`);

    const dl = await sesion.fetchJson(`${MP_BASE}/payroll-files/download-authorization`, {
        method: "POST",
        body: { fileName: ini.json.fileName }
    });
    if (dl.status !== 200 || !dl.json || !dl.json.urlToken)
        throw new Error(`Haberes download-authorization falló (status ${dl.status}). ${dl.raw || JSON.stringify(dl.json)}`);

    // La URL firmada es pública (SAS), se baja desde el contexto de la página.
    const archivo = await sesion.page.evaluate(async (url) => {
        const res = await fetch(url);
        if (!res.ok) return { status: res.status, data: null };
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return { status: res.status, data: btoa(bin) };
    }, dl.json.urlToken);

    if (!archivo || archivo.status !== 200 || !archivo.data)
        throw new Error(`No se pudo descargar la URL firmada de haberes (status ${archivo && archivo.status}).`);

    return { base64: archivo.data, fileName: ini.json.fileName };
}

// Trae el detalle JSON de una operación según su tipo (para guardar datos ricos
// de los tipos cuyo PDF se arma en cliente). Devuelve null si no hay detalle.
async function obtenerDetalle(sesion, product, id) {
    let url = null;
    if (product === "SERVICES_PAYMENT")
        url = `${BASE}/ux-ntlc-payment-service-v2/channel/ntlc/v2/payment-services/payment-transaction-requests/${id}`;
    else if (product === "PAYMENT_DOCUMENTS")
        url = `${BASE}/ux-ntlc-negotiable-document-payment-v1/channel/ntlc/v1/negotiable-document-payments/payments-operations/${id}?typeSearch=approval`;

    if (!url) return null;

    const res = await sesion.fetchJson(url);
    return res.status === 200 ? res.json : null;
}

function esTransferencia(product) {
    return PRODUCTOS_TRANSFERENCIA.has(product);
}

module.exports = {
    crearSesion,
    buscarTodas,
    descargarPdfTransferencia,
    descargarArchivoHaberes,
    obtenerDetalle,
    esTransferencia,
    PRODUCTOS_TRANSFERENCIA
};
