// App web local para explorar las constancias descargadas y seguir
// alimentando la base día a día. Se sirve con el node del sistema (tiene
// node:sqlite) y abre en el navegador. Sin dependencias externas.
//
//   node src/server.js        -> http://localhost:4599

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const os = require("os");
const { abrir, listar, estadisticas, rutaBaseDatos } = require("./db");
const { carpetaConstancias } = require("./download");
const { correr } = require("./apicli");
const { reorganizar } = require("./reorganizar");
const { connect } = require("./connect");
const { parsearCuadro } = require("./pagos/parse");
const { correrPagos } = require("./pagos/ejecutar");

const PORT = Number(process.env.PORT) || 4599;
const INDEX = path.join(__dirname, "web", "index.html");

let syncEnCurso = false;
// Control compartido de la sincronización en curso (pausa/cancelación).
// La GUI lo muta vía POST /api/sync/control y `correr` lo consulta en sus
// checkpoints. Es null cuando no hay ningún sync corriendo.
let syncControl = null;

// Mismo esquema para el envío de pagos (pestaña Pagos).
let pagosEnCurso = false;
let pagosControl = null;

// Escribe un PDF (base64) a un archivo temporal y devuelve su ruta.
function pdfTemporal(pdfBase64) {
    const limpio = String(pdfBase64 || "").replace(/^data:application\/pdf;base64,/, "");
    const ruta = path.join(os.tmpdir(), `cuadro-${Date.now()}.pdf`);
    fs.writeFileSync(ruta, Buffer.from(limpio, "base64"));
    return ruta;
}

function enviarJson(res, codigo, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
}

function leerBody(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", c => data += c);
        req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    });
}

