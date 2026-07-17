// Maneja el modal de expiración de sesión que el portal muestra por inactividad
// ("Tu sesión está por expirar" / "Continuar en sesión"). Debe llamarse
// periódicamente durante cualquier proceso largo para no perder la sesión.

async function mantenerSesion(page) {

    const continuar = page.getByText("Continuar en sesión", { exact: true });

    if (await continuar.isVisible().catch(() => false)) {

        await continuar.click();
        await page.waitForTimeout(500);

        console.log("(sesión extendida)");
    }
}

module.exports = { mantenerSesion };
