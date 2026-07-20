// Abre una operación desde la tabla, descarga su PDF interceptando la
// respuesta real que genera el propio clic (nunca reenvía tokens capturados)
// y vuelve a la lista.

const { mantenerSesion } = require("./sesion");

// El mismo beneficiario puede aparecer varias veces en pantalla (como
// beneficiario de otra operación, como titular de origen, en referencias,
// etc.), así que contar "ocurrencias" del nombre no alcanza para identificar
// la fila correcta (el orden en pantalla no siempre coincide con el orden de
// la API). En su lugar buscamos, entre todas las coincidencias del nombre,
// la que además tenga el monto de la operación cerca (mismo ancestro), que
// es mucho menos ambiguo.
//
// La tabla usa scroll virtual: con 100 filas por página, solo las
// primeras ~25 quedan realmente en el DOM al volver de una operación (la
// lista vuelve con scroll arriba). Las filas 26+ no existen todavía en el
// DOM aunque los datos ya estén cargados, así que buscarlas sin scrollear
// primero siempre falla. Vamos bajando el scroll de a poco en cada
// reintento para ir "despertando" más filas hasta encontrar la buscada.
async function encontrarElementoFila(page, beneficiario, monto, timeoutMs = 15000) {

    const inicio = Date.now();

    while (Date.now() - inicio < timeoutMs) {

        const handle = await page.evaluateHandle(({ beneficiario, monto }) => {
            const normalizar = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
            const bNorm = normalizar(beneficiario);

            const candidatos = [...document.querySelectorAll("body *")].filter(
                el => el.childElementCount === 0 && normalizar(el.textContent) === bNorm
            );

            for (let i = 0; i < candidatos.length; i++) {
                let nodo = candidatos[i];
                for (let subida = 0; subida < 8 && nodo; subida++) {
                    if (nodo.textContent.includes(monto)) {
                        return candidatos[i];
                    }
                    nodo = nodo.parentElement;
                }
            }
            return null;
        }, { beneficiario, monto });

        const elemento = handle.asElement();
        if (elemento) {
            return elemento;
        } else {
            await handle.dispose().catch(() => {});
        }

        await mantenerSesion(page).catch(() => {});

        // Bajamos el scroll en cualquier contenedor scrollable o en la ventana
        // para que el scroll virtual renderice más filas.
        const scrollExitoso = await page.evaluate(() => {
            let check = false;
            const elementos = document.querySelectorAll('*');
            for (const el of elementos) {
                const style = window.getComputedStyle(el);
                const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
                if (isScrollable) {
                    const antes = el.scrollTop;
                    el.scrollTop += el.clientHeight * 0.8;
                    if (el.scrollTop !== antes) {
                        check = true;
                    }
                }
            }
            if (!check) {
                const antes = window.scrollY;
                window.scrollBy(0, window.innerHeight * 0.8);
                check = window.scrollY !== antes;
            }
            return check;
        });

        // Si no se pudo hacer scroll (llegamos al fondo), volvemos al inicio de todo
        if (!scrollExitoso) {
            await page.evaluate(() => {
                window.scrollTo(0, 0);
                const elementos = document.querySelectorAll('*');
                for (const el of elementos) {
                    const style = window.getComputedStyle(el);
                    const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll');
                    if (isScrollable) {
                        el.scrollTop = 0;
                    }
                }
            });
        }

        await page.waitForTimeout(300);
    }

    return null;
}