async function manejar(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const ruta = url.pathname;

    // --- Página principal ---
    if (ruta === "/" || ruta === "/index.html") {
        fs.readFile(INDEX, (err, buf) => {
            if (err) { res.writeHead(500); res.end("No se encontró index.html"); return; }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(buf);
        });
        return;
    }

    // --- Estadísticas ---
    if (ruta === "/api/stats") {
        const db = abrir();
        try { enviarJson(res, 200, estadisticas(db)); } finally { db.close(); }
        return;
    }

    // --- Listado de operaciones ---
    if (ruta === "/api/operaciones") {
        const db = abrir();
        try {
            const filtros = {
                q: url.searchParams.get("q") || "",
                product: url.searchParams.get("product") || "",
                empresa: url.searchParams.get("empresa") || "",
                moneda: url.searchParams.get("moneda") || "",
                pdf_estado: url.searchParams.get("pdf_estado") || "",
                desde: url.searchParams.get("desde") || "",
                hasta: url.searchParams.get("hasta") || "",
                limit: url.searchParams.get("limit") || ""
            };
            enviarJson(res, 200, { operaciones: listar(db, filtros) });
        } finally { db.close(); }
        return;
    }

    // --- PDF de una operación ---
    if (ruta.startsWith("/api/pdf/")) {
        const id = Number(ruta.split("/").pop());
        const db = abrir();
        let archivo = null;
        try {
            const row = db.prepare("SELECT pdf_archivo FROM operaciones WHERE requestId=?").get(id);
            archivo = row && row.pdf_archivo;
        } finally { db.close(); }

        if (!archivo) { res.writeHead(404); res.end("Sin PDF"); return; }
        const rutaPdf = path.join(carpetaConstancias(), archivo);
        fs.readFile(rutaPdf, (err, buf) => {
            if (err) { res.writeHead(404); res.end("Archivo no encontrado"); return; }
            res.writeHead(200, {
                "Content-Type": "application/pdf",
                "Cache-Control": "private, max-age=86400",
                "Content-Disposition": `inline; filename="${encodeURIComponent(archivo)}"`
            });
            res.end(buf);
        });
        return;
    }

    // --- Estáticos (pdf.js vendorizado, etc.) desde src/web/ ---
    if (ruta.startsWith("/vendor/")) {
        const limpio = path.normalize(ruta).replace(/^(\.\.[/\\])+/, "");
        const archivoEstatico = path.join(__dirname, "web", limpio);
        if (!archivoEstatico.startsWith(path.join(__dirname, "web"))) { res.writeHead(403); res.end(); return; }
        fs.readFile(archivoEstatico, (err, buf) => {
            if (err) { res.writeHead(404); res.end("No encontrado"); return; }
            const tipo = archivoEstatico.endsWith(".js") ? "text/javascript" : "application/octet-stream";
            res.writeHead(200, { "Content-Type": tipo, "Cache-Control": "max-age=604800" });
            res.end(buf);
        });
        return;
    }

    // --- Abrir la carpeta de constancias en el explorador de archivos ---
    if (ruta === "/api/abrir-carpeta" && req.method === "POST") {
        const carpeta = carpetaConstancias();
        const abridor = process.platform === "win32" ? "explorer"
            : process.platform === "darwin" ? "open" : "xdg-open";
        try {
            spawn(abridor, [carpeta], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
            enviarJson(res, 200, { ok: true, carpeta });
        } catch (err) {
            enviarJson(res, 500, { ok: false, mensaje: err.message });
        }
        return;
    }

    // --- Reorganizar PDFs ya descargados en subcarpetas por empresa ---
    if (ruta === "/api/reorganizar" && req.method === "POST") {
        try {
            const r = reorganizar(() => {});
            enviarJson(res, 200, { ok: true, ...r });
        } catch (err) {
            enviarJson(res, 500, { ok: false, mensaje: err.message });
        }
        return;
    }

    // --- Abrir/lanzar el navegador del banco (para loguearse) ---
    if (ruta === "/api/abrir" && req.method === "POST") {
        try {
            await connect(() => {});
            enviarJson(res, 200, { ok: true, mensaje: "Navegador abierto. Inicia sesión en el banco." });
        } catch (err) {
            enviarJson(res, 500, { ok: false, mensaje: err.message });
        }
        return;
    }

    // --- Pausar / reanudar / cancelar la sincronización en curso ---
    if (ruta === "/api/sync/control" && req.method === "POST") {
        const body = await leerBody(req);
        if (!syncControl) { enviarJson(res, 409, { error: "No hay sincronización en curso." }); return; }
        if (body.accion === "pausar") syncControl.pausado = true;
        else if (body.accion === "reanudar") syncControl.pausado = false;
        else if (body.accion === "cancelar") { syncControl.cancelado = true; syncControl.pausado = false; }
        else { enviarJson(res, 400, { error: "Acción inválida (pausar|reanudar|cancelar)." }); return; }
        enviarJson(res, 200, { ok: true, pausado: syncControl.pausado, cancelado: syncControl.cancelado });
        return;
    }

    // --- Sincronizar (correr método API) con log en vivo por SSE ---
    if (ruta === "/api/sync" && req.method === "POST") {
        const body = await leerBody(req);
        const { desde, hasta, forzar } = body;

        if (!desde || !hasta) { enviarJson(res, 400, { error: "Faltan fechas desde/hasta (DD-MM-YYYY)." }); return; }
        if (syncEnCurso) { enviarJson(res, 409, { error: "Ya hay una sincronización en curso." }); return; }

        syncEnCurso = true;
        syncControl = { pausado: false, cancelado: false };
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        });
        const emitir = (evento, datos) => res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);

        // Si el cliente cierra la conexión (cierra la pestaña/ventana), cancelamos
        // el sync para no dejarlo corriendo contra un stream muerto.
        req.on("close", () => { if (syncControl) syncControl.cancelado = true; });

        emitir("log", { linea: `Sincronizando ${desde} a ${hasta}...` });

        try {
            const resumen = await correr(desde, hasta, (linea) => emitir("log", { linea }), { forzar: !!forzar, control: syncControl });
            emitir("fin", resumen);
        } catch (err) {
            emitir("error", { mensaje: err.message });
        } finally {
            syncEnCurso = false;
            syncControl = null;
            res.end();
        }
        return;
    }

    // --- Pagos: previsualizar el cuadro (parsea el PDF, sin tocar el banco) ---
    if (ruta === "/api/pagos/cuadro" && req.method === "POST") {
        const body = await leerBody(req);
        if (!body.pdfBase64) { enviarJson(res, 400, { error: "Falta el PDF (pdfBase64)." }); return; }
        let tmp = null;
        try {
            tmp = pdfTemporal(body.pdfBase64);
            const { filas, saltadas } = parsearCuadro(tmp);
            const db = abrir();
            let estados = {};
            try {
                for (const r of db.prepare("SELECT guia, estado FROM pagos").all()) estados[r.guia] = r.estado;
            } finally { db.close(); }
            const total = filas.reduce((s, f) => s + f.pago, 0);
            enviarJson(res, 200, { filas, saltadas, total, estados });
        } catch (err) {
            enviarJson(res, 500, { error: err.message });
        } finally {
            if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
        }
        return;
    }

    // --- Pagos: pausar / reanudar / cancelar el envío en curso ---
    if (ruta === "/api/pagos/control" && req.method === "POST") {
        const body = await leerBody(req);
        if (!pagosControl) { enviarJson(res, 409, { error: "No hay envío en curso." }); return; }
        if (body.accion === "pausar") pagosControl.pausado = true;
        else if (body.accion === "reanudar") pagosControl.pausado = false;
        else if (body.accion === "cancelar") { pagosControl.cancelado = true; pagosControl.pausado = false; }
        else { enviarJson(res, 400, { error: "Acción inválida." }); return; }
        enviarJson(res, 200, { ok: true, pausado: pagosControl.pausado, cancelado: pagosControl.cancelado });
        return;
    }

    // --- Pagos: enviar a pendiente de firma (SSE con log en vivo) ---
    if (ruta === "/api/pagos/enviar" && req.method === "POST") {
        const body = await leerBody(req);
        if (!body.pdfBase64) { enviarJson(res, 400, { error: "Falta el PDF (pdfBase64)." }); return; }
        if (pagosEnCurso) { enviarJson(res, 409, { error: "Ya hay un envío en curso." }); return; }

        let tmp;
        try { tmp = pdfTemporal(body.pdfBase64); }
        catch (err) { enviarJson(res, 400, { error: "PDF inválido: " + err.message }); return; }

        pagosEnCurso = true;
        pagosControl = { pausado: false, cancelado: false };
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const emitir = (evento, datos) => res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
        req.on("close", () => { if (pagosControl) pagosControl.cancelado = true; });

        try {
            const resumen = await correrPagos(
                { pdfPath: tmp, dryRun: !!body.dryRun, soloGuias: body.soloGuias || null, control: pagosControl },
                (linea) => emitir("log", { linea })
            );
            emitir("fin", resumen);
        } catch (err) {
            emitir("error", { mensaje: err.message });
        } finally {
            pagosEnCurso = false;
            pagosControl = null;
            try { fs.unlinkSync(tmp); } catch {}
            res.end();
        }
        return;
    }

    res.writeHead(404);
    res.end("No encontrado");
}

const server = http.createServer((req, res) => {
    manejar(req, res).catch(err => { try { enviarJson(res, 500, { error: err.message }); } catch {} });
});

server.listen(PORT, () => {
    const uri = `http://localhost:${PORT}`;
    console.log(`Constancias TeleCrédito — GUI en ${uri}`);
    console.log(`Base de datos: ${rutaBaseDatos()}`);
    // Abrir el navegador automáticamente, salvo que lo lance Electron
    // (NO_BROWSER=1), que ya muestra su propia ventana de escritorio.
    if (process.env.NO_BROWSER !== "1") {
        const abridor = process.platform === "win32" ? "start"
            : process.platform === "darwin" ? "open" : "xdg-open";
        try { spawn(abridor, [uri], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref(); } catch {}
    }
});
