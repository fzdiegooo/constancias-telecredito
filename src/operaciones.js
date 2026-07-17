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
async function indiceFilaPorMonto(page, beneficiario, monto) {

    return await page.evaluate(({ beneficiario, monto }) => {

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
}

async function abrirOperacion(page, beneficiario, monto) {

    const candidatos = page.getByText(beneficiario, { exact: true });

    const indice = await indiceFilaPorMonto(page, beneficiario, monto);

    if (indice === -1)
        throw new Error(`No se encontró en pantalla la fila de "${beneficiario}" con monto ${monto}.`);

    const fila = candidatos.nth(indice);

    // Cada tipo de operación (transferencia local, interbancaria, pago de
    // servicios, pago de letras y facturas, etc.) navega a una URL distinta,
    // así que en vez de matchear la URL usamos una señal común a todas: el
    // heading "Detalle de operación" que aparece en cualquier pantalla de detalle.
    try {

        await Promise.all([
            page.getByRole("heading", { name: "Detalle de operación" }).waitFor({ state: "visible", timeout: 30000 }),
            fila.click()
        ]);

    } catch (err) {

        // Diagnóstico extra: si el beneficiario aparece más/menos veces en
        // pantalla de lo esperado, o el clic cayó en un elemento que no
        // navega, esto ayuda a distinguir el caso real.
        const totalCoincidencias = await candidatos.count().catch(() => -1);
        err.message = `No se pudo abrir "${beneficiario}" (índice ${indice}, ${totalCoincidencias} coincidencias en pantalla). URL actual: ${page.url()}. ${err.message}`;
        throw err;
    }

    await page.waitForTimeout(500);
}

async function descargarPdfOperacion(page) {

    // La SPA muestra un spinner "Cargando" mientras trae el detalle. Si no
    // esperamos a que desaparezca, podemos terminar capturando ese spinner
    // (page.pdf) o revisando la visibilidad del botón antes de que exista.
    await page.getByText("Cargando", { exact: true })
        .waitFor({ state: "hidden", timeout: 20000 })
        .catch(() => {});

    const botonPdf = page.getByText("Descargar PDF", { exact: true });

    // Espera activa a que aparezca el botón (transferencias) en vez de
    // comprobar su visibilidad al instante, que fallaba si el detalle
    // todavía no había terminado de renderizar.
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
    await page.addStyleTag({
        content: "nav, header, aside, mat-sidenav, mat-toolbar, mat-nav-list { display: none !important; }"
    }).catch(() => {});

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

    // Restauramos "Volver" (lo habíamos ocultado solo para la captura) para
    // que volverALista() pueda seguir clickeándolo con normalidad.
    await volverLink
        .evaluate(el => { el.style.display = ""; })
        .catch(() => {});

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