// Solo se llama cuando encontrarElementoFila ya agotó todos los reintentos y
// devolvió null: junta pistas sobre POR QUÉ no se encontró la fila (¿el
// nombre del beneficiario ni siquiera está en pantalla? ¿está pero con un
// monto distinto al lado? ¿hay algo parecido con otra ortografía/espacios?)
// para que el mensaje de error de la próxima corrida ya traiga la
// respuesta, en vez de tener que reconectarse a mano a revisar el DOM.
async function diagnosticoFilaNoEncontrada(page, beneficiario, monto) {

    return await page.evaluate(({ beneficiario, monto }) => {

        const normalizar = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
        const bNorm = normalizar(beneficiario);

        const exactas = [...document.querySelectorAll("body *")].filter(
            el => el.childElementCount === 0 && normalizar(el.textContent) === bNorm
        );

        const montosCercanos = exactas.map(nodo => {
            let n = nodo;
            for (let subida = 0; subida < 8 && n; subida++) n = n.parentElement;
            return n ? n.textContent.replace(/\s+/g, " ").trim().slice(0, 200) : null;
        });

        const parecidos = [...document.querySelectorAll("body *")]
            .filter(el => el.childElementCount === 0)
            .map(el => el.textContent.trim())
            .filter(t => t && normalizar(t).includes(bNorm.slice(0, 10)))
            .slice(0, 5);

        return {
            coincidenciasExactas: exactas.length,
            textoAncestro8Niveles: montosCercanos,
            parecidos
        };

    }, { beneficiario, monto }).catch(err => ({ error: err.message }));
}

function checkBeneficiarioEnTexto(textoNorm, beneficiario) {
    const normalizar = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
    const bNorm = normalizar(beneficiario);

    if (textoNorm.includes(bNorm))
        return true;

    // Alternativa: ver si al menos una palabra significativa (largo >= 4) coincide
    const palabras = bNorm.split(" ").filter(w => w.length >= 4 && !["sac", "sa", "s.a", "eirl", "s.r.l", "srl"].includes(w));
    if (palabras.length > 0) {
        return palabras.some(w => textoNorm.includes(w));
    }

    // Si es muy corta, comparar sin espacios
    const sinEspacios = (t) => t.replace(/\s+/g, "");
    return sinEspacios(textoNorm).includes(sinEspacios(bNorm));
}

function obtenerVariacionesMonto(montoStr) {
    const rawNumber = Number(montoStr.replace(/,/g, ''));
    if (isNaN(rawNumber)) return [montoStr];

    const integerPart = Math.floor(rawNumber);
    const decimalPart = (rawNumber - integerPart).toFixed(2).slice(2); // e.g. "00"

    const thousandFormats = [
        integerPart.toString(), // 1500
        integerPart.toLocaleString('en-US'), // 1,500
        integerPart.toLocaleString('es-ES'), // 1.500
        integerPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") // 1 500
    ];

    const variaciones = [];
    for (const tf of thousandFormats) {
        variaciones.push(`${tf}.${decimalPart}`);
        variaciones.push(`${tf},${decimalPart}`);
    }

    if (decimalPart === "00") {
        for (const tf of thousandFormats) {
            variaciones.push(tf);
        }
    }

    return [...new Set(variaciones)];
}

async function verificarDetalleOperacion(page, beneficiario, monto, timeoutMs = 8000) {
    const normalizar = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
    const bNorm = normalizar(beneficiario);
    const variacionesMonto = obtenerVariacionesMonto(monto).map(v => normalizar(v));

    const inicio = Date.now();

    while (Date.now() - inicio < timeoutMs) {
        const bodyText = await page.locator("body").textContent().catch(() => "");
        const bodyNorm = normalizar(bodyText);

        const tieneMonto = variacionesMonto.some(v => bodyNorm.includes(v));
        const tieneBeneficiario = checkBeneficiarioEnTexto(bodyNorm, beneficiario);

        if (tieneMonto && tieneBeneficiario) {
            return; // Verificación exitosa
        }

        await page.waitForTimeout(500);
    }

    // Último intento antes de lanzar error
    const bodyText = await page.locator("body").textContent().catch(() => "");
    const bodyNorm = normalizar(bodyText);
    const tieneMonto = variacionesMonto.some(v => bodyNorm.includes(v));
    const tieneBeneficiario = checkBeneficiarioEnTexto(bodyNorm, beneficiario);

    if (!tieneMonto || !tieneBeneficiario) {
        throw new Error(
            `El detalle de la operación no coincide con lo esperado. ` +
            `Esperado: "${beneficiario}" con monto S/ ${monto} (variaciones buscadas: ${JSON.stringify(variacionesMonto)}). ` +
            `Encontrado monto: ${tieneMonto ? "Sí" : "No"}, Encontrado beneficiario: ${tieneBeneficiario ? "Sí" : "No"}`
        );
    }
}

