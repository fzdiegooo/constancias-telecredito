import re
import time
import ctypes
from dataclasses import dataclass
from tkinter import Tk, filedialog, messagebox
import pdfplumber
from playwright.sync_api import sync_playwright

# TELECREDITO V21.9 - BOTONES FIJOS CON COORDENADAS REALES DE WINDOWS
# Lee el CUADRO DE PAGOS y prepara SOLO filas con cuenta BCP valida.
# Seguridad: NO confirma / autoriza / envia el pago final.

# ====== MODO PRUEBA ======
# True  = llena cuenta, monto y referencia, pero NO pulsa Continuar ni "Enviar a pendiente de firma".
#         Se detiene en cada pago para que revises el formulario y pulses ENTER para pasar al siguiente.
# False = flujo completo (crea las operaciones pendientes de firma).
MODO_PRUEBA = True

@dataclass
class Pago:
    gi: str
    nombre: str
    cuenta: str
    monto: float

def elegir_pdf():
    r = Tk()
    r.withdraw()
    f = filedialog.askopenfilename(
        title="Selecciona CUADRO DE PAGOS",
        filetypes=[("PDF", "*.pdf")]
    )
    r.destroy()
    return f

def normalizar_cuenta(x):
    x = (x or "").strip()
    # Mantener solo digitos y guiones
    return re.sub(r"[^0-9-]", "", x)

def extraer_pagos(pdf):
    pagos = []
    with pdfplumber.open(pdf) as doc:
        texto = "\n".join((p.extract_text(x_tolerance=2, y_tolerance=3) or "") for p in doc.pages)

    for linea in texto.splitlines():
        linea = " ".join(linea.split())

        # Ejemplo real:
        # 001-004001 14/07/2026 1072 MALLMA... Jengibre 401-... S/. 2,283.50 S/. - S/. 2,283.50
        # También tolera GRR pegado al nombre: 1072MALLMA...
        m = re.match(
            r"001-(\d{6})\s+\d{2}/\d{2}/\d{4}\s+((?:[A-Z]{1,4}\d{0,3}-)?\d{3,13})\s*(.+)$",
            linea
        )
        if not m:
            continue

        gi = str(int(m.group(1)))
        resto = m.group(3).strip()

        prod = re.search(r"\b(Jengibre|Curcuma|Cúrcuma|Naranja)\b", resto, re.I)
        if not prod:
            print(f"[OMITIDO] GI {gi}: no pude ubicar producto.")
            continue

        nombre = resto[:prod.start()].strip()
        despues = resto[prod.end():].strip()

        # Cuenta BCP: tolerar distintas longitudes entre guiones.
        cm = re.search(r"([0-9]{3}-[0-9]{7,9}-[0-9]-[0-9]{2})\s+(.*)$", despues)
        if not cm:
            # Las filas con cuenta 0 se omiten intencionalmente.
            print(f"[OMITIDO] GI {gi}: sin cuenta BCP válida.")
            continue

        cuenta = normalizar_cuenta(cm.group(1))
        resto_importes = cm.group(2)

        # En el PDF aparecen TOTAL, ADELANTO y PAGO.
        importes = re.findall(r"(-?)S/\.\s*(?:([0-9][0-9,]*\.\d{2})|(-))", resto_importes)
        valores = []
        for neg, numero, guion in importes:
            if guion:
                valores.append(None)
            else:
                v = float(numero.replace(",", ""))
                valores.append(-v if neg else v)

        if len(valores) < 3:
            print(f"[OMITIDO] GI {gi}: no pude leer TOTAL/ADELANTO/PAGO.")
            continue

        total = valores[0] or 0.0
        adelanto = valores[1] or 0.0
        monto = valores[2]

        # Validar que el TOTAL sea mayor que el ADELANTO (si no, no hay saldo a pagar)
        if total <= adelanto:
            print(f"[OMITIDO] GI {gi} | {nombre}: ADELANTO (S/ {adelanto:,.2f}) >= TOTAL (S/ {total:,.2f}); no hay saldo a pagar.")
            continue

        # Validar que PAGO = TOTAL - ADELANTO
        if monto is not None and abs((total - adelanto) - monto) > 0.01:
            print(f"[OMITIDO] GI {gi} | {nombre}: PAGO S/ {monto:,.2f} no coincide con TOTAL - ADELANTO (S/ {total - adelanto:,.2f}).")
            continue
        if monto is not None and monto < 0:
            print(f"[OMITIDO] GI {gi}: pago NEGATIVO (adelanto mayor al total): S/ {monto:,.2f}")
            continue
        if monto is None or monto <= 0:
            print(f"[OMITIDO] GI {gi}: pago sin monto.")
            continue

        pagos.append(Pago(gi, nombre, cuenta, monto))
        print(f"[OK] GI {gi} | {nombre} | {cuenta} | S/ {monto:,.2f}")

    return pagos

