// Abre una operación desde la tabla, descarga su PDF interceptando la
// respuesta real que genera el propio clic (nunca reenvía tokens capturados)
// y vuelve a la lista.

// El mismo beneficiario puede aparecer varias veces en pantalla (como
// beneficiario de otra operación, como titular de origen, en referencias,
// etc.), así que contar "ocurrencias" del nombre no alcanza para identificar
// la fila correcta (el orden en pantalla no siempre coincide con el orden de
// la API). En su lugar buscamos, entre todas las coincidencias del nombre,
// la que además tenga el monto de la operación cerca (mismo ancestro), que
// es mucho menos ambiguo.
async function indiceFilaPorMonto(page, beneficiario, monto, timeoutMs = 15000) {

    const inicio = Date.now();

    // Al volver a la lista, la tabla puede tardar en re-renderizar/traer
    // los datos de nuevo (más que el timeout fijo que esperábamos antes).
    // Reintentamos en vez de buscar una sola vez, para no fallar en falso
    // mientras la tabla todavía está cargando.
    while (Date.now() - inicio < timeoutMs) {

        const indice = await page.evaluate(({ beneficiario, monto }) => {

            const candidatos = [...document.querySelectorAll("body *")].filter(
                el => el.childElementCount === 0 && el.textContent.trim() === beneficiario
            );

            for (let i = 0; i < candidatos.length; i++) {

                let nodo = candidatos[i];

                for (let subida = 0; subida < 8 && nodo; subida++) {

                    if (nodo.textContent.includes(monto))
                        return i;

                    nodo = nodo.parentElement;
                }
            }

            return -1;

        }, { beneficiario, monto });

        if (indice !== -1)
            return indice;

        await page.waitForTimeout(300);
    }

    return -1;
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

        const candidatos = page.getByText(beneficiario, { exact: true });
        const indice = await indiceFilaPorMonto(page, beneficiario, monto);

        if (indice === -1)
            throw new Error(`No se encontró en pantalla la fila de "${beneficiario}" con monto ${monto}.`);

        const fila = candidatos.nth(indice);

        try {

            await Promise.all([
                heading.waitFor({ state: "visible", timeout: 30000 }),
                fila.click()
            ]);

            await page.waitForTimeout(500);
            return;

        } catch (err) {

            // Diagnóstico extra: si el beneficiario aparece más/menos veces
            // en pantalla de lo esperado, o el clic cayó en un elemento que
            // no navega, esto ayuda a distinguir el caso real.
            const totalCoincidencias = await candidatos.count().catch(() => -1);
            err.message = `No se pudo abrir "${beneficiario}" (índice ${indice}, ${totalCoincidencias} coincidencias en pantalla, intento ${intento}/2). URL actual: ${page.url()}. ${err.message}`;
            ultimoError = err;

            if (intento < 2)
                await page.waitForTimeout(1000);
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