async function abrirOperacion(page, beneficiario, monto) {

    const heading = page.getByRole("heading", { name: "Detalle de operación" });

    // Cada tipo de operación (transferencia local, interbancaria, pago de
    // servicios, pago de letras y facturas, etc.) navega a una URL distinta,
    // así que en vez de matchear la URL usamos una señal común a todas: el
    // heading "Detalle de operación" que aparece en cualquier pantalla de detalle.

    // A veces el clic "resuelve" (Playwright encontró la fila y la clickeó)
    // pero nunca navega -- la fila encontrada era un nodo transitorio/viejo
    // de un momento en que la lista todavía se estaba re-renderizando.
    // Reintentamos re-buscando la fila desde cero en vez de fallar al
    // primer intento, que suele autocorregirse una vez la lista se asienta.
    let ultimoError;

    for (let intento = 1; intento <= 2; intento++) {

        const elemento = await encontrarElementoFila(page, beneficiario, monto);

        if (!elemento) {
            const diag = await diagnosticoFilaNoEncontrada(page, beneficiario, monto);
            throw new Error(
                `No se encontró en pantalla la fila de "${beneficiario}" con monto ${monto}. ` +
                `Diagnóstico: ${JSON.stringify(diag)}`
            );
        }

        try {

            await Promise.all([
                heading.waitFor({ state: "visible", timeout: 30000 }),
                elemento.click()
            ]);

            // Damos un respiro y esperamos a que el spinner desaparezca si es que ya empezó a cargar
            await page.getByText("Cargando", { exact: true })
                .waitFor({ state: "hidden", timeout: 25000 })
                .catch(() => {});

            // Validación defensiva crítica: verificar que realmente se cargó el detalle correcto (con sondeo)
            await verificarDetalleOperacion(page, beneficiario, monto);

            await elemento.dispose().catch(() => {});
            await page.waitForTimeout(500);
            return;

        } catch (err) {

            await elemento.dispose().catch(() => {});

            err.message = `No se pudo abrir "${beneficiario}" con monto ${monto} (intento ${intento}/2). URL actual: ${page.url()}. ${err.message}`;
            ultimoError = err;

            if (intento < 2) {
                // Si quedamos en la pantalla de detalle, regresamos a la lista antes de reintentar
                if (!page.url().includes("bandeja-consulta")) {
                    await volverALista(page).catch(() => {});
                }
                await page.waitForTimeout(1000);
            }
        }
    }

    throw ultimoError;
}