def esperar_enter(msg):
    input("\n" + msg + "\nPresiona ENTER para continuar...")

def obtener_pagina_bcp(ctx):
    """Prioriza la aplicación Telecrédito sobre la pestaña antigua del login."""
    paginas = [p for p in ctx.pages if not p.is_closed()]
    telecredito = [p for p in paginas if "tlcbcp.com" in p.url.lower()]
    if telecredito:
        return telecredito[-1]
    login = [p for p in paginas if "viabcp.com" in p.url.lower()]
    if login:
        return login[-1]
    return paginas[-1] if paginas else ctx.new_page()

def obtener_buscador(page):
    candidatos = [
        page.get_by_label(re.compile("buscar por nombre", re.I)),
        page.get_by_placeholder(re.compile("buscar", re.I)),
        page.locator('input[type="search"]:visible'),
    ]
    for candidato in candidatos:
        if candidato.count():
            return candidato.first
    return page.get_by_label(re.compile("buscar por nombre", re.I)).first

def solo_digitos(valor):
    return re.sub(r"\D", "", valor or "")

def clic_mouse_real_windows(page, x_viewport, y_viewport):
    """Convierte coordenadas del contenido a pantalla y hace clic físico real."""
    geometria = page.evaluate("""() => ({
        screenX: window.screenX,
        screenY: window.screenY,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
    })""")
    borde_x = (geometria["outerWidth"] - geometria["innerWidth"]) / 2
    barra_superior = geometria["outerHeight"] - geometria["innerHeight"]
    x_pantalla = round(geometria["screenX"] + borde_x + x_viewport)
    y_pantalla = round(geometria["screenY"] + barra_superior + y_viewport)

    page.bring_to_front()
    time.sleep(1)
    user32 = ctypes.windll.user32
    user32.SetCursorPos(x_pantalla, y_pantalla)
    time.sleep(1)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # botón izquierdo abajo
    time.sleep(0.25)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # botón izquierdo arriba
    return x_pantalla, y_pantalla

def clic_boton_inferior_windows(page, distancia_derecha):
    """Clic físico usando la posición real del botón fijo en pantalla maximizada."""
    page.bring_to_front()
    time.sleep(1.5)
    user32 = ctypes.windll.user32
    ancho_pantalla = user32.GetSystemMetrics(0)
    alto_pantalla = user32.GetSystemMetrics(1)
    x_pantalla = ancho_pantalla - distancia_derecha
    y_pantalla = alto_pantalla - 82
    user32.SetCursorPos(x_pantalla, y_pantalla)
    time.sleep(1)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.30)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    return x_pantalla, y_pantalla

def buscar_fila_por_cuenta(page, buscador, pago):
    consulta = pago.nombre.split()[0]
    cuenta_texto = page.get_by_text(pago.cuenta, exact=False).first

    for intento in range(1, 3):
        print(f"[BUSCANDO {intento}/2] GI {pago.gi}: {consulta}")
        buscador.wait_for(state="visible", timeout=20000)
        buscador.click()
        buscador.fill("")
        buscador.fill(consulta)
        page.keyboard.press("Enter")
        try:
            cuenta_texto.wait_for(state="visible", timeout=30000)
            break
        except Exception:
            if intento == 2:
                return None
            print(f"[RECARGA] GI {pago.gi}: esperando nuevamente la lista...")
            page.reload(wait_until="domcontentloaded")
            time.sleep(6)
            buscador = obtener_buscador(page)

    # La primera estructura superior que contiene también el nombre es la fila visual.
    nombre_mayus = consulta.upper()
    fila = cuenta_texto.locator(
        "xpath=ancestor::*[contains(translate(normalize-space(.), "
        "'abcdefghijklmnopqrstuvwxyzáéíóúñ', "
        "'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ'), "
        f"'{nombre_mayus}')][1]"
    )
    if fila.count() == 0:
        return None
    print(f"[ENCONTRADO] GI {pago.gi}: cuenta {pago.cuenta}")
    return fila

def ir_a_transferencias_frecuentes(page):
    ruta = "https://www.tlcbcp.com/#/h/transferencias/v2/dashboard"
    if "/transferencias/v2/dashboard" not in page.url.lower():
        print("[TELECREDITO] Regresando a Transferencias frecuentes...")
        page.goto(ruta, wait_until="domcontentloaded")
    buscador = obtener_buscador(page)
    buscador.wait_for(state="visible", timeout=20000)
    # El buscador aparece antes de que Angular termine de cargar las frecuentes.
    time.sleep(6)
    return buscador

def esperar_confirmacion_y_regresar(page, pago, timeout_segundos=300):
    """Espera la confirmación y vuelve al panel para preparar el siguiente pago."""
    print(
        f"[ESPERANDO] GI {pago.gi}: esperando confirmación de operación pendiente."
    )
    limite = time.time() + timeout_segundos
    pendiente_pulsado = False
    while time.time() < limite:
        if page.is_closed():
            raise RuntimeError("La pestaña de Telecrédito fue cerrada.")
        try:
            url_actual = page.url.lower()
            if "/transferencias/terceros/v2/confirmation" in url_actual:
                print(f"[CONFIRMADO] GI {pago.gi}: operación pendiente de firma detectada.")
                break

            if "/transferencias/terceros/v2/detalle" in url_actual and not pendiente_pulsado:
                enviar = page.get_by_role(
                    "button",
                    name=re.compile(r"enviar\s+a\s+pendiente\s+de\s+firma", re.I)
                ).first
                try:
                    enviar.wait_for(state="visible", timeout=15000)
                    enviar.scroll_into_view_if_needed()
                    caja_enviar = enviar.bounding_box()
                except Exception:
                    caja_enviar = None

                print(f"[MOUSE REAL PENDIENTE] GI {pago.gi}: moviendo al segundo botón...")
                # Botón ancho: centro a unos 166 px del borde derecho.
                x_real, y_real = clic_boton_inferior_windows(page, 166)
                print(
                    f"[CLIC ENVIAR A PENDIENTE] GI {pago.gi}: "
                    f"clic de Windows en ({x_real}, {y_real})."
                )
                pendiente_pulsado = True
        except Exception:
            pass
        page.wait_for_timeout(500)
    else:
        print(f"[AVISO] GI {pago.gi}: no detecté la confirmación en 5 minutos.")
        esperar_enter(
            "Termina este pago manualmente y deja visible la pantalla de confirmación."
        )

    # La página puede terminar una navegación mientras Playwright intenta localizar el botón.
    boton = page.get_by_role(
        "button", name=re.compile(r"ir a transferencias", re.I)
    ).first
    if boton.count() == 0:
        boton = page.get_by_text(
            re.compile(r"^\s*ir a transferencias\s*$", re.I)
        ).first

    try:
        boton.wait_for(state="visible", timeout=15000)
        boton.scroll_into_view_if_needed()
        boton.click()
        print(f"[REGRESO] GI {pago.gi}: clic en Ir a transferencias.")
    except Exception:
        print("[AVISO] No localicé el botón; regresaré por la ruta de Transferencias.")
        page.goto(
            "https://www.tlcbcp.com/#/h/transferencias/v2/dashboard",
            wait_until="domcontentloaded"
        )

    buscador = ir_a_transferencias_frecuentes(page)
    buscador.wait_for(state="visible", timeout=20000)
    print(f"[SIGUIENTE] GI {pago.gi}: Transferencias frecuentes lista.")