async function descargarPdfOperacion(page) {

    // La SPA muestra un spinner "Cargando" mientras trae el detalle. Si no
    // esperamos a que desaparezca, podemos terminar capturando ese spinner
    // (page.pdf) o revisando la visibilidad del botón antes de que exista.
    await page.getByText("Cargando", { exact: true })
        .waitFor({ state: "hidden", timeout: 20000 })
        .catch(() => {});

    // "Descargar PDF" (transferencias) es el único botón confirmado que
    // dispara una petición real (GET .../reports/{id}?reportType=CONSULT...)
    // devolviendo el PDF en base64 — lo interceptamos como respuesta JSON.
    const botonPdf = page.getByText("Descargar PDF", { exact: true }).first();

    const tienePdf = await botonPdf
        .waitFor({ state: "visible", timeout: 8000 })
        .then(() => true)
        .catch(() => false);

    if (tienePdf) {

        const [response] = await Promise.all([
            page.waitForResponse(res => /report/i.test(res.url())),
            botonPdf.click()
        ]);

        return await response.json();
    }

    // "Descargar detalle" (pago de servicios) NO genera ninguna petición de
    // red al clickearlo (confirmado en el panel de red), así que no puede
    // interceptarse como respuesta HTTP. Es probable que genere el archivo
    // 100% en el cliente y lo entregue vía un enlace/blob "download" — eso
    // no aparece en Network pero sí dispara el evento "download" del
    // navegador, que Playwright puede capturar directamente. Lo intentamos
    // con un timeout corto; si no llega, seguimos con el fallback de
    // impresión de siempre (que ya funcionaba para estos casos).
    const botonDetalle = page.getByText("Descargar detalle", { exact: true }).first();

    const tieneDetalle = await botonDetalle
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);

    if (tieneDetalle) {

        const [descarga] = await Promise.all([
            page.waitForEvent("download", { timeout: 8000 }).catch(() => null),
            botonDetalle.click()
        ]);

        if (descarga) {

            const stream = await descarga.createReadStream();
            const chunks = await new Promise((resolve, reject) => {
                const partes = [];
                stream.on("data", c => partes.push(c));
                stream.on("end", () => resolve(partes));
                stream.on("error", reject);
            });

            return { data: Buffer.concat(chunks).toString("base64"), mime: "application/pdf" };
        }
    }

    // "Pago de servicios"/"Pago de letras y facturas" no exponen un PDF
    // real: el botón de impresión solo abre el diálogo nativo del
    // navegador (Imprimir > Guardar como PDF). Ese diálogo nativo vive
    // fuera del DOM/CDP, así que no hay forma de scriptear ese clic ni de
    // elegir "Guardar" ahí dentro — page.pdf() es el equivalente
    // automatizable de esa misma acción.
    // Por defecto usa el CSS de medio "print" (puede salir en blanco si el
    // sitio no define estilos de impresión propios), así que forzamos
    // medio "screen" para capturar el contenido tal como se ve en pantalla.
    await page.emulateMedia({ media: "screen" });

    // Oculta el menú lateral, el header del banco y los botones de
    // navegación/impresión para que en el PDF solo quede la tarjeta con
    // el detalle de la operación, no todo el chrome de la app.
    // Esta es una SPA (Angular): la lista y el detalle son la MISMA página,
    // solo cambia la ruta. Si no quitamos este <style> después de generar
    // el PDF, queda ocultando esos tags para siempre — incluida la barra de
    // paginación al volver a la lista (vive dentro de uno de esos mismos
    // elementos). Guardamos el handle para poder removerlo más abajo.
    const estiloOculto = await page.addStyleTag({
        content: "nav, header, aside, mat-sidenav, mat-toolbar, mat-nav-list { display: none !important; }"
    }).catch(() => null);

    const volverLink = page.getByText("Volver", { exact: false }).first();

    await volverLink
        .evaluate(el => { el.style.display = "none"; })
        .catch(() => {});

    await page.getByRole("button", { name: "Imprimir" }).first()
        .evaluate(el => { el.style.display = "none"; })
        .catch(() => {});

    // Esta pantalla no tiene un layout responsive/de impresión propio:
    // angostar el viewport rompe el diseño (el texto se apila letra por
    // letra) y usar una hoja A4 con el ancho de escritorio corta contenido.
    // En vez de forzar un tamaño de hoja, generamos el PDF con el ancho y
    // alto reales de la página (tal como se ve en pantalla) en una sola
    // página, sin reflow ni recortes.
    const { ancho, alto } = await page.evaluate(() => ({
        ancho: document.documentElement.scrollWidth,
        alto: document.documentElement.scrollHeight
    }));

    const buffer = await page.pdf({
        width: `${ancho}px`,
        height: `${alto}px`,
        printBackground: true
    });

    // Restauramos "Volver" (lo habíamos ocultado solo para la captura) y
    // quitamos el <style> inyectado, para que la lista (misma página SPA)
    // vuelva a mostrar su chrome normal, incluida la paginación.
    await volverLink
        .evaluate(el => { el.style.display = ""; })
        .catch(() => {});

    if (estiloOculto)
        await estiloOculto.evaluate(el => el.remove()).catch(() => {});

    await page.emulateMedia({ media: null });

    return { data: buffer.toString("base64"), mime: "application/pdf" };
}

async function volverALista(page) {

    await Promise.all([
        page.waitForURL(/bandeja-consulta/),
        page.getByText("Volver", { exact: false }).first().click()
    ]);

    await page.waitForTimeout(500);
}

module.exports = { abrirOperacion, descargarPdfOperacion, volverALista };