def asegurar_titular_fruticola(page):
    esperado = "FRUTICOLA SELVA SAC"

    # Telecrédito dibuja el selector con componentes sin una etiqueta HTML
    # asociada. Validar primero el texto que realmente ve el usuario.
    try:
        texto_pantalla = page.locator("body").inner_text(timeout=10000).upper()
        if esperado in texto_pantalla:
            print(f"[TITULAR OK VISIBLE] {esperado}")
            return True
    except Exception:
        pass

    etiqueta = page.locator("label").filter(
        has_text=re.compile(r"^\s*titular\s*$", re.I)
    ).first

    # Buscar únicamente dentro del control que tiene la etiqueta Titular.
    # Así nunca se confunde con el selector de moneda S/.
    titular = page.get_by_label(re.compile(r"^\s*titular\s*$", re.I)).first
    contenedor = None
    if etiqueta.count():
        contenedor = etiqueta.locator("xpath=..").first
        if titular.count() == 0:
            titular = contenedor.locator(
                '[role="combobox"], button, input'
            ).first

    if titular.count() == 0 or not titular.is_visible():
        print("[SEGURIDAD] No pude identificar el selector Titular.")
        return False

    titular.wait_for(state="visible", timeout=10000)
    texto_actual = (
        (contenedor.inner_text() if contenedor is not None else "")
        or titular.inner_text()
        or titular.get_attribute("value")
        or ""
    ).strip()
    if esperado in texto_actual.upper():
        print(f"[TITULAR OK] {esperado}")
        return True

    print(f"[TITULAR] Cambiando '{texto_actual}' a {esperado}...")
    titular.click()
    opcion = page.get_by_role("option", name=re.compile("FRUTICOLA SELVA", re.I)).first
    if opcion.count() == 0:
        opcion = page.get_by_text(esperado, exact=True).last
    try:
        opcion.wait_for(state="visible", timeout=8000)
        opcion.click()
        time.sleep(1)
    except Exception:
        print(f"[SEGURIDAD] No pude seleccionar {esperado}.")
        return False

    texto_final = (
        (contenedor.inner_text() if contenedor is not None else "")
        or titular.inner_text()
        or titular.get_attribute("value")
        or ""
    ).strip()
    if esperado not in texto_final.upper():
        print(f"[SEGURIDAD] El titular no quedó en {esperado}.")
        return False
    print(f"[TITULAR CORREGIDO] {esperado}")
    return True

def main():
    print("[TELECREDITO] Iniciando V21.9 - botones fijos de Windows...")
    pdf = elegir_pdf()
    if not pdf:
        return

    print(f"[TELECREDITO] PDF seleccionado: {pdf}")
    pagos = extraer_pagos(pdf)
    print(f"\n[TELECREDITO] {len(pagos)} pagos con cuenta BCP encontrados.")

    if not pagos:
        messagebox.showerror("Telecrédito", "No encontré pagos con cuenta BCP válida.")
        return

    # Mostrar resumen antes de tocar Telecredito
    for i, p in enumerate(pagos, 1):
        print(f"{i:02}. GI {p.gi} | {p.nombre} | {p.cuenta} | S/ {p.monto:,.2f}")

    if MODO_PRUEBA:
        messagebox.showinfo(
            "Telecrédito V21.9 - MODO PRUEBA",
            f"Encontré {len(pagos)} pagos BCP.\n\n"
            "Usa el Chrome que abrió el archivo BAT. Inicia sesión MANUALMENTE y entra a Transferencias.\n"
            "MODO PRUEBA: el programa solo llenará cuenta, monto y referencia.\n"
            "NO pulsará Continuar ni 'Enviar a pendiente de firma'. No se crea ninguna operación."
        )
        if not messagebox.askyesno(
            "Confirmar prueba",
            f"Se llenarán los datos de {len(pagos)} pagos para revisión, sin enviar nada.\n\n"
            "¿Deseas comenzar?"
        ):
            return
    else:
        messagebox.showinfo(
            "Telecrédito V21.9",
            f"Encontré {len(pagos)} pagos BCP.\n\n"
            "Usa el Chrome que abrió el archivo BAT. Inicia sesión MANUALMENTE y entra a Transferencias.\n"
            "El programa pulsará Continuar y creará operaciones PENDIENTES DE FIRMA.\n"
            "NO firmará ni autorizará los pagos."
        )
        if not messagebox.askyesno(
            "Confirmar preparación masiva",
            f"Se prepararán {len(pagos)} operaciones pendientes de firma.\n\n"
            "Continuar será automático, pero la firma final seguirá siendo manual.\n\n"
            "¿Deseas comenzar?"
        ):
            return

    with sync_playwright() as pw:
        # El BAT abre Chrome sin --no-sandbox. Playwright solo se conecta a esa ventana.
        try:
            browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9222")
        except Exception:
            messagebox.showerror(
                "Telecrédito V21.9",
                "No pude conectarme al Chrome de Telecrédito.\n\n"
                "Cierra esta ventana y ejecuta EJECUTAR_TELECREDITO_V21_9.bat."
            )
            return

        ctx = browser.contexts[0]
        page = obtener_pagina_bcp(ctx)

        if page.url == "about:blank":
            page.goto("https://www.tlcbcp.com/", wait_until="domcontentloaded")

        esperar_enter(
            "Inicia sesión manualmente. Luego entra a TRANSFERENCIAS y deja visible "
            "la pantalla donde aparece 'Transferencias frecuentes'."
        )

        # El login del BCP puede cerrar la pestaña inicial y abrir otra.
        page = obtener_pagina_bcp(ctx)
        print(f"[TELECREDITO] Pestana activa detectada: {page.url}")

        for n, pago in enumerate(pagos, 1):
            page = obtener_pagina_bcp(ctx)
            print(f"\n[TELECREDITO] Preparando {n}/{len(pagos)}: GI {pago.gi} - {pago.nombre}")

            # Siempre comenzar desde el panel exacto mostrado en el video.
            try:
                buscador = ir_a_transferencias_frecuentes(page)
            except Exception:
                print("[AVISO] No pude abrir Transferencias frecuentes automáticamente.")
                esperar_enter("Entra manualmente a Transferencias y deja visible 'Buscar por nombre'.")
                page = obtener_pagina_bcp(ctx)
                buscador = obtener_buscador(page)

            fila = buscar_fila_por_cuenta(page, buscador, pago)
            if fila is None:
                print(f"[REVISAR] GI {pago.gi}: no localicé automáticamente la cuenta {pago.cuenta}.")
                esperar_enter(
                    f"Se buscó una sola vez '{pago.nombre.split()[0]}'. "
                    f"Revisa MANUALMENTE la cuenta {pago.cuenta}."
                )
                print(f"[OMITIDO TRAS REVISION] GI {pago.gi}: cuenta no encontrada.")
                continue

            # Como en el video: clic en el nombre y luego en Transferir.
            palabra_nombre = pago.nombre.split()[0]
            try:
                nombre_fila = fila.get_by_text(re.compile(re.escape(palabra_nombre), re.I)).first
                nombre_fila.click()
                print(f"[CLIC] GI {pago.gi}: nombre {palabra_nombre}")
            except Exception:
                fila.click(position={"x": 30, "y": 20})
                print(f"[CLIC] GI {pago.gi}: fila del beneficiario")

            # El video muestra que los iconos aparecen al mover el mouse al extremo derecho.
            cuenta_visible = page.get_by_text(pago.cuenta, exact=False).first
            caja = cuenta_visible.bounding_box()
            if not caja:
                print(f"[AVISO] GI {pago.gi}: no pude calcular la altura de la cuenta.")
                esperar_enter("Haz clic MANUALMENTE en Transferir y continúa.")
            else:
                tamano_panel = page.evaluate(
                    "({w: window.innerWidth, h: window.innerHeight})"
                )
                x_transferir = tamano_panel["w"] - 198
                y_detectada = caja["y"] + caja["height"] / 2

                # En algunas cargas Telecrédito conserva un duplicado invisible y
                # devuelve Y=472. La primera fila visible real está cerca del pie.
                if y_detectada < tamano_panel["h"] * 0.60:
                    y_transferir = tamano_panel["h"] - 205
                    print(
                        f"[AJUSTE FILA] GI {pago.gi}: Y detectada={y_detectada:.0f}; "
                        f"usaré Y real={y_transferir:.0f}."
                    )
                else:
                    y_transferir = y_detectada

                print(
                    f"[MOUSE REAL TRANSFERIR] GI {pago.gi}: "
                    f"posición web ({x_transferir:.0f}, {y_transferir:.0f})"
                )
                x_real, y_real = clic_mouse_real_windows(
                    page, x_transferir, y_transferir
                )
                print(
                    f"[CLIC REAL TRANSFERIR] GI {pago.gi}: "
                    f"clic de Windows en ({x_real}, {y_real})."
                )

            # Formulario
            try:
                page.wait_for_url(re.compile(r".*transferencias/terceros/v2/registro.*"), timeout=10000)
            except Exception:
                print(f"[AVISO] GI {pago.gi}: el formulario no se abrió.")
                esperar_enter("Haz clic MANUALMENTE en Transferir. Continúa solo cuando veas el campo Monto.")
                if "/transferencias/terceros/v2/registro" not in page.url.lower():
                    print(f"[OMITIDO] GI {pago.gi}: no se abrió el formulario; no se llenará ningún monto.")
                    continue
            time.sleep(1)

            # Regla obligatoria: nunca preparar el pago con otra empresa de origen.
            if not asegurar_titular_fruticola(page):
                messagebox.showerror(
                    "Titular no verificado",
                    "No pude confirmar FRUTICOLA SELVA SAC como titular.\n\n"
                    "No se llenará el monto de esta transferencia."
                )
                continue

            # Monto: localizar input cercano a S/; fallback por inputs visibles.
            inputs = page.locator("input:visible")
            monto_hecho = False
            for i in range(inputs.count()):
                el = inputs.nth(i)
                ph = (el.get_attribute("placeholder") or "").lower()
                aria = (el.get_attribute("aria-label") or "").lower()
                name = (el.get_attribute("name") or "").lower()
                if any(k in (ph + " " + aria + " " + name) for k in ["monto", "importe"]):
                    el.fill(f"{pago.monto:.2f}")
                    monto_hecho = True
                    break

            # Referencia
            ref = page.get_by_placeholder(re.compile("referencia", re.I))
            if not ref.count():
                ref = page.get_by_label("Referencia", exact=False)
            if ref.count():
                ref.first.fill(f"GI {pago.gi}")
            else:
                ref2 = page.locator('input:visible').filter(has=page.locator("nothing"))
                # fallback JS por texto de label
                page.evaluate("""(v) => {
                    const labels=[...document.querySelectorAll('label')];
                    const l=labels.find(x => /referencia/i.test(x.innerText||''));
                    if(l){
                      const id=l.getAttribute('for');
                      const e=id?document.getElementById(id):l.parentElement.querySelector('input');
                      if(e){e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}
                    }
                }""", f"GI {pago.gi}")

            if not monto_hecho:
                print(f"[AVISO] GI {pago.gi}: no pude identificar el campo monto con seguridad.")
                esperar_enter(f"Escribe MANUALMENTE S/ {pago.monto:.2f} y deja la referencia GI {pago.gi}.")

            print(f"[LISTO] GI {pago.gi}: verificar cuenta={pago.cuenta}, monto=S/ {pago.monto:,.2f}")

            if MODO_PRUEBA:
                print(f"[PRUEBA] GI {pago.gi}: formulario llenado. NO se pulsa Continuar ni Enviar.")
                esperar_enter(
                    f"[PRUEBA] GI {pago.gi} - {pago.nombre}\n"
                    f"Verifica en pantalla: cuenta {pago.cuenta}, monto S/ {pago.monto:,.2f}, referencia GI {pago.gi}.\n"
                    "No se envió nada. Pulsa ENTER para pasar al siguiente pago."
                )
                continue

            # Continuar crea una operación pendiente, pero todavía NO firma el pago.
            print(f"[MOUSE FIJO CONTINUAR] GI {pago.gi}: activando Chrome...")
            # En 1920x1080: aproximadamente X=1805, Y=998.
            x_real, y_real = clic_boton_inferior_windows(page, 115)
            print(
                f"[CLIC FIJO CONTINUAR] GI {pago.gi}: "
                f"clic de Windows en ({x_real}, {y_real})."
            )
            esperar_confirmacion_y_regresar(page, pago)

        print("\n[TELECREDITO] Proceso de preparación terminado.")
        if MODO_PRUEBA:
            messagebox.showinfo(
                "Telecrédito - MODO PRUEBA",
                "Prueba terminada.\nNo se envió ni se creó ninguna operación."
            )
        else:
            messagebox.showinfo(
                "Telecrédito",
                "Preparación terminada.\nLas operaciones quedaron pendientes de firma.\n"
                "El programa no firmó ni autorizó ningún pago."
            )
        # No cerrar Chrome desde el script; el usuario conserva el control de la sesión.

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("\n[ERROR]", repr(e))
        input("Presiona ENTER para cerrar...")
